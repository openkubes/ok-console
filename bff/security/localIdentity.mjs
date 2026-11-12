import { randomBytes, randomUUID, scrypt as derive, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(derive)
const HASH = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }
const READER = ['platform.read', 'clusters.read', 'evidence.read']
const ADMIN = 'local.users.admin'
const INITIALIZE = 'local.users.initialize'
const RECOVER = 'local.users.recover'
export class IdentityError extends Error {
  constructor(status = 503) { super('Local identity request could not be completed.'); this.status = status }
}
export const normalizeUsername = (value) => typeof value === 'string' ? value.normalize('NFKC').trim().toLowerCase() : ''
const validUsername = (value) => /^[a-z][a-z0-9._-]{2,31}$/.test(value)
const validPassword = (value) => typeof value === 'string' && value.length >= 15 && Buffer.byteLength(value) <= 256
const revisionFor = (row) => `local:${row.id}:${row.revision}`
const publicAccount = (row) => ({ id: row.id, username: row.username, enabled: row.enabled, administrator: row.administrator })

export class LocalIdentity {
  constructor({ pool, sessions, throttle, scope, authorizationRevision, recoveryEnabled = false }) {
    Object.assign(this, { pool, sessions, throttle, scope, authorizationRevision, recoveryEnabled })
    this.hashing = 0
  }
  async hash(password, salt) {
    if (this.hashing >= 2) throw new IdentityError()
    this.hashing++
    try { return await scrypt(password, salt, 32, HASH) } finally { this.hashing-- }
  }
  async audit(db, actor, target, action, correlationId) {
    await db.query('INSERT INTO ok_identity.audit(actor_id,target_id,action,correlation_id) VALUES($1,$2,$3,$4)', [actor, target, action, correlationId])
  }
  async transaction(fn) {
    const db = await this.pool.connect()
    let failure
    try {
      await db.query('BEGIN')
      const result = await fn(db)
      await db.query('COMMIT')
      return result
    } catch (error) {
      // Match session-store transactions: evict on failure without queuing a rollback
      // behind a query that may still be running after a client-side timeout.
      failure = error
      if (error instanceof IdentityError) throw error
      throw new IdentityError()
    } finally { db.release(failure) }
  }
  async current(context, db = this.pool) {
    if (context.subject.method !== 'Local') return true
    const result = await db.query('SELECT id,enabled,revision FROM ok_identity.accounts JOIN ok_identity.state ON singleton AND initialized WHERE id=$1', [context.subject.id])
    const row = result.rows[0]
    return !!row?.enabled && revisionFor(row) === context.authorizationRevision
  }
  async actor(db, context, permission = ADMIN) {
    if (!context || context.scope.environmentId !== this.scope.environmentId
      || !context.scope.tenantIds.includes(this.scope.tenantIds[0])
      || !context.permissions.includes(permission)) throw new IdentityError(403)
    if (context.subject.method === 'Local') {
      const result = await db.query('SELECT * FROM ok_identity.accounts WHERE id=$1 FOR UPDATE', [context.subject.id])
      const row = result.rows[0]
      if (!row?.enabled || !row.administrator || revisionFor(row) !== context.authorizationRevision) throw new IdentityError(403)
    } else if (context.subject.method !== 'Bootstrap' || permission === ADMIN
      || context.authorizationRevision !== this.authorizationRevision) throw new IdentityError(403)
  }
  async manage(operation, context, input, correlationId) {
    if (operation === 'recover' && !this.recoveryEnabled) throw new IdentityError(403)
    const permission = operation === 'initialize' ? INITIALIZE : operation === 'recover' ? RECOVER : ADMIN
    // Hash only after authenticating/authorizing the request. Never expose verifier fields.
    return this.transaction(async (db) => {
      // One durable lock serializes last-admin decisions, one-time bootstrap and recovery.
      const lockedState = await db.query('SELECT * FROM ok_identity.state WHERE singleton=true FOR UPDATE')
      if (lockedState.rowCount !== 1) throw new IdentityError()
      if (operation === 'recover' && !lockedState.rows[0].initialized) throw new IdentityError(409)
      await this.actor(db, context, permission)
      if (operation === 'list') {
        const result = await db.query('SELECT id,username,enabled,administrator FROM ok_identity.accounts ORDER BY username LIMIT 1000')
        return { users: result.rows.map(publicAccount) }
      }
      if (operation === 'disable') {
        if (typeof input.id !== 'string' || !/^[0-9a-f-]{36}$/.test(input.id)) throw new IdentityError(400)
        const selected = await db.query('SELECT * FROM ok_identity.accounts WHERE id=$1 FOR UPDATE', [input.id])
        const row = selected.rows[0]
        if (!row) throw new IdentityError(400)
        if (row.enabled && row.administrator) {
          const admins = await db.query('SELECT count(*)::int AS count FROM ok_identity.accounts WHERE administrator AND enabled')
          if (admins.rows[0].count <= 1) throw new IdentityError(409)
        }
        await db.query('UPDATE ok_identity.accounts SET enabled=false,revision=revision+1 WHERE id=$1', [row.id])
        await this.revoke(db, row)
        await this.audit(db, context.subject.id, row.id, 'Disabled', correlationId)
        return { user: { ...publicAccount(row), enabled: false } }
      }
      const username = normalizeUsername(input.username)
      if (!validUsername(username) || !validPassword(input.password)) throw new IdentityError(400)
      if (operation === 'initialize') {
        const state = await db.query('SELECT initialized FROM ok_identity.state WHERE singleton=true')
        if (context.subject.method !== 'Bootstrap' || state.rows[0]?.initialized !== false) throw new IdentityError(409)
      }
      if (operation === 'create' && input.consoleReader !== true) throw new IdentityError(400)
      if (operation === 'create') {
        const count = await db.query('SELECT count(*)::int AS count FROM ok_identity.accounts')
        if (count.rows[0].count >= 1000) throw new IdentityError(409)
      }
      const salt = randomBytes(16).toString('base64')
      const verifier = (await this.hash(input.password, Buffer.from(salt, 'base64'))).toString('base64')
      let row
      if (operation === 'recover') {
        if (context.subject.method !== 'Bootstrap') throw new IdentityError(403)
        const selected = await db.query('SELECT * FROM ok_identity.accounts WHERE username=$1 AND administrator FOR UPDATE', [username])
        if (!selected.rows[0]) throw new IdentityError(400)
        const updated = await db.query('UPDATE ok_identity.accounts SET salt=$2,verifier=$3,enabled=true,revision=revision+1 WHERE id=$1 RETURNING *', [selected.rows[0].id, salt, verifier])
        row = updated.rows[0]
        await this.revoke(db, selected.rows[0])
      } else {
        const inserted = await db.query(`INSERT INTO ok_identity.accounts(id,username,salt,verifier,hash_profile,administrator)
          VALUES($1,$2,$3,$4,'scrypt-v1',$5) RETURNING *`, [randomUUID(), username, salt, verifier, operation === 'initialize'])
        row = inserted.rows[0]
        if (operation === 'initialize') await db.query('UPDATE ok_identity.state SET initialized=true WHERE singleton=true')
      }
      await this.audit(db, context.subject.id, row.id, operation === 'recover' ? 'Recovered' : operation === 'initialize' ? 'Initialized' : 'Created', correlationId)
      return { user: publicAccount(row) }
    })
  }
  async revoke(db, row) {
    await db.query(`UPDATE ok_console.sessions SET revoked_at=COALESCE(revoked_at,clock_timestamp()),revoke_reason=COALESCE(revoke_reason,'LOCAL_ACCOUNT_CHANGED')
      WHERE authentication_method='Local' AND authorization_revision=$1`, [revisionFor(row)])
  }
  async login(input, correlationId) {
    const username = normalizeUsername(input.username)
    if (!validUsername(username) || typeof input.password !== 'string' || Buffer.byteLength(input.password) > 256) {
      await this.audit(this.pool, 'anonymous', 'unresolved', 'LoginDenied', correlationId)
      throw new IdentityError(401)
    }
    if (await this.throttle.blocked(`ordinary:${username}`)) {
      await this.audit(this.pool, 'anonymous', 'unresolved', 'LoginDenied', correlationId)
      throw new IdentityError(401)
    }
    const selected = await this.pool.query('SELECT a.* FROM ok_identity.accounts a JOIN ok_identity.state s ON s.singleton AND s.initialized WHERE username=$1', [username])
    const row = selected.rows[0]
    const salt = row ? Buffer.from(row.salt, 'base64') : Buffer.alloc(16, 23)
    const expected = row ? Buffer.from(row.verifier, 'base64') : Buffer.alloc(32, 42)
    const actual = await this.hash(input.password, salt)
    if (!row?.enabled || row.hash_profile !== 'scrypt-v1' || expected.length !== 32 || !timingSafeEqual(actual, expected)) {
      await this.throttle.failure(`ordinary:${username}`)
      await this.audit(this.pool, 'anonymous', 'unresolved', 'LoginDenied', correlationId)
      throw new IdentityError(401)
    }
    const issued = await this.transaction(async (db) => {
      const checked = await db.query('SELECT * FROM ok_identity.accounts WHERE id=$1 FOR SHARE', [row.id])
      const current = checked.rows[0]
      if (!current?.enabled || current.revision !== row.revision) throw new IdentityError(401)
      const issued = await this.sessions.create({
        subject: { id: row.id, providerId: 'installation-local', subjectId: row.id, displayName: row.username, method: 'Local', assurance: ['Password','LocalDevelopment'] },
        scope: this.scope, permissions: row.administrator ? [...READER, ADMIN] : [...READER], authorizationRevision: revisionFor(row),
      }, db)
      await this.audit(db, row.id, row.id, 'LoginGranted', correlationId)
      return issued
    })
    try { await this.throttle.success(`ordinary:${username}`) } catch {
      await this.sessions.revoke(issued.cookie, 'THROTTLE_UNAVAILABLE').catch(() => {})
      throw new IdentityError()
    }
    return issued
  }
}

// Ordinary login failures cannot exhaust the independent exceptional-access throttle.
export const ordinaryThrottlePool = (pool) => ({
  query: (sql, args) => pool.query(sql.replaceAll('ok_console.local_access_throttle', 'ok_identity.login_throttle'), args),
})
