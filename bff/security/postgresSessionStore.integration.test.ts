// @vitest-environment node

import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SessionEnvelopeCodec } from './envelope.mjs'
import { PostgresOidcTransactionStore } from './oidcTransactionStore.mjs'
import { PostgresSessionStore, SessionStoreError } from './postgresSessionStore.mjs'
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
  })

  beforeEach(async () => {
    await pool.query('TRUNCATE ok_console.sessions, ok_console.oidc_transactions')
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
})
