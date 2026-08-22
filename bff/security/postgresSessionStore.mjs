import { randomBytes } from 'node:crypto'
import { SECURITY_CONTRACT_VERSION, authorizeSecurityContext } from './authorization.mjs'
import { SessionEnvelopeError } from './envelope.mjs'
import {
  consoleSessionProjection,
  csrfCookie,
  digestSessionValue,
  opaqueSessionValue,
  readSessionCookie,
  sessionCookie,
  sessionLifetimesFor,
  validateSessionCreationInput,
  validSessionString,
} from './session.mjs'

const ACTIVE_PREDICATE = `
  session_digest = $1
  AND deployment_epoch = $2
  AND revoked_at IS NULL
  AND idle_expires_at > clock_timestamp()
  AND absolute_expires_at > clock_timestamp()`

export class SessionStoreError extends Error {
  constructor(code) {
    super('Console session store operation failed.')
    this.name = 'SessionStoreError'
    this.code = code
  }
}

const asDate = (value) => {
  const parsed = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(parsed.getTime())) throw new SessionStoreError('INVALID_ROW')
  return parsed
}

const asIso = (value) => asDate(value).toISOString()

const assertStoreInput = ({ authorizationRevision, deploymentEpoch }) => {
  if (!validSessionString(authorizationRevision) || !validSessionString(deploymentEpoch)) {
    throw new SessionStoreError('INVALID_INPUT')
  }
}

const issueValues = ({ random, lifetime, databaseNow }) => {
  const sessionId = opaqueSessionValue(random)
  const csrfToken = opaqueSessionValue(random)
  const sessionDigest = digestSessionValue(sessionId)
  const nowMs = asDate(databaseNow).getTime()
  return {
    sessionId,
    csrfToken,
    sessionDigest,
    csrfDigest: digestSessionValue(csrfToken),
    issuedAt: new Date(nowMs),
    idleExpiresAt: new Date(nowMs + lifetime.idleMs),
    absoluteExpiresAt: new Date(nowMs + lifetime.absoluteMs),
  }
}

const rowContext = (row, codec) => {
  let payload
  try {
    payload = codec.decrypt({ keyId: row.key_id, ciphertext: row.context_envelope })
    validateSessionCreationInput(payload)
  } catch (error) {
    if (error instanceof SessionEnvelopeError || error instanceof Error) {
      throw new SessionStoreError('DECRYPT_FAILED')
    }
    throw error
  }
  return {
    apiVersion: SECURITY_CONTRACT_VERSION,
    kind: 'AuthorizationContext',
    sessionId: `sha256:${row.session_digest}`,
    subject: payload.subject,
    scope: payload.scope,
    permissions: payload.permissions,
    authorizationRevision: row.authorization_revision,
    deploymentEpoch: row.deployment_epoch,
    session: {
      issuedAt: asIso(row.issued_at),
      idleExpiresAt: asIso(row.idle_expires_at),
      absoluteExpiresAt: asIso(row.absolute_expires_at),
      ...(row.revoked_at ? { revokedAt: asIso(row.revoked_at) } : {}),
    },
    csrfDigest: row.csrf_digest,
    idleLifetimeMs: Number(row.idle_lifetime_ms),
  }
}

const publicIssue = ({ values, context, maxAgeSeconds }) => ({
  cookie: sessionCookie(values.sessionId, maxAgeSeconds),
  csrfCookie: csrfCookie(values.csrfToken, maxAgeSeconds),
  csrfToken: values.csrfToken,
  session: consoleSessionProjection(context),
})

const normalizeStoreFailure = (error) => {
  if (error instanceof SessionStoreError) return error
  if (error?.code === '23505') return new SessionStoreError('SESSION_COLLISION')
  return new SessionStoreError('STORE_UNAVAILABLE')
}

export class PostgresSessionStore {
  constructor({
    pool,
    codec,
    deploymentEpoch,
    authorizationRevisionValidator = null,
    random = randomBytes,
    lifetimesFor = sessionLifetimesFor,
    now = () => new Date(),
  }) {
    if (!pool?.query || !pool?.connect || !codec?.encrypt || !codec?.decrypt || !validSessionString(deploymentEpoch)) {
      throw new SessionStoreError('INVALID_CONFIGURATION')
    }
    this.pool = pool
    this.codec = codec
    this.deploymentEpoch = deploymentEpoch
    this.authorizationRevisionValidator = authorizationRevisionValidator
    this.random = random
    this.lifetimesFor = lifetimesFor
    this.now = now
  }

  async create({ subject, scope, permissions, authorizationRevision }) {
    validateSessionCreationInput({ subject, scope, permissions })
    assertStoreInput({ authorizationRevision, deploymentEpoch: this.deploymentEpoch })
    try {
      const clock = await this.pool.query('SELECT clock_timestamp() AS database_now')
      const lifetime = this.lifetimesFor(subject.method)
      const values = issueValues({ random: this.random, lifetime, databaseNow: clock.rows[0].database_now })
      const envelope = this.codec.encrypt({ subject, scope, permissions })
      const result = await this.pool.query(`
        INSERT INTO ok_console.sessions (
          session_digest, session_family_digest, context_envelope, key_id, csrf_digest,
          authentication_method, authorization_revision, deployment_epoch,
          idle_lifetime_ms, issued_at, idle_expires_at, absolute_expires_at
        ) VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *`, [
        values.sessionDigest,
        envelope.ciphertext,
        envelope.keyId,
        values.csrfDigest,
        subject.method,
        authorizationRevision,
        this.deploymentEpoch,
        lifetime.idleMs,
        values.issuedAt,
        values.idleExpiresAt,
        values.absoluteExpiresAt,
      ])
      const context = rowContext(result.rows[0], this.codec)
      return publicIssue({ values, context, maxAgeSeconds: Math.floor(lifetime.absoluteMs / 1_000) })
    } catch (error) {
      throw normalizeStoreFailure(error)
    }
  }

  async resolve(cookieHeader, { touch = true } = {}) {
    const sessionId = readSessionCookie(cookieHeader)
    if (!sessionId) return null
    const digest = digestSessionValue(sessionId)
    try {
      const result = touch
        ? await this.pool.query(`
          UPDATE ok_console.sessions
          SET idle_expires_at = LEAST(
            clock_timestamp() + make_interval(secs => idle_lifetime_ms / 1000.0),
            absolute_expires_at
          )
          WHERE ${ACTIVE_PREDICATE}
          RETURNING *`, [digest, this.deploymentEpoch])
        : await this.pool.query(`
          SELECT * FROM ok_console.sessions
          WHERE ${ACTIVE_PREDICATE}`, [digest, this.deploymentEpoch])
      return result.rows[0] ? rowContext(result.rows[0], this.codec) : null
    } catch (error) {
      throw normalizeStoreFailure(error)
    }
  }

  async rotate(cookieHeader) {
    const oldSessionId = readSessionCookie(cookieHeader)
    if (!oldSessionId) return null
    const client = await this.pool.connect().catch((error) => { throw normalizeStoreFailure(error) })
    try {
      await client.query('BEGIN')
      const selected = await client.query(`
        SELECT *, clock_timestamp() AS database_now
        FROM ok_console.sessions
        WHERE ${ACTIVE_PREDICATE}
        FOR UPDATE`, [digestSessionValue(oldSessionId), this.deploymentEpoch])
      const row = selected.rows[0]
      if (!row) {
        await client.query('ROLLBACK')
        return null
      }
      const oldContext = rowContext(row, this.codec)
      const payload = {
        subject: oldContext.subject,
        scope: oldContext.scope,
        permissions: oldContext.permissions,
      }
      const newSessionId = opaqueSessionValue(this.random)
      const csrfToken = opaqueSessionValue(this.random)
      const newDigest = digestSessionValue(newSessionId)
      const envelope = this.codec.encrypt(payload)
      await client.query(`
        UPDATE ok_console.sessions
        SET revoked_at = clock_timestamp(), revoke_reason = 'ROTATED'
        WHERE session_digest = $1`, [row.session_digest])
      const inserted = await client.query(`
        INSERT INTO ok_console.sessions (
          session_digest, session_family_digest, context_envelope, key_id, csrf_digest,
          authentication_method, authorization_revision, deployment_epoch,
          idle_lifetime_ms, issued_at, idle_expires_at, absolute_expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING *`, [
        newDigest,
        row.session_family_digest,
        envelope.ciphertext,
        envelope.keyId,
        digestSessionValue(csrfToken),
        row.authentication_method,
        row.authorization_revision,
        row.deployment_epoch,
        row.idle_lifetime_ms,
        row.issued_at,
        row.idle_expires_at,
        row.absolute_expires_at,
      ])
      await client.query('COMMIT')
      const values = { sessionId: newSessionId, csrfToken }
      const context = rowContext(inserted.rows[0], this.codec)
      const remainingSeconds = Math.max(0, Math.floor((asDate(row.absolute_expires_at).getTime() - asDate(row.database_now).getTime()) / 1_000))
      return publicIssue({ values, context, maxAgeSeconds: remainingSeconds })
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw normalizeStoreFailure(error)
    } finally {
      client.release()
    }
  }

  async revoke(cookieHeader, reason = 'LOGOUT') {
    const sessionId = readSessionCookie(cookieHeader)
    if (!sessionId) return false
    if (!validSessionString(reason)) throw new SessionStoreError('INVALID_INPUT')
    const client = await this.pool.connect().catch((error) => { throw normalizeStoreFailure(error) })
    try {
      await client.query('BEGIN')
      const selected = await client.query(`
        SELECT session_family_digest
        FROM ok_console.sessions
        WHERE session_digest = $1 AND deployment_epoch = $2
        FOR UPDATE`, [digestSessionValue(sessionId), this.deploymentEpoch])
      if (!selected.rows[0]) {
        await client.query('ROLLBACK')
        return false
      }
      await client.query(`
        UPDATE ok_console.sessions
        SET revoked_at = COALESCE(revoked_at, clock_timestamp()),
            revoke_reason = COALESCE(revoke_reason, $2)
        WHERE session_family_digest = $1`, [selected.rows[0].session_family_digest, reason])
      await client.query('COMMIT')
      return true
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw normalizeStoreFailure(error)
    } finally {
      client.release()
    }
  }

  async authorize(cookieHeader, request) {
    const context = await this.resolve(cookieHeader, { touch: false })
    if (!context) return { allowed: false, reason: 'INVALID_CONTEXT', identity: null }
    if (typeof this.authorizationRevisionValidator !== 'function') {
      return { allowed: false, reason: 'AUTHORIZATION_REVISION_UNVERIFIED', identity: null }
    }
    let revisionCurrent = false
    try {
      revisionCurrent = await this.authorizationRevisionValidator({
        revision: context.authorizationRevision,
        subjectId: context.subject.id,
        environmentId: context.scope.environmentId,
      })
    } catch {
      return { allowed: false, reason: 'AUTHORIZATION_REVISION_UNAVAILABLE', identity: null }
    }
    if (revisionCurrent !== true) {
      return { allowed: false, reason: 'AUTHORIZATION_REVISION_STALE', identity: null }
    }
    const result = authorizeSecurityContext(context, request, this.now)
    if (!result.allowed) return result
    const touched = await this.resolve(cookieHeader)
    return touched ? result : { allowed: false, reason: 'SESSION_CHANGED', identity: null }
  }

  async purgeExpired(limit = 500) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new SessionStoreError('INVALID_INPUT')
    try {
      const result = await this.pool.query(`
        DELETE FROM ok_console.sessions
        WHERE session_digest IN (
          SELECT session_digest
          FROM ok_console.sessions
          WHERE revoked_at IS NOT NULL
             OR idle_expires_at <= clock_timestamp()
             OR absolute_expires_at <= clock_timestamp()
          ORDER BY LEAST(idle_expires_at, absolute_expires_at)
          LIMIT $1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING session_digest`, [limit])
      return result.rowCount ?? 0
    } catch (error) {
      throw normalizeStoreFailure(error)
    }
  }
}
