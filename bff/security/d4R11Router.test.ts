// @vitest-environment node
import { Pool } from 'pg'
import { ObservedStateContractError } from '../adapters/openKubesObservedState.mjs'
import { createLocalAccessVerifier, PostgresLocalAccessThrottle } from './localAccess.mjs'
import { createServer } from 'node:http'
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { createConsoleBffHandler, prototypeAuthorizer } from '../app.mjs'
import { FixtureObservedStateAdapter } from '../adapters/fixtureObservedState.mjs'
import { PostgresAuthenticationAudit } from './authenticationAudit.mjs'
import { InMemorySessionStore } from './session.mjs'
import { createLocalAccessHttpHandler } from './localAccessHttp.mjs'

const base = '/api/console/v0'
const origin = 'https://console.invalid'
const identity = { subject: { id: 'subject', providerId: 'issuer', subjectId: 'opaque', displayName: 'Reader', method: 'OIDC', assurance: ['pwd'] }, scope: { environmentId: 'community-preview', tenantIds: ['tenant-platform'] }, permissions: ['platform.read'], authorizationRevision: 'revision' }
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const counted = () => {
  const generated: string[] = [], received: string[] = []
  return { generated, received, correlationId: () => {
    const value = `corr-00000000-0000-4000-8000-${String(generated.length + 1).padStart(12, '0')}`
    generated.push(value); return value
  }, requestObserver: (event: { correlationId: string }) => received.push(event.correlationId) }
}
const listen = async (options: object) => {
  const server = createServer(createConsoleBffHandler({ source: new FixtureObservedStateAdapter(), authorizer: prototypeAuthorizer, ...options }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}
const sameId = (counter: ReturnType<typeof counted>, response: Response) => {
  expect(counter.generated).toHaveLength(1)
  expect(counter.received).toEqual([counter.generated[0]])
  expect(response.headers.get('x-correlation-id')).toBe(counter.generated[0])
}

it.each(['GET', 'POST', 'DELETE'].flatMap(method => [false, true].map(failure => ({ method, failure }))))('K1 session router $method failure=$failure shares the independently generated id', async ({ method, failure }) => {
  const counter = counted(), store = new InMemorySessionStore()
  const issued = store.create(identity)
  const query = vi.fn(async () => { if (failure) throw new Error('audit unavailable'); return { rowCount: 1 } })
  const audit = new PostgresAuthenticationAudit({ pool: { query }, pepper: Buffer.alloc(32) })
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const url = await listen({ ...counter, sessionStore: store, expectedOrigin: origin, authenticationAudit: audit })
  const response = await fetch(url + base + '/auth/session' + (method === 'POST' ? '/rotate' : ''), { method, headers: { cookie: issued.cookie, origin, 'x-csrf-token': issued.csrfToken, 'x-correlation-id': 'client-ignored' } })
  expect(response.status).toBe(failure ? 503 : method === 'DELETE' ? 204 : 200)
  sameId(counter, response)
  expect(query).toHaveBeenCalledTimes(1)
  expect(query.mock.calls[0][1][0]).toBe(counter.generated[0])
  expect(log.mock.calls).toHaveLength(failure ? 1 : 0)
  if (failure) expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ correlationId: counter.generated[0], event: 'SESSION_FAILED', cause: 'AUDIT' })
})

it.each([false, true])('K1 local router failure=%s hands its recorded id to the real local handler', async failure => {
  const counter = counted(), observed: string[] = []
  const localAccessHandler = createLocalAccessHttpHandler({ expectedOrigin: origin, verifier: async (input: { correlationId: string }) => { observed.push(input.correlationId); if (failure) throw new Error('rejected'); return { cookie: 'cookie', csrfCookie: 'csrf', session: {} } } })
  const url = await listen({ ...counter, localAccessHandler })
  const response = await fetch(url + base + '/auth/local', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'reader', password: 'test', reason: 'recovery' }) })
  expect(response.status).toBe(failure ? 401 : 200)
  sameId(counter, response); expect(observed).toEqual([counter.generated[0]])
})

it.each([false, true])('K1 dry-run router failure=%s hands its recorded id to executor and response meta', async failure => {
  const counter = counted(), observed: string[] = []
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const url = await listen({ ...counter, dryRunExecutor: async (input: { correlationId: string }) => { observed.push(input.correlationId); if (failure) throw new Error('executor unavailable'); return {} } })
  const response = await fetch(url + base + '/operations/create-cluster/dry-run', { method: 'POST', body: JSON.stringify({ contract: {} }) })
  expect(response.status).toBe(failure ? 503 : 200)
  sameId(counter, response); expect(observed).toEqual([counter.generated[0]])
  expect((await response.json()).meta.correlationId).toBe(counter.generated[0])
  expect(log.mock.calls).toHaveLength(failure ? 1 : 0)
  if (failure) expect(JSON.parse(log.mock.calls[0][0]).correlationId).toBe(counter.generated[0])
})

it('K1 projection router hands its recorded id to projection response meta', async () => {
  const counter = counted(), url = await listen(counter)
  const response = await fetch(url + base + '/overview')
  expect(response.status).toBe(200); sameId(counter, response)
  expect((await response.json()).meta.correlationId).toBe(counter.generated[0])
})

it('K1 source failure router hands its recorded id to the source failure line', async () => {
  const counter = counted(), lines: string[] = []
  const url = await listen({ ...counter, source: { readSnapshot: async () => { throw new Error('source unavailable') } }, sourceFailureObserver: (line: string) => lines.push(line) })
  const response = await fetch(url + base + '/overview')
  expect(response.status).toBe(503); sameId(counter, response)
  expect((await response.json()).meta.correlationId).toBe(counter.generated[0])
  expect(lines).toHaveLength(1)
  expect(JSON.parse(lines[0]).correlationId).toBe(counter.generated[0])
})

// Direct invocation lets response-writing and projection faults be deterministic,
// while exercising the same app boundary and request lifecycle as a real socket.
const invoke = async (url: string, method: string, options: object = {}, failWrite = false) => {
  const counter = counted(), headers: Record<string, string> = {}
  let status = 0, first = true, body = ''
  const response = Object.assign(new EventEmitter(), { writeHead(value: number, values: Record<string, string>) {
    if (failWrite && first) { first = false; throw new Error('private response failure') }
    status = value; Object.assign(headers, values)
  }, end(value: string) { body = value } })
  const handler = createConsoleBffHandler({ source: new FixtureObservedStateAdapter(), authorizer: prototypeAuthorizer, ...counter, ...options })
  await handler({ url, method, headers: {} }, response)
  expect(counter.generated).toHaveLength(1)
  expect(headers['X-Correlation-ID']).toBe(counter.generated[0])
  expect(JSON.parse(body).meta.correlationId).toBe(counter.generated[0])
  return { status, id: counter.generated[0] }
}

it.each([
  [base + '/overview', 'GET'], [base + '/clusters', 'GET'], [base + '/clusters/id', 'GET'], [base + '/evidence/id', 'GET'],
  [base + '/session', 'GET'], [base + '/auth/session', 'GET'], [base + '/auth/session/rotate', 'POST'], [base + '/auth/session', 'DELETE'],
  [base + '/auth/oidc/start', 'GET'], [base + '/auth/oidc/callback', 'GET'], [base + '/operations/create-cluster/dry-run', 'POST'],
])('K6 catch-all logs unhandled route fault %s %s once at reached stage', async (url, method) => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const result = await invoke(url, method, { authorizer: () => { throw new Error('private authorizer failure') }, sessionStore: { resolve: async () => ({ subject: null }) }, oidcHandler: ({ pathname }: { pathname: string }) => { if (pathname.includes('/auth/oidc/')) throw new Error('outside named OIDC step'); return false } }, method !== 'GET' && url.includes('/auth/session'))
  expect(result.status).toBe(503)
  expect(log).toHaveBeenCalledTimes(1)
  expect(JSON.parse(log.mock.calls[0][0])).toEqual({ stage: 'REQUEST_RECEIVED', correlationId: result.id, event: 'REQUEST_FAILED', cause: 'OTHER', errorCode: 'OTHER', elapsedMs: expect.any(Number) })
})

it.each(['projection', 'response'])('K6 catch-all names AUTHZ_CHECKED for %s failure', async mode => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const result = await invoke(base + '/overview', 'GET', mode === 'projection' ? { source: { readSnapshot: async () => ({}) } } : {}, mode === 'response')
  expect(result.status).toBe(503); expect(log).toHaveBeenCalledTimes(1)
  expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ event: 'REQUEST_FAILED', stage: 'AUTHZ_CHECKED', correlationId: result.id, cause: 'OTHER', errorCode: 'OTHER' })
})

it('K6 named dependency rethrow is not double-logged by the catch-all', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const result = await invoke(base + '/auth/session', 'GET', { sessionStore: { resolve: async () => { throw new Error('store unavailable') } } })
  expect(result.status).toBe(503); expect(log).toHaveBeenCalledTimes(1)
  expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ event: 'SESSION_FAILED', cause: 'SESSION_STORE', correlationId: result.id })
})

it.each(['SESSION_STORE', 'SESSION_ROTATE', 'SESSION_REVOKE'].flatMap(cause => ['SESSION_ROTATE_COMMIT', 'SESSION_REVOKE_COMMIT', 'foreign', undefined].map(step => ({ cause, step }))))('K4 session step guard bounds $cause with step=$step', async ({ cause, step }) => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const counter = counted(), store = new InMemorySessionStore(), issued = store.create(identity)
  const failure = async () => { throw Object.assign(new Error('private store failure'), { step }) }
  if (cause === 'SESSION_STORE') vi.spyOn(store, 'resolve').mockImplementation(failure)
  if (cause === 'SESSION_ROTATE') vi.spyOn(store, 'rotate').mockImplementation(failure)
  if (cause === 'SESSION_REVOKE') vi.spyOn(store, 'revoke').mockImplementation(failure)
  const url = await listen({ ...counter, sessionStore: store, expectedOrigin: origin })
  const method = cause === 'SESSION_STORE' ? 'GET' : cause === 'SESSION_ROTATE' ? 'POST' : 'DELETE'
  const response = await fetch(url + base + '/auth/session' + (method === 'POST' ? '/rotate' : ''), { method, headers: { cookie: issued.cookie, origin, 'x-csrf-token': issued.csrfToken } })
  expect(response.status).toBe(503); sameId(counter, response)
  const expected = cause === 'SESSION_ROTATE' && step === 'SESSION_ROTATE_COMMIT' || cause === 'SESSION_REVOKE' && step === 'SESSION_REVOKE_COMMIT' ? step : cause
  expect(log).toHaveBeenCalledTimes(1)
  expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ event: 'SESSION_FAILED', cause: expected, correlationId: counter.generated[0] })
})

it('K6 catch-all logs a later response failure after a swallowed named failure', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const result = await invoke(base + '/auth/session', 'GET', { sessionStore: { resolve: async () => null }, authenticationAudit: { record: async () => { throw new Error('private audit failure') } } }, true)
  expect(result.status).toBe(503)
  expect(log.mock.calls.map(call => JSON.parse(call[0]).event)).toEqual(['SESSION_FAILED', 'REQUEST_FAILED'])
  expect(log.mock.calls.map(call => JSON.parse(call[0]).cause)).toEqual(['AUDIT', 'OTHER'])
})

it('K6 compensation logs its failure and keeps the original AUDIT line', async () => {
  const store = new InMemorySessionStore(), issued = store.create(identity), counter = counted()
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const audit = { record: async () => { throw new Error('audit unavailable') } }
  const revoke = vi.spyOn(store, 'revoke').mockRejectedValue(new Error('revoke unavailable'))
  const url = await listen({ ...counter, sessionStore: store, expectedOrigin: origin, authenticationAudit: audit })
  const response = await fetch(url + base + '/auth/session/rotate', { method: 'POST', headers: { origin, cookie: issued.cookie, 'x-csrf-token': issued.csrfToken } })
  expect(response.status).toBe(503); sameId(counter, response)
  expect(revoke).toHaveBeenCalledTimes(1)
  expect(revoke.mock.calls[0][1]).toBe('AUDIT_FAILED')
  const lines = log.mock.calls.map(call => JSON.parse(call[0]))
  expect(lines.map(line => line.cause)).toEqual(['AUDIT', 'SESSION_ROTATE_COMPENSATION'])
  for (const line of lines) expect(line).toMatchObject({ event: 'SESSION_FAILED', stage: 'REQUEST_RECEIVED', correlationId: counter.generated[0], errorCode: null, elapsedMs: expect.any(Number) })
})

it('L1 contract-error router shares one independently recorded id with the 502 body, header and REQUEST_RECEIVED', async () => {
  const counter = counted()
  const url = await listen({ ...counter, source: { readSnapshot: async () => { throw new ObservedStateContractError() } } })
  const response = await fetch(url + base + '/overview')
  expect(response.status).toBe(502); sameId(counter, response)
  const body = await response.json()
  expect(body.error.code).toBe('CONTRACT_INCOMPATIBLE')
  expect(body.meta.correlationId).toBe(counter.generated[0])
})

it('K6 L3 local route through real verifier, HTTP handler and refused pg pool logs the reached step once', async () => {
  const pool = new Pool({ host: '127.0.0.1', port: 1, connectionTimeoutMillis: 500 })
  cleanup.push(() => pool.end())
  const counter = counted(), log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const verifier = createLocalAccessVerifier({ mode: 'Bootstrap', accounts: [], sessionStore: { create() {} }, throttle: new PostgresLocalAccessThrottle({ pool, pepper: Buffer.alloc(32) }) })
  const url = await listen({ ...counter, localAccessHandler: createLocalAccessHttpHandler({ verifier, expectedOrigin: origin }) })
  const response = await fetch(url + base + '/auth/local', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'reader', password: 'fixture', reason: 'local recovery test' }) })
  expect(response.status).toBe(503); sameId(counter, response)
  expect((await response.json()).error.code).toBe('LOCAL_ACCESS_UNAVAILABLE')
  expect(log).toHaveBeenCalledTimes(1)
  expect(JSON.parse(log.mock.calls[0][0])).toEqual({ event: 'LOCAL_ACCESS_FAILED', stage: 'REQUEST_RECEIVED', correlationId: counter.generated[0], cause: 'THROTTLE_CHECK', errorCode: 'ECONNREFUSED', elapsedMs: expect.any(Number) })
})

it('L1 ConsoleBffError body and header share the independently generated id', async () => {
  const counter = counted(), url = await listen({ ...counter, authorizer: async () => ({ allowed: false }) })
  const response = await fetch(url + base + '/overview')
  expect(response.status).toBe(403); sameId(counter, response)
  expect((await response.json()).meta.correlationId).toBe(counter.generated[0])
})

it('L1 lifecycle REQUEST_RECEIVED shares the independently generated id', async () => {
  const previous = process.env.OK_CONSOLE_TRACE
  process.env.OK_CONSOLE_TRACE = 'stages'
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    const counter = counted(), url = await listen(counter)
    const response = await fetch(url + base + '/overview'); await response.text()
    sameId(counter, response)
    const received = log.mock.calls.map(call => JSON.parse(call[0])).filter(line => line.stage === 'REQUEST_RECEIVED')
    expect(received).toHaveLength(1); expect(received[0].correlationId).toBe(counter.generated[0])
  } finally { if (previous === undefined) delete process.env.OK_CONSOLE_TRACE; else process.env.OK_CONSOLE_TRACE = previous }
})
