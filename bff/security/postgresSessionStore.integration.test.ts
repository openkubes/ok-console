// @vitest-environment node

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionEnvelopeCodec } from './envelope.mjs'
import { PostgresOidcTransactionStore } from './oidcTransactionStore.mjs'
import { createLocalAccessVerifier, PostgresLocalAccessAudit, PostgresLocalAccessThrottle } from './localAccess.mjs'
import { PostgresSessionStore, SessionStoreError } from './postgresSessionStore.mjs'
import { createLocalAccessHttpHandler } from './localAccessHttp.mjs'
import { readSessionCookie } from './session.mjs'

const connectionString = process.env.OK_CONSOLE_TEST_POSTGRES_URL
const subject = {
  id: 'subject-01K34',
  providerId: 'openkubes-identity',
  subjectId: 'issuer-subject-opaque-9f2',
  displayName: 'Arash Kaffamanesh',
  method: 'OIDC',
  assurance: ['pwd', 'mfa'],
}
const scope = { environmentId: 'community-preview', tenantIds: ['tenant-platform'] }
const permissions = ['platform.read', 'clusters.read', 'evidence.read']
const keyOne = Buffer.alloc(32, 11)
const keyTwo = Buffer.alloc(32, 22)

const suite = connectionString ? describe : describe.skip

suite('ADR-038 PostgreSQL Session Store conformance', () => {
  let pool: pg.Pool
  let codec: SessionEnvelopeCodec
  let store: PostgresSessionStore

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString, max: 8 })
    const migration = await readFile(new URL('./postgres/001_console_sessions.sql', import.meta.url), 'utf8')
    await pool.query(migration)
    const oidcMigration = await readFile(new URL('./postgres/002_oidc_transactions.sql', import.meta.url), 'utf8')
    await pool.query(oidcMigration)
    const localAccessMigration = await readFile(new URL('./postgres/003_local_access_throttle.sql', import.meta.url), 'utf8')
    await pool.query(localAccessMigration)
    const localAuditMigration = await readFile(new URL('./postgres/004_local_access_audit.sql', import.meta.url), 'utf8')
    await pool.query(localAuditMigration)
  })

  beforeEach(async () => {
    await pool.query('TRUNCATE ok_console.sessions, ok_console.oidc_transactions, ok_console.local_access_throttle, ok_console.local_access_audit')
    codec = new SessionEnvelopeCodec({ primaryKeyId: 'key-1', keys: { 'key-1': keyOne } })
    store = new PostgresSessionStore({ pool, codec, deploymentEpoch: 'epoch-test-1' })
  })

  afterAll(async () => {
    await pool?.end()
  })

  const issue = () => store.create({
    subject,
    scope,
    permissions,
    authorizationRevision: 'mapping-revision-7',
  })

  it('stores only a digest key, CSRF digest and encrypted context', async () => {
    const issued = await issue()
    const rawSession = readSessionCookie(issued.cookie)
    const stored = await pool.query('SELECT * FROM ok_console.sessions')
    const row = stored.rows[0]

    expect(stored.rowCount).toBe(1)
    expect(row.session_digest).not.toBe(rawSession)
    expect(row.csrf_digest).not.toBe(issued.csrfToken)
    expect(row.context_envelope).not.toContain(subject.subjectId)
    expect(JSON.stringify(row)).not.toContain(issued.csrfToken)
    expect(await store.resolve(issued.cookie, { touch: false })).toMatchObject({
      authorizationRevision: 'mapping-revision-7',
      deploymentEpoch: 'epoch-test-1',
      subject: { id: subject.id },
    })
  })

  it('allows exactly one concurrent rotation and preserves one active reference', async () => {
    const issued = await issue()
    const rotations = await Promise.all([store.rotate(issued.cookie), store.rotate(issued.cookie)])
    const successful = rotations.filter((item) => item !== null)
    const active = await pool.query(`
      SELECT count(*)::int AS count
      FROM ok_console.sessions
      WHERE revoked_at IS NULL`)

    expect(successful).toHaveLength(1)
    expect(await store.resolve(issued.cookie, { touch: false })).toBeNull()
    expect(await store.resolve(successful[0]?.cookie, { touch: false })).not.toBeNull()
    expect(active.rows[0].count).toBe(1)
  })

  it('propagates revocation across independent BFF store instances', async () => {
    const issued = await issue()
    const secondReplica = new PostgresSessionStore({ pool, codec, deploymentEpoch: 'epoch-test-1' })

    expect(await secondReplica.resolve(issued.cookie, { touch: false })).not.toBeNull()
    expect(await store.revoke(issued.cookie, 'ADMIN_REVOKE')).toBe(true)
    expect(await secondReplica.resolve(issued.cookie, { touch: false })).toBeNull()
  })

  it('revokes the entire session family during a concurrent rotate/logout race', async () => {
    const issued = await issue()
    const [rotated] = await Promise.all([
      store.rotate(issued.cookie),
      store.revoke(issued.cookie, 'LOGOUT'),
    ])
    const active = await pool.query(`
      SELECT count(*)::int AS count
      FROM ok_console.sessions
      WHERE revoked_at IS NULL`)

    expect(active.rows[0].count).toBe(0)
    expect(await store.resolve(issued.cookie, { touch: false })).toBeNull()
    if (rotated) expect(await store.resolve(rotated.cookie, { touch: false })).toBeNull()
  })

  it('uses database-time expiry and bounded terminal-row cleanup', async () => {
    const shortStore = new PostgresSessionStore({
      pool,
      codec,
      deploymentEpoch: 'epoch-test-1',
      lifetimesFor: () => ({ idleMs: 80, absoluteMs: 250 }),
    })
    const issued = await shortStore.create({ subject, scope, permissions, authorizationRevision: 'mapping-revision-7' })
    await new Promise((resolve) => setTimeout(resolve, 120))

    expect(await shortStore.resolve(issued.cookie, { touch: false })).toBeNull()
    expect(await shortStore.purgeExpired(1)).toBe(1)
    expect((await pool.query('SELECT count(*)::int AS count FROM ok_console.sessions')).rows[0].count).toBe(0)
  })

  it('invalidates sessions across deployment epochs', async () => {
    const issued = await issue()
    const recoveredDeployment = new PostgresSessionStore({ pool, codec, deploymentEpoch: 'epoch-after-restore' })

    expect(await recoveredDeployment.resolve(issued.cookie, { touch: false })).toBeNull()
  })

  it('fails closed when the envelope key is unavailable', async () => {
    const issued = await issue()
    const wrongCodec = new SessionEnvelopeCodec({ primaryKeyId: 'key-2', keys: { 'key-2': keyTwo } })
    const wrongKeyStore = new PostgresSessionStore({ pool, codec: wrongCodec, deploymentEpoch: 'epoch-test-1' })

    await expect(wrongKeyStore.resolve(issued.cookie, { touch: false })).rejects.toMatchObject<Partial<SessionStoreError>>({
      code: 'DECRYPT_FAILED',
    })
  })

  it('requires a current authorization revision and touches only allowed requests', async () => {
    const issued = await issue()
    const before = await pool.query('SELECT idle_expires_at FROM ok_console.sessions WHERE revoked_at IS NULL')
    await new Promise((resolve) => setTimeout(resolve, 20))

    const unverified = await store.authorize(issued.cookie, {
      permission: 'platform.read',
      environmentId: scope.environmentId,
    })
    const staleStore = new PostgresSessionStore({
      pool,
      codec,
      deploymentEpoch: 'epoch-test-1',
      authorizationRevisionValidator: async () => false,
    })
    const stale = await staleStore.authorize(issued.cookie, {
      permission: 'platform.read',
      environmentId: scope.environmentId,
    })
    const currentStore = new PostgresSessionStore({
      pool,
      codec,
      deploymentEpoch: 'epoch-test-1',
      authorizationRevisionValidator: async ({ revision }) => revision === 'mapping-revision-7',
    })
    const allowed = await currentStore.authorize(issued.cookie, {
      permission: 'platform.read',
      environmentId: scope.environmentId,
    })
    const after = await pool.query('SELECT idle_expires_at FROM ok_console.sessions WHERE revoked_at IS NULL')

    expect(unverified.reason).toBe('AUTHORIZATION_REVISION_UNVERIFIED')
    expect(stale.reason).toBe('AUTHORIZATION_REVISION_STALE')
    expect(allowed.allowed).toBe(true)
    expect(after.rows[0].idle_expires_at.getTime()).toBeGreaterThan(before.rows[0].idle_expires_at.getTime())
  })

  it('consumes encrypted OIDC transaction state exactly once across replicas', async () => {
    const firstReplica = new PostgresOidcTransactionStore({ pool, codec, deploymentEpoch: 'epoch-test-1' })
    const secondReplica = new PostgresOidcTransactionStore({ pool, codec, deploymentEpoch: 'epoch-test-1' })
    const transaction = { codeVerifier: 'pkce-verifier', state: 'oauth-state', nonce: 'oidc-nonce' }
    const issued = await firstReplica.create(transaction)
    const stored = await pool.query('SELECT * FROM ok_console.oidc_transactions')

    expect(stored.rowCount).toBe(1)
    expect(JSON.stringify(stored.rows[0])).not.toContain(transaction.codeVerifier)
    expect(JSON.stringify(stored.rows[0])).not.toContain(transaction.state)
    expect(await secondReplica.consume(issued.cookie)).toEqual(transaction)
    expect(await firstReplica.consume(issued.cookie)).toBeNull()
  })

  it('rejects expired OIDC transactions and purges them with a bound', async () => {
    const transactions = new PostgresOidcTransactionStore({ pool, codec, deploymentEpoch: 'epoch-test-1' })
    const issued = await transactions.create({ codeVerifier: 'pkce-verifier', state: 'oauth-state', nonce: 'oidc-nonce' })
    await pool.query(`
      UPDATE ok_console.oidc_transactions
      SET created_at = clock_timestamp() - interval '2 seconds',
          expires_at = clock_timestamp() - interval '1 second'`)

    expect(await transactions.consume(issued.cookie)).toBeNull()
    expect(await transactions.purgeExpired(1)).toBe(1)
  })

  it('shares exceptional-access throttling across replicas without storing usernames', async () => {
    const first = new PostgresLocalAccessThrottle({ pool, pepper: Buffer.alloc(32, 5) })
    const second = new PostgresLocalAccessThrottle({ pool, pepper: Buffer.alloc(32, 5) })
    for (let attempt = 0; attempt < 5; attempt += 1) expect((await first.reserve('recovery-admin')).blocked).toBe(false)
    const before = (await pool.query('SELECT * FROM ok_console.local_access_throttle ORDER BY principal_digest')).rows
    expect(await second.reserve('recovery-admin')).toEqual({ blocked: true })
    expect((await pool.query('SELECT * FROM ok_console.local_access_throttle ORDER BY principal_digest')).rows).toEqual(before)
    expect(JSON.stringify(before)).not.toContain('recovery-admin')
    for (let attempt = 5; attempt < 50; attempt += 1) expect((await first.reserve(`rotating-principal-${attempt}`)).blocked).toBe(false)
    const globalBefore = (await pool.query('SELECT * FROM ok_console.local_access_throttle ORDER BY principal_digest')).rows
    expect(await second.reserve('previously-unseen-principal')).toEqual({ blocked: true })
    expect((await pool.query('SELECT * FROM ok_console.local_access_throttle ORDER BY principal_digest')).rows).toEqual(globalBefore)
  })

  const localAccount = {
    username: 'recovery-admin', enabled: true, salt: Buffer.alloc(16, 1).toString('base64'),
    verifier: Buffer.alloc(32, 2).toString('base64'), identityId: 'local-1', displayName: 'Recovery Admin',
    environmentId: 'prod', tenantIds: ['platform'], permissions: ['platform.read'],
  }
  const localInput = (password = 'wrong') => ({ username: 'recovery-admin', password, reason: 'Emergency recovery attempt' })
  const localVerifier = (throttle: PostgresLocalAccessThrottle) => {
    const derive = vi.fn(async (password: string) => Buffer.alloc(32, password === 'correct' ? 2 : 3))
    const create = vi.fn(() => issue())
    const audit = vi.fn(async () => {})
    return { derive, create, audit, verify: createLocalAccessVerifier({
      mode: 'BreakGlass', accounts: [localAccount], throttle, sessionStore: { create }, derive, audit,
      authorizationRevision: 'revision',
    }) }
  }

  it.each(['__global__', 'recovery-admin'])('refuses both password verdicts while %s is row-locked and resumes exact limits', async (lockedPrincipal) => {
    const limitedPool = new pg.Pool({ connectionString, options: '-c statement_timeout=300' })
    const throttle = new PostgresLocalAccessThrottle({ pool: limitedPool, pepper: Buffer.alloc(32, 5) })
    const { verify, derive, create, audit } = localVerifier(throttle)
    const locker = await pool.connect()
    const handler = createLocalAccessHttpHandler({ verifier: verify, expectedOrigin: 'https://console.invalid' })
    const server = createServer((request, response) => {
      void handler({ request, response, pathname: '/api/console/v0/auth/local', correlationId: 'lock-test' })
    })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      await pool.query(`
        INSERT INTO ok_console.local_access_throttle (principal_digest, failures, window_started_at)
        SELECT unnest($1::text[]), 0, clock_timestamp()`,
      [[throttle.globalDigest(), throttle.digest('recovery-admin')]])
      await locker.query('BEGIN')
      await locker.query('SELECT * FROM ok_console.local_access_throttle WHERE principal_digest = $1 FOR UPDATE', [lockedPrincipal === '__global__' ? throttle.globalDigest() : throttle.digest(lockedPrincipal)])
      for (const password of ['wrong', 'correct']) {
        await expect(verify(localInput(password))).rejects.toMatchObject({
          code: 'LOCAL_ACCESS_UNAVAILABLE', step: 'THROTTLE_RESERVE', cause: { code: expect.stringMatching(/^(55P03|PG_STATEMENT_TIMEOUT)$/) },
        })
        const address = server.address() as { port: number }
        const response = await fetch(`http://127.0.0.1:${address.port}/api/console/v0/auth/local`, {
          method: 'POST', headers: { origin: 'https://console.invalid', 'content-type': 'application/json' },
          body: JSON.stringify(localInput(password)),
        })
        expect(response.status).toBe(503)
        expect(response.headers.get('set-cookie')).toBeNull()
        expect(await response.json()).toMatchObject({ error: { code: 'LOCAL_ACCESS_UNAVAILABLE' } })
      }
      expect(log.mock.calls.map(call => JSON.parse(call[0]))).toEqual([
        expect.objectContaining({ cause: 'THROTTLE_RESERVE', errorCode: expect.stringMatching(/^(OTHER|PG_STATEMENT_TIMEOUT)$/) }),
        expect.objectContaining({ cause: 'THROTTLE_RESERVE', errorCode: expect.stringMatching(/^(OTHER|PG_STATEMENT_TIMEOUT)$/) }),
      ])
      expect(derive).not.toHaveBeenCalled()
      expect(create).not.toHaveBeenCalled()
      expect((await pool.query('SELECT count(*)::int AS count FROM ok_console.sessions')).rows[0].count).toBe(0)
      await locker.query('ROLLBACK')
      expect((await pool.query('SELECT failures FROM ok_console.local_access_throttle')).rows.map(row => row.failures)).toEqual([0, 0])
      for (let i = 0; i < 5; i++) await expect(verify(localInput())).rejects.toMatchObject({ code: 'LOCAL_ACCESS_REJECTED' })
      expect(derive).toHaveBeenCalledTimes(5)
      const before = (await pool.query('SELECT * FROM ok_console.local_access_throttle ORDER BY principal_digest')).rows
      expect(before.map(row => row.failures)).toEqual([5, 5])
      await expect(verify(localInput('correct'))).rejects.toMatchObject({ code: 'LOCAL_ACCESS_REJECTED' })
      expect(derive).toHaveBeenCalledTimes(5)
      expect(create).not.toHaveBeenCalled()
      expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ cause: 'THROTTLED' }))
      expect((await pool.query('SELECT * FROM ok_console.local_access_throttle ORDER BY principal_digest')).rows).toEqual(before)
    } finally {
      log.mockRestore()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await locker.query('ROLLBACK')
      locker.release()
      await limitedPool.end()
    }
  })

  it('keeps the reservation and refuses a session when success release times out', async () => {
    const limitedPool = new pg.Pool({ connectionString, options: '-c statement_timeout=300' })
    const throttle = new PostgresLocalAccessThrottle({ pool: limitedPool, pepper: Buffer.alloc(32, 5) })
    const locker = await pool.connect()
    const create = vi.fn(() => issue())
    const verify = createLocalAccessVerifier({
      mode: 'BreakGlass', accounts: [localAccount], throttle, sessionStore: { create },
      authorizationRevision: 'revision',
      derive: async () => {
        await locker.query('BEGIN')
        await locker.query('SELECT * FROM ok_console.local_access_throttle WHERE principal_digest = $1 FOR UPDATE', [throttle.globalDigest()])
        return Buffer.alloc(32, 2)
      },
    })
    try {
      await expect(verify(localInput('correct'))).rejects.toMatchObject({
        code: 'LOCAL_ACCESS_UNAVAILABLE', step: 'THROTTLE_RESET', cause: { code: expect.stringMatching(/^(55P03|PG_STATEMENT_TIMEOUT)$/) },
      })
      expect(create).not.toHaveBeenCalled()
      await locker.query('ROLLBACK')
      expect((await pool.query('SELECT failures FROM ok_console.local_access_throttle')).rows.map(row => row.failures)).toEqual([1, 1])
      expect((await pool.query('SELECT count(*)::int AS count FROM ok_console.sessions')).rows[0].count).toBe(0)
    } finally {
      await locker.query('ROLLBACK')
      locker.release()
      await limitedPool.end()
    }
  })

  it('keeps the 15-minute window and database-time block arithmetic', async () => {
    const throttle = new PostgresLocalAccessThrottle({ pool, pepper: Buffer.alloc(32, 5) })
    await throttle.reserve('recovery-admin')
    await pool.query("UPDATE ok_console.local_access_throttle SET window_started_at = clock_timestamp() - interval '16 minutes', failures = 4")
    await throttle.reserve('recovery-admin')
    const reset = (await pool.query("SELECT failures, window_started_at, clock_timestamp() - window_started_at < interval '5 seconds' AS recent FROM ok_console.local_access_throttle WHERE principal_digest = $1", [throttle.digest('recovery-admin')])).rows[0]
    expect(reset.failures).toBe(1)
    expect(reset.recent).toBe(true)
    for (let i = 0; i < 3; i++) await throttle.reserve('recovery-admin')
    const before = (await pool.query('SELECT clock_timestamp() AS now')).rows[0].now.getTime()
    await throttle.reserve('recovery-admin')
    const after = (await pool.query('SELECT clock_timestamp() AS now')).rows[0].now.getTime()
    const row = (await pool.query('SELECT failures, window_started_at, blocked_until FROM ok_console.local_access_throttle WHERE principal_digest = $1', [throttle.digest('recovery-admin')])).rows[0]
    expect(row.failures).toBe(5)
    expect(row.window_started_at).toEqual(reset.window_started_at)
    expect(row.blocked_until.getTime()).toBeGreaterThanOrEqual(before + 15 * 60 * 1000)
    expect(row.blocked_until.getTime()).toBeLessThanOrEqual(after + 15 * 60 * 1000)
  })

  it('serializes concurrent reservations and stops exactly at each limit', async () => {
    const throttle = new PostgresLocalAccessThrottle({ pool, pepper: Buffer.alloc(32, 5) })
    const principal = await Promise.all(Array.from({ length: 12 }, () => throttle.reserve('recovery-admin')))
    expect(principal.filter(item => !item.blocked)).toHaveLength(5)
    const rotating = await Promise.all(Array.from({ length: 55 }, (_, i) => throttle.reserve(`rotating-${i}`)))
    expect(rotating.filter(item => !item.blocked)).toHaveLength(45)
    expect((await pool.query('SELECT failures FROM ok_console.local_access_throttle WHERE principal_digest = $1', [throttle.globalDigest()])).rows[0].failures).toBe(50)
  })

  it('counts and audits global-name aliases as ordinary principals', async () => {
    const throttle = new PostgresLocalAccessThrottle({ pool, pepper: Buffer.alloc(32, 5) })
    const { verify, derive, audit } = localVerifier(throttle)
    for (const username of ['__global__', '＿＿ＧＬＯＢＡＬ＿＿']) {
      await expect(verify({ ...localInput(), username })).rejects.toMatchObject({ code: 'LOCAL_ACCESS_REJECTED' })
    }
    expect(derive).toHaveBeenCalledTimes(2)
    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ principal: '__global__', cause: 'INVALID_CREDENTIAL' }))
    expect((await pool.query('SELECT failures FROM ok_console.local_access_throttle')).rows.map(row => row.failures)).toEqual([2, 2])
  })

  it('50 successful logins release global budget and never block', async () => {
    const throttle = new PostgresLocalAccessThrottle({ pool, pepper: Buffer.alloc(32, 5) })
    const { verify, create } = localVerifier(throttle)
    for (let i = 0; i < 50; i++) await expect(verify(localInput('correct'))).resolves.toHaveProperty('cookie')
    expect(create).toHaveBeenCalledTimes(50)
    expect((await pool.query('SELECT principal_digest, failures, blocked_until FROM ok_console.local_access_throttle')).rows)
      .toEqual(expect.arrayContaining([
        { principal_digest: throttle.globalDigest(), failures: 0, blocked_until: null },
        { principal_digest: throttle.digest('recovery-admin'), failures: 0, blocked_until: null },
      ]))
  })

  it('releases a successful threshold reservation and never decrements another window', async () => {
    const throttle = new PostgresLocalAccessThrottle({ pool, pepper: Buffer.alloc(32, 5) })
    for (let i = 0; i < 49; i++) await throttle.reserve(`principal-${i}`)
    const reservation = await throttle.reserve('recovery-admin')
    await throttle.success('recovery-admin', reservation)
    expect((await pool.query('SELECT failures, blocked_until FROM ok_console.local_access_throttle WHERE principal_digest = $1', [throttle.globalDigest()])).rows[0])
      .toEqual({ failures: 49, blocked_until: null })
    await pool.query("UPDATE ok_console.local_access_throttle SET window_started_at = clock_timestamp() - interval '16 minutes', blocked_until = NULL")
    const fresh = await throttle.reserve('recovery-admin')
    await throttle.success('recovery-admin', reservation)
    expect((await pool.query('SELECT failures FROM ok_console.local_access_throttle WHERE principal_digest = $1', [throttle.globalDigest()])).rows[0].failures).toBe(1)
    await throttle.success('recovery-admin', fresh)
    await throttle.success('recovery-admin', fresh)
    expect((await pool.query('SELECT failures FROM ok_console.local_access_throttle WHERE principal_digest = $1', [throttle.globalDigest()])).rows[0].failures).toBe(0)
  })

  // Promise barriers control KDF and transaction progress; polling observes real PG locks.
  const barrier = () => {
    let resolve!: () => void
    const promise = new Promise<void>(r => { resolve = r })
    return { promise, resolve }
  }
  const waitForReserveLock = async () => {
    const deadline = Date.now() + 800
    while (Date.now() < deadline) {
      const result = await pool.query(`SELECT 1 FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query LIKE '%ORDER BY principal_digest FOR UPDATE%'
          AND pid <> pg_backend_pid()`)
      if (result.rowCount) return
      await new Promise(resolve => setTimeout(resolve, 2))
    }
    throw new Error('reserve did not queue on the ordered locking SELECT')
  }

  it.each(['reset', 'blocked', 'delete'])('queued reserve versus concurrent success: %s', async action => {
    const throttle = new PostgresLocalAccessThrottle({ pool, pepper: Buffer.alloc(32, 5) })
    for (let i = 0; i < 4; i++) await throttle.reserve('recovery-admin')
    const locker = await pool.connect()
    const { verify, derive, audit } = localVerifier(throttle)
    let pending: Promise<unknown> | undefined
    try {
      await locker.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      await locker.query(`SELECT principal_digest FROM ok_console.local_access_throttle
        WHERE principal_digest = ANY($1::text[]) ORDER BY principal_digest FOR UPDATE`,
      [[throttle.digest('recovery-admin'), throttle.globalDigest()].sort()])
      pending = verify(localInput()).catch(error => error)
      await waitForReserveLock()
      if (action === 'delete') {
        await locker.query('DELETE FROM ok_console.local_access_throttle WHERE principal_digest = $1', [throttle.digest('recovery-admin')])
      } else if (action === 'reset') {
        await locker.query(`UPDATE ok_console.local_access_throttle SET failures = 0, blocked_until = NULL,
          window_started_at = clock_timestamp() WHERE principal_digest = $1`, [throttle.digest('recovery-admin')])
        await locker.query('UPDATE ok_console.local_access_throttle SET failures = failures - 1 WHERE principal_digest = $1', [throttle.globalDigest()])
      } else {
        await locker.query(`UPDATE ok_console.local_access_throttle SET failures = 5,
          blocked_until = clock_timestamp() + interval '15 minutes' WHERE principal_digest = $1`, [throttle.digest('recovery-admin')])
      }
      await locker.query('COMMIT')
      const result = await pending
      if (action === 'delete') {
        expect(result).toMatchObject({ code: 'LOCAL_ACCESS_UNAVAILABLE', step: 'THROTTLE_RESERVE' })
        expect(derive).not.toHaveBeenCalled()
        expect((await pool.query('SELECT failures FROM ok_console.local_access_throttle')).rows).toEqual([{ failures: 4 }])
      } else {
        expect(result).toMatchObject({ code: 'LOCAL_ACCESS_REJECTED' })
        expect(derive).toHaveBeenCalledTimes(action === 'reset' ? 1 : 0)
        expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ cause: action === 'reset' ? 'INVALID_CREDENTIAL' : 'THROTTLED' }))
        expect((await pool.query('SELECT failures FROM ok_console.local_access_throttle WHERE principal_digest = $1', [throttle.digest('recovery-admin')])).rows[0].failures).toBe(action === 'reset' ? 1 : 5)
      }
    } finally {
      await locker.query('ROLLBACK'); locker.release(); await pending
    }
  })

  it.each([
    ['Postgres, MDY', 'America/Havana'], ['SQL, DMY', 'Asia/Kolkata'], ['ISO, MDY', 'UTC'],
  ])('releases 50 successes under DateStyle %s / %s and permits the next', async (style, zone) => {
    const settingsPool = new pg.Pool({ connectionString, options: `-c DateStyle=${style.replaceAll(' ', '')} -c TimeZone=${zone}` })
    try {
      const throttle = new PostgresLocalAccessThrottle({ pool: settingsPool, pepper: Buffer.alloc(32, 5) })
      const { verify } = localVerifier(throttle)
      for (let i = 0; i < 50; i++) await expect(verify(localInput('correct'))).resolves.toHaveProperty('cookie')
      expect((await pool.query('SELECT failures FROM ok_console.local_access_throttle WHERE principal_digest = $1', [throttle.globalDigest()])).rows[0].failures).toBe(0)
      await expect(verify(localInput('correct'))).resolves.toHaveProperty('cookie')
    } finally { await settingsPool.end() }
  })

  it('audits a blocked attempt promptly while the global row lock is held', async () => {
    const throttle = new PostgresLocalAccessThrottle({ pool, pepper: Buffer.alloc(32, 5) })
    for (let i = 0; i < 5; i++) await throttle.reserve('recovery-admin')
    const locker = await pool.connect()
    const { verify, derive, audit } = localVerifier(throttle)
    try {
      await locker.query('BEGIN')
      await locker.query('SELECT 1 FROM ok_console.local_access_throttle WHERE principal_digest = $1 FOR UPDATE', [throttle.globalDigest()])
      const start = Date.now()
      await expect(verify(localInput())).rejects.toMatchObject({ code: 'LOCAL_ACCESS_REJECTED' })
      expect(Date.now() - start).toBeLessThan(300)
      expect(derive).not.toHaveBeenCalled()
      expect(audit).toHaveBeenCalledWith(expect.objectContaining({ cause: 'THROTTLED' }))
    } finally { await locker.query('ROLLBACK'); locker.release() }
  })

  it('holds in-flight correct budget at global 49 until KDF finishes', async () => {
    const throttle = new PostgresLocalAccessThrottle({ pool, pepper: Buffer.alloc(32, 5) })
    for (let i = 0; i < 49; i++) await throttle.reserve(`unknown-${i}`)
    const entered = barrier(), finish = barrier()
    const audit = vi.fn(async () => {})
    const verify = createLocalAccessVerifier({ mode: 'BreakGlass', accounts: [localAccount], throttle,
      sessionStore: { create: () => issue() }, audit, derive: async () => { entered.resolve(); await finish.promise; return Buffer.alloc(32, 2) } })
    const first = verify(localInput('correct'))
    try {
      await entered.promise
      await expect(verify(localInput('correct'))).rejects.toMatchObject({ code: 'LOCAL_ACCESS_REJECTED' })
      expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ cause: 'THROTTLED' }))
      expect((await pool.query('SELECT failures FROM ok_console.local_access_throttle WHERE principal_digest = $1', [throttle.globalDigest()])).rows[0].failures).toBe(50)
    } finally { finish.resolve(); await first }
    expect((await pool.query('SELECT failures FROM ok_console.local_access_throttle WHERE principal_digest = $1', [throttle.globalDigest()])).rows[0].failures).toBe(49)
  })

  it('caps peak principal counts at 5 and preserves each block deadline during 150 wrong and 3 correct logins', async () => {
    const throttle = new PostgresLocalAccessThrottle({ pool, pepper: Buffer.alloc(32, 5) })
    const { verify } = localVerifier(throttle)
    const jobs = Array.from({ length: 150 }, () => 'wrong')
    for (const at of [0, 40, 80]) jobs.splice(at, 0, 'correct')
    let next = 0, peak = 0, lastDeadline: number | null = null, samples = 0
    const sample = async () => {
      const row = (await pool.query('SELECT failures, blocked_until FROM ok_console.local_access_throttle WHERE principal_digest = $1', [throttle.digest('recovery-admin')])).rows[0]
      if (!row) return
      samples++; peak = Math.max(peak, row.failures)
      expect(row.failures).toBeLessThanOrEqual(5)
      const deadline = row.blocked_until?.getTime() ?? null
      if (lastDeadline !== null && deadline !== null) expect(deadline).toBe(lastDeadline)
      lastDeadline = deadline
    }
    const start = Date.now()
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (next < jobs.length) {
        const password = jobs[next++]
        try { await verify(localInput(password)) } catch (error) { expect(error).toMatchObject({ code: 'LOCAL_ACCESS_REJECTED' }) }
        await sample()
      }
    }))
    expect(samples).toBeGreaterThan(0); expect(peak).toBe(5)
    expect(Date.now() - start).toBeLessThan(10000)
    console.log(`THROTTLE_LOAD wrong=150 correct=3 concurrency=8 samples=${samples} peak=${peak} ms=${Date.now() - start}`)
  }, 10000)

  it('persists credential-free exceptional-access audit Evidence using database time', async () => {
    const audit = new PostgresLocalAccessAudit({ pool, pepper: Buffer.alloc(32, 5) })
    await audit.record({ principal: 'recovery-admin', method: 'BreakGlass', outcome: 'Denied',
      cause: 'INVALID_CREDENTIAL', reason: 'Emergency provider recovery', correlationId: 'corr-pg-1' })
    const result = await pool.query('SELECT * FROM ok_console.local_access_audit')
    expect(result.rowCount).toBe(1)
    expect(result.rows[0]).toMatchObject({ authentication_method: 'BreakGlass', outcome: 'Denied', correlation_id: 'corr-pg-1' })
    expect(JSON.stringify(result.rows[0])).not.toContain('recovery-admin')
  })
})
