// @vitest-environment node
import { createServer } from 'node:http'
import { scrypt, scryptSync } from 'node:crypto'
import { promisify } from 'node:util'
import { currentLifecycle } from '../diagnostics.mjs'
import { Pool } from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import { createConsoleBffHandler, prototypeAuthorizer } from '../app.mjs'
import { FixtureObservedStateAdapter } from '../adapters/fixtureObservedState.mjs'
import { createDiagnosticRuntime } from '../test-fixtures/d4R12Runtime.mjs'
import { createLocalAccessVerifier, LocalAccessError, PostgresLocalAccessAudit, PostgresLocalAccessThrottle } from './localAccess.mjs'
import { createLocalAccessHttpHandler } from './localAccessHttp.mjs'
import { InMemorySessionStore } from './session.mjs'
import { PostgresSessionStore } from './postgresSessionStore.mjs'
import { SessionEnvelopeCodec } from './envelope.mjs'

const origin = 'https://console.invalid', base = '/api/console/v0'
const salt = Buffer.alloc(16, 9), password = 'disposable password'
const account = { username: 'reader', enabled: true, salt: salt.toString('base64'), verifier: scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('base64'), identityId: 'reader', displayName: 'Reader', environmentId: 'community-preview', tenantIds: ['platform'], permissions: ['platform.read'] }
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const listen = async (options: object) => {
  const server = createServer(createConsoleBffHandler({ source: new FixtureObservedStateAdapter(), authorizer: prototypeAuthorizer, ...options }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}
const counter = () => {
  const generated: string[] = [], received: string[] = []
  return { generated, received, correlationId() { const id = `corr-00000000-0000-4000-8000-${String(generated.length + 1).padStart(12, '0')}`; generated.push(id); return id }, requestObserver: (event: { correlationId: string }) => received.push(event.correlationId) }
}

it.each([
  ['blocked', 'THROTTLE_CHECK'], ['failure', 'THROTTLE_FAILURE'], ['success', 'THROTTLE_RESET'],
  ['blocked-audit', 'AUDIT'], ['rejected-audit', 'AUDIT'], ['granted-audit', 'AUDIT'],
  ['create', 'SESSION_STORE'], ['kdf', 'KDF'], ['compensation', 'AUDIT'], ['compensation-ok', 'AUDIT'], ['compensation-absent', 'AUDIT'],
])('L3 real local verifier preserves cause at %s and names %s', async (mode, step) => {
  const pool = new Pool({ host: '127.0.0.1', port: 1, connectionTimeoutMillis: 500 })
  cleanup.push(() => pool.end())
  const pepper = Buffer.alloc(32), pgThrottle = new PostgresLocalAccessThrottle({ pool, pepper }), pgAudit = new PostgresLocalAccessAudit({ pool, pepper })
  const pgStore = new PostgresSessionStore({ pool, codec: new SessionEnvelopeCodec({ primaryKeyId: 'key', keys: { key: Buffer.alloc(32) } }), deploymentEpoch: 'epoch' })
  const store = new InMemorySessionStore()
  const revoke = vi.spyOn(store, 'revoke')
  if (!['compensation-ok', 'compensation-absent'].includes(mode)) revoke.mockImplementation(() => pool.query('SELECT 1'))
  if (mode === 'compensation-absent') Object.defineProperty(store, 'revoke', { value: undefined })
  const throttle = { blocked: async () => mode === 'blocked-audit', failure: async () => {}, success: async () => {} }
  if (mode === 'blocked') throttle.blocked = () => pgThrottle.blocked('reader')
  if (mode === 'failure') throttle.failure = () => pgThrottle.failure('reader')
  if (mode === 'success') throttle.success = () => pgThrottle.success('reader')
  const verifier = createLocalAccessVerifier({ mode: 'Bootstrap', accounts: [account], throttle, sessionStore: mode === 'create' ? pgStore : store, authorizationRevision: 'revision', audit: ['blocked-audit', 'rejected-audit', 'granted-audit', 'compensation', 'compensation-ok', 'compensation-absent'].includes(mode) ? (event: object) => pgAudit.record(event) : async () => {}, ...(mode === 'kdf' ? { derive: () => promisify(scrypt)(password, salt, -1) } : {}) })
  const ids = counter(), log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const url = await listen({ ...ids, localAccessHandler: createLocalAccessHttpHandler({ verifier, expectedOrigin: origin }) })
  const response = await fetch(url + base + '/auth/local', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'reader', password: ['failure', 'rejected-audit'].includes(mode) ? 'wrong' : password, reason: 'local recovery exercise' }) })
  expect(response.status).toBe(503)
  expect((await response.json()).error.code).toBe('LOCAL_ACCESS_UNAVAILABLE')
  expect(ids.generated).toHaveLength(1); expect(ids.received).toEqual(ids.generated)
  expect(response.headers.get('x-correlation-id')).toBe(ids.generated[0])
  const lines = log.mock.calls.map(call => JSON.parse(call[0]))
  // Both granted-audit cases exercise a real failed compensating revoke.
  expect(lines).toHaveLength(['granted-audit', 'compensation'].includes(mode) ? 2 : 1)
  expect(lines[0]).toEqual({ event: 'LOCAL_ACCESS_FAILED', stage: 'REQUEST_RECEIVED', cause: step, errorCode: mode === 'kdf' ? 'OTHER' : 'ECONNREFUSED', correlationId: ids.generated[0], elapsedMs: expect.any(Number) })
  if (lines.length === 2) {
    expect(revoke).toHaveBeenCalledTimes(1); expect(revoke.mock.calls[0][1]).toBe('AUDIT_FAILED')
    expect(lines[1]).toMatchObject({ event: 'LOCAL_ACCESS_FAILED', stage: 'REQUEST_RECEIVED', cause: 'LOCAL_ACCESS_COMPENSATION', errorCode: 'ECONNREFUSED', correlationId: ids.generated[0] })
  }
})

it('L3 rejected credentials keep the 401 path silent', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const verifier = createLocalAccessVerifier({ mode: 'Bootstrap', accounts: [], throttle: { blocked: async () => false, failure: async () => {} }, sessionStore: { create() {} } })
  const url = await listen({ localAccessHandler: createLocalAccessHttpHandler({ verifier, expectedOrigin: origin }) })
  const response = await fetch(url + base + '/auth/local', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'reader', password, reason: 'local recovery exercise' }) })
  expect(response.status).toBe(401); expect((await response.json()).error.code).toBe('LOCAL_ACCESS_REJECTED'); expect(log).not.toHaveBeenCalled()
})

it('L3 unavailable unknown step stays bounded', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const url = await listen({ localAccessHandler: createLocalAccessHttpHandler({ expectedOrigin: origin, verifier: async () => { throw new LocalAccessError('LOCAL_ACCESS_UNAVAILABLE', { step: 'private foreign step' }) } }) })
  const response = await fetch(url + base + '/auth/local', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' })
  expect(response.status).toBe(503); expect(log).toHaveBeenCalledTimes(1)
  expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ cause: 'OTHER', errorCode: null })
})

it.each([['GET', '/overview'], ['POST', '/operations/create-cluster/dry-run']])('L4 production authorizer refused pool on %s %s uses shared classifier', async (method, path) => {
  const runtime = await createDiagnosticRuntime(1)
  cleanup.push(() => runtime.close())
  const ids = counter(), log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const url = await listen({ ...runtime, ...ids })
  const response = await fetch(url + base + path, { method, headers: { cookie: '__Host-ok_console_session=' + 'a'.repeat(43) } })
  expect(response.status).toBe(503); expect(ids.generated).toHaveLength(1); expect(ids.received).toEqual(ids.generated)
  expect(log).toHaveBeenCalledTimes(1)
  expect(JSON.parse(log.mock.calls[0][0])).toEqual({ stage: 'REQUEST_RECEIVED', correlationId: ids.generated[0], event: 'REQUEST_FAILED', cause: 'OTHER', errorCode: 'ECONNREFUSED', elapsedMs: expect.any(Number) })
})

it('L3 unavailable line uses the lifecycle stage reached before local handling', async () => {
  const pool = new Pool({ host: '127.0.0.1', port: 1, connectionTimeoutMillis: 500 })
  cleanup.push(() => pool.end())
  const verifier = createLocalAccessVerifier({ mode: 'Bootstrap', accounts: [], throttle: new PostgresLocalAccessThrottle({ pool, pepper: Buffer.alloc(32) }), sessionStore: { create() {} } })
  const handler = createLocalAccessHttpHandler({ verifier, expectedOrigin: origin })
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const url = await listen({ localAccessHandler: (input: object) => { currentLifecycle()?.mark('AUTHZ_CHECKED'); return handler(input) } })
  const response = await fetch(url + base + '/auth/local', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'reader', password, reason: 'local recovery exercise' }) })
  expect(response.status).toBe(503); expect(log).toHaveBeenCalledTimes(1)
  expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ stage: 'AUTHZ_CHECKED', cause: 'THROTTLE_CHECK', errorCode: 'ECONNREFUSED' })
})

it.each([undefined, null, false, 0, ''])('L3 compensation logs even an absent thrown code (%s)', async value => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const verifier = createLocalAccessVerifier({ mode: 'Bootstrap', accounts: [account], throttle: { blocked: async () => false, success: async () => {} }, sessionStore: { create: async () => ({ cookie: 'cookie' }), revoke: async () => { throw value } }, derive: async () => Buffer.from(account.verifier, 'base64'), audit: async () => { throw new Error('audit unavailable') } })
  const url = await listen({ localAccessHandler: createLocalAccessHttpHandler({ verifier, expectedOrigin: origin }) })
  const response = await fetch(url + base + '/auth/local', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'reader', password, reason: 'local recovery exercise' }) })
  expect(response.status).toBe(503)
  expect(log.mock.calls.map(call => JSON.parse(call[0]))).toEqual([
    expect.objectContaining({ cause: 'AUDIT', errorCode: null }),
    expect.objectContaining({ cause: 'LOCAL_ACCESS_COMPENSATION', errorCode: null }),
  ])
})
