// @vitest-environment node
import { createServer, type Server, type Socket } from 'node:net'
import { createRequire } from 'node:module'
import { afterEach, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import { pgQuery } from './pgFailure.mjs'
import { PostgresAuthenticationAudit } from './authenticationAudit.mjs'
import { PostgresOidcTransactionStore } from './oidcTransactionStore.mjs'
import { createOidcHttpHandler } from './oidc.mjs'

const id = 'corr-00000000-0000-4000-8000-000000000000'
const event = { method: 'OIDC', outcome: 'Started', cause: 'REQUESTED', correlationId: id, reason: 'Federated sign-in requested' }
const protocol = { codeVerifier: () => 'verifier-123', state: () => 'state-123', nonce: () => 'nonce-123', challenge: async () => 'challenge', authorizationUrl: () => new URL('https://issuer.invalid/') }
const codec = { encrypt: () => ({ ciphertext: 'cipher', keyId: 'key' }), decrypt: () => ({}) }
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const serve = async (accept: (socket: Socket) => void) => {
  const sockets = new Set<Socket>()
  const server = createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); accept(socket) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve, reject) => { for (const socket of sockets) socket.destroy(); server.close(error => error ? reject(error) : resolve()) }))
  return server
}
const poolFor = (server: Server, max = 1) => {
  const pool = new Pool({ host: '127.0.0.1', port: (server.address() as { port: number }).port, user: 'x', database: 'x', connectionTimeoutMillis: 80, max })
  cleanup.push(() => pool.end())
  return pool
}
const run = async (pool: Pick<Pool, 'query'>, auditMode: boolean, header = '', invalid = false, throwHead = false) => {
  const audit = new PostgresAuthenticationAudit({ pool, pepper: Buffer.alloc(32) })
  const store = new PostgresOidcTransactionStore({ pool, codec, deploymentEpoch: 'epoch-123' })
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  let status = 0, first = true
  const handler = createOidcHttpHandler({ protocol, transactionStore: auditMode ? { create: async () => ({ cookie: 'cookie' }) } : store, sessionStore: {}, identityMapper: () => null, redirectUri: 'https://console.invalid/callback', audit: (input: object) => audit.record(invalid ? { ...input, correlationId: 'x'.repeat(129) } : input) })
  await handler({ request: { method: 'GET', headers: { 'x-correlation-id': header } }, correlationId: id, pathname: '/api/console/v0/auth/oidc/start', response: { writeHead(value: number) { if (throwHead && first) { first = false; throw new Error('response write failed') } status = value }, end() {} } })
  const lines = log.mock.calls.map(call => JSON.parse(call[0]))
  log.mockRestore()
  console.info('D4_R8_PG ' + JSON.stringify({ status, lines }))
  return { status, lines }
}

it('pins the pg outage message contract to pg 8.23.0', () => {
  const require = createRequire(import.meta.url)
  expect(require('pg/package.json').version).toBe('8.23.0')
  expect(require('../../package.json').dependencies.pg).toBe('8.23.0')
})
it('server correlation protects real audit from a 129 character client header and distinguishes invalid audit input from outage', async () => {
  const query = vi.fn(async () => ({ rowCount: 1 }))
  const healthy = await run({ query } as unknown as Pool, true, 'x'.repeat(129))
  expect(healthy).toEqual({ status: 302, lines: [] })
  expect(query.mock.calls[0]).toEqual([expect.any(String), [id, 'OIDC', 'Started', 'REQUESTED', null, 'Federated sign-in requested']])
  const invalid = await run({ query } as unknown as Pool, true, '', true)
  expect(invalid.status).toBe(503)
  expect(invalid.lines).toEqual([expect.objectContaining({ cause: 'AUDIT', errorCode: 'AUDIT_INPUT_INVALID' })])
  expect(query).toHaveBeenCalledTimes(1)
  const pool = poolFor(await serve(() => {}))
  const outage = await run(pool, true)
  expect(outage.lines[0]).toMatchObject({ cause: 'AUDIT', errorCode: 'PG_CONNECT_TIMEOUT' })
  expect(invalid.lines[0]).not.toEqual(outage.lines[0])
})
it('labels response writeHead failure OTHER after successful audit', async () => {
  const result = await run({ query: async () => ({ rowCount: 1 }) } as unknown as Pool, true, '', false, true)
  expect(result).toEqual({ status: 503, lines: [expect.objectContaining({ cause: 'OTHER', errorCode: null })] })
})
it.each([false, true])('names real pg connect timeout, termination and pool acquisition at audit=%s', async auditMode => {
  const silent = poolFor(await serve(() => {}))
  expect((await run(silent, auditMode)).lines[0]).toMatchObject({ cause: auditMode ? 'AUDIT' : 'TRANSACTION_STORE', errorCode: 'PG_CONNECT_TIMEOUT' })
  const terminated = poolFor(await serve(socket => socket.destroy()))
  expect((await run(terminated, auditMode)).lines[0]).toMatchObject({ cause: auditMode ? 'AUDIT' : 'TRANSACTION_STORE', errorCode: 'PG_CONNECTION_TERMINATED' })
  const busy = poolFor(await serve(socket => socket.once('data', () => socket.write(Buffer.from('5200000008000000005a0000000549', 'hex')))))
  const held = await busy.connect()
  try {
    expect((await run(busy, auditMode)).lines[0]).toMatchObject({ cause: auditMode ? 'AUDIT' : 'TRANSACTION_STORE', errorCode: 'PG_POOL_TIMEOUT' })
  } finally { held.release() }
})
it.each([false, true])('bounds exact pg message matching at audit=%s', async auditMode => {
  for (const message of ['Connection terminated due to connection timeout', 'Connection terminated unexpectedly', 'timeout exceeded when trying to connect', 'Query read timeout']) {
    for (const error of [new Error(message + '.'), Object.assign(new Error(message), { code: '57P01' }), Object.create({ message }), { message: 42 }]) {
      await expect(pgQuery({ query: async () => { throw error } })).rejects.toBe(error)
      const result = await run({ query: async () => { throw error } } as unknown as Pool, auditMode)
      expect(result.lines[0].errorCode).toBe(Object.hasOwn(error, 'code') ? '57P01' : null)
    }
    const result = await run({ query: async () => { throw new Error(message) } } as unknown as Pool, false)
    expect(result.lines[0].errorCode).toMatch(/^PG_/)
    // The same text outside a pg wrapper carries no diagnostic code.
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await createOidcHttpHandler({ protocol: { codeVerifier: () => { throw new Error(message) } }, transactionStore: {}, sessionStore: {}, identityMapper: () => null, redirectUri: 'https://console.invalid/' })({ request: { method: 'GET', headers: {} }, response: { writeHead() {}, end() {} }, pathname: '/api/console/v0/auth/oidc/start', correlationId: 'corr-00000000-0000-4000-8000-000000000000' })
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ cause: 'PKCE', errorCode: null })
    log.mockRestore()
  }
})
it.each([null, {}, { ...event, method: 'foreign' }, { ...event, principal: 42 }, { ...event, reason: '' }, { ...event, correlationId: null }, { ...event, correlationId: 42 }])('names invalid audit input %j without a backend operation', async input => {
  const query = vi.fn()
  const audit = new PostgresAuthenticationAudit({ pool: { query }, pepper: Buffer.alloc(32) })
  await expect(audit.record(input)).rejects.toMatchObject({ code: 'AUDIT_INPUT_INVALID', cause: undefined })
  expect(query).not.toHaveBeenCalled()
})

it.each([false, true])('names real closed port with tiny connection timeout at audit=%s', async auditMode => {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  const pool = new Pool({ host: '127.0.0.1', port, user: 'x', database: 'x', connectionTimeoutMillis: 1 })
  cleanup.push(() => pool.end())
  const result = await run(pool, auditMode)
  expect(result.status).toBe(503)
  expect(result.lines[0].cause).toBe(auditMode ? 'AUDIT' : 'TRANSACTION_STORE')
  expect(['PG_CONNECT_TIMEOUT', 'ECONNREFUSED']).toContain(result.lines[0].errorCode)
})
