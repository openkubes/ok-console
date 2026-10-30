// @vitest-environment node
import { createServer, type Socket } from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import { PostgresSessionStore } from './postgresSessionStore.mjs'
import { handleSessionHttp } from './httpSession.mjs'
import { digestSessionValue } from './session.mjs'
import { pgQuery } from './pgFailure.mjs'
import { startErrorCode } from './oidc.mjs'
const exec = promisify(execFile)
const id = 'corr-00000000-0000-4000-8000-000000000001'
const cookie = '__Host-ok_console_session=' + 'a'.repeat(43)
const codec = { encrypt: () => ({ ciphertext: 'cipher', keyId: 'key' }), decrypt: () => ({}) }
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const serve = async (query: (socket: Socket, number: number, data: Buffer) => void) => {
  const sockets = new Set<Socket>(); let opened = 0
  const server = createServer(socket => {
    const number = ++opened; sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket))
    let started = false
    socket.on('data', data => {
      if (!started) { started = true; socket.write(Buffer.from('5200000008000000005a0000000549', 'hex')); return }
      query(socket, number, data)
    })
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  cleanup.push(() => new Promise<void>(done => { for (const socket of sockets) socket.destroy(); server.close(() => done()) }))
  const pool = new Pool({ host: '127.0.0.1', port: (server.address() as { port: number }).port, user: 'x', database: 'x', query_timeout: 300, connectionTimeoutMillis: 1000, max: 1 })
  cleanup.push(() => pool.end())
  return { pool, count: () => opened }
}
const complete = Buffer.from('430000000d53454c4543542031005a0000000549', 'hex')
it.each(['rotate', 'revoke'])('J3 real pg client against protocol-level fake %s timeout evicts poisoned client without queued rollback', async operation => {
  const queries: string[] = []
  const { pool, count } = await serve((socket, number, data) => {
    queries.push(data.toString('latin1'))
    if (number === 1 && !data.includes(Buffer.from('BEGIN'))) return
    socket.write(complete)
  })
  const store = new PostgresSessionStore({ pool, codec, deploymentEpoch: 'epoch-123' })
  const began = performance.now()
  await expect(store[operation](cookie)).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE', cause: { code: 'PG_QUERY_TIMEOUT' } })
  expect(performance.now() - began).toBeLessThan(550)
  expect(queries.some(query => query.includes('ROLLBACK'))).toBe(false)
  expect(pool.idleCount).toBe(0)
  expect(pool.totalCount).toBe(0)
  await expect(pool.query('SELECT 1')).resolves.toMatchObject({ command: 'SELECT' })
  expect(count()).toBe(2)
})
it.each(['GET', 'POST', 'DELETE'])('J6 real session store %s failure emits one bounded correlated line', async method => {
  const { pool } = await serve(() => {})
  const sessionStore = new PostgresSessionStore({ pool, codec, deploymentEpoch: 'epoch-123' })
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  await expect(handleSessionHttp({ request: { method, headers: { cookie } }, response: {}, correlationId: id, pathname: '/api/console/v0/auth/session' + (method === 'POST' ? '/rotate' : ''), sessionStore })).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' })
  expect(log).toHaveBeenCalledTimes(1)
  expect(JSON.parse(log.mock.calls[0][0])).toEqual({ stage: 'REQUEST_RECEIVED', correlationId: id, event: 'SESSION_FAILED', cause: 'SESSION_STORE', errorCode: 'PG_QUERY_TIMEOUT', elapsedMs: expect.any(Number) })
  const elapsed = JSON.parse(log.mock.calls[0][0]).elapsedMs
  expect(elapsed).toBeGreaterThanOrEqual(250); expect(elapsed).toBeLessThan(800)
})
it.each(['rotate', 'revoke', 'audit'])('J6 session %s failure names its own operation', async operation => {
  const { pool } = await serve(() => {})
  const token = 'csrf-token'
  const context = { csrfDigest: digestSessionValue(token), subject: { method: 'OIDC' } }
  const failure = () => pgQuery(pool, 'SELECT 1')
  const sessionStore = { resolve: async () => context, rotate: operation === 'rotate' ? failure : async () => ({ cookie, session: {}, csrfCookie: '' }), revoke: operation === 'revoke' ? failure : async () => true }
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const response = { writeHead: vi.fn(), end: vi.fn() }
  const request = { method: operation === 'rotate' ? 'POST' : operation === 'revoke' ? 'DELETE' : 'GET', headers: { cookie, origin: 'https://console.invalid', 'x-csrf-token': token } }
  const input = { request, response, correlationId: id, pathname: '/api/console/v0/auth/session' + (operation === 'rotate' ? '/rotate' : ''), expectedOrigin: 'https://console.invalid', sessionStore, audit: operation === 'audit' ? failure : async () => {} }
  if (operation === 'audit') { await handleSessionHttp(input); expect(response.writeHead.mock.calls[0][0]).toBe(503) }
  else await expect(handleSessionHttp(input)).rejects.toThrow()
  expect(log).toHaveBeenCalledTimes(1)
  expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ cause: operation === 'audit' ? 'AUDIT' : operation === 'rotate' ? 'SESSION_ROTATE' : 'SESSION_REVOKE', errorCode: 'PG_QUERY_TIMEOUT' })
})
it.each([['refused', 'ECONNREFUSED'], ['silent', 'OAUTH_TIMEOUT'], ['badstate', 'OAUTH_INVALID_RESPONSE'], ['grant', 'OAUTH_RESPONSE_BODY_ERROR']])('J2 real openid-client token exchange %s has distinct code %s', async (mode, code) => {
  const { stdout } = await exec(process.execPath, ['bff/test-fixtures/oidcTokenEndpoint.mjs', mode], { timeout: 12000 })
  const result = JSON.parse(stdout.slice(stdout.indexOf('{')))
  expect(result.status).toBe(401)
  expect(JSON.parse(result.lines[0])).toMatchObject({ cause: 'TOKEN_EXCHANGE', errorCode: code })
}, 15000)
it('K8g injected-error J4 SQLSTATE 57014 maps by code, never message; other SQLSTATE codes survive', async () => {
  for (const [code, message, expected] of [['57014', 'private unrelated text', 'PG_STATEMENT_TIMEOUT'], ['57P01', 'canceling statement due to statement timeout', '57P01'], [undefined, 'canceling statement due to statement timeout', null]]) {
    const error = Object.assign(new Error(message), code ? { code } : {})
    const actual = await pgQuery({ query: async () => { throw error } }).catch(error => startErrorCode(error))
    expect(actual).toBe(expected)
  }
})
it.each([
  ['GET', 'missing'], ['GET', 'verified'], ['POST', 'missing'], ['POST', 'csrf'], ['POST', 'verified'], ['DELETE', 'missing'], ['DELETE', 'csrf'], ['DELETE', 'verified'],
])('J6 real audit outage on %s session %s path emits one AUDIT line', async (method, path) => {
  const { pool } = await serve(() => {})
  const token = 'csrf-token'
  const context = { csrfDigest: digestSessionValue(token), subject: { method: 'OIDC' } }
  const sessionStore = { resolve: async () => path === 'missing' ? null : context, rotate: async () => ({ cookie, session: {}, csrfCookie: '' }), revoke: async () => true }
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const response = { writeHead: vi.fn(), end: vi.fn() }
  await handleSessionHttp({ request: { method, headers: { cookie, origin: 'https://console.invalid', 'x-csrf-token': path === 'csrf' ? 'wrong' : token } }, response, correlationId: id, pathname: '/api/console/v0/auth/session' + (method === 'POST' ? '/rotate' : ''), expectedOrigin: 'https://console.invalid', sessionStore, audit: () => pgQuery(pool, 'SELECT 1') })
  expect(log).toHaveBeenCalledTimes(1)
  expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ cause: 'AUDIT', errorCode: 'PG_QUERY_TIMEOUT' })
  expect(response.writeHead.mock.calls[0][0]).toBe(path === 'missing' ? 401 : path === 'csrf' ? 403 : 503)
})
it.each(['rotate', 'revoke'])('J5 real pg client against protocol-level fake %s connection failure retains PG_CONNECT_TIMEOUT', async operation => {
  const sockets = new Set<Socket>()
  const server = createServer(socket => { sockets.add(socket); socket.on('error', () => {}) })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  cleanup.push(() => new Promise<void>(done => { for (const socket of sockets) socket.destroy(); server.close(() => done()) }))
  const pool = new Pool({ host: '127.0.0.1', port: (server.address() as { port: number }).port, user: 'x', database: 'x', connectionTimeoutMillis: 250 })
  cleanup.push(() => pool.end())
  const store = new PostgresSessionStore({ pool, codec, deploymentEpoch: 'epoch-123' })
  const error = await store[operation](cookie).catch((error: unknown) => error)
  expect(error).toMatchObject({ code: 'STORE_UNAVAILABLE', cause: { code: 'PG_CONNECT_TIMEOUT' } })
  expect(startErrorCode(error)).toBe('PG_CONNECT_TIMEOUT')
})
it('J5 real pg client against protocol-level fake duplicate SQLSTATE preserves SESSION_COLLISION and its original cause', async () => {
  const body = Buffer.from('SERROR\0VERROR\0C23505\0Mduplicate\0\0')
  const header = Buffer.alloc(5); header.write('E'); header.writeInt32BE(body.length + 4, 1)
  const { pool } = await serve(socket => socket.write(Buffer.concat([header, body, Buffer.from('5a0000000549', 'hex')])))
  const store = new PostgresSessionStore({ pool, codec, deploymentEpoch: 'epoch-123' })
  await expect(store.resolve(cookie)).rejects.toMatchObject({ code: 'SESSION_COLLISION', cause: { code: '23505' } })
})
it('J6 session failure reports reached lifecycle stage rather than a fixed default', async () => {
  const { createLifecycle, withLifecycle } = await import('../diagnostics.mjs')
  const { pool } = await serve(() => {})
  const sessionStore = new PostgresSessionStore({ pool, codec, deploymentEpoch: 'epoch-123' })
  const lifecycle = createLifecycle(id); lifecycle.mark('AUTHZ_CHECKED')
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  await expect(withLifecycle(lifecycle, () => handleSessionHttp({ request: { method: 'GET', headers: { cookie } }, response: {}, correlationId: id, pathname: '/api/console/v0/auth/session', sessionStore }))).rejects.toThrow()
  expect(JSON.parse(log.mock.calls[0][0]).stage).toBe('AUTHZ_CHECKED')
})
