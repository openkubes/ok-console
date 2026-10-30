// @vitest-environment node
import { createServer as httpServer } from 'node:http'
import { createServer, type Socket } from 'node:net'
import { TLSSocket } from 'node:tls'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { X509Certificate } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import { createConsoleBffHandler } from '../app.mjs'
import { createOidcHttpHandler } from './oidc.mjs'
import { PostgresAuthenticationAudit } from './authenticationAudit.mjs'
import { PostgresSessionStore } from './postgresSessionStore.mjs'
import { PostgresOidcTransactionStore } from './oidcTransactionStore.mjs'
import { issueTestCertificate } from '../test-fixtures/certificates.mjs'

const id = 'corr-00000000-0000-4000-8000-000000000000'
const path = '/api/console/v0/auth/oidc/'
const transaction = { codeVerifier: 'verifier', state: 'state', nonce: 'nonce' }
const protocol = { codeVerifier: () => 'verifier', state: () => 'state', nonce: () => 'nonce', challenge: async () => 'challenge', authorizationUrl: () => new URL('https://issuer.invalid/'), exchange: async () => ({ sub: 'subject' }) }
const codec = { encrypt: () => ({ ciphertext: 'cipher', keyId: 'key' }), decrypt: () => transaction }
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const serve = async (accept: (socket: Socket) => void) => {
  const sockets = new Set<Socket>()
  const server = createServer(socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); accept(socket) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve, reject) => { for (const socket of sockets) socket.destroy(); server.close(error => error ? reject(error) : resolve()) }))
  return (server.address() as { port: number }).port
}
const poolFor = (port: number, options = {}) => {
  const pool = new Pool({ host: '127.0.0.1', port, user: 'x', database: 'x', connectionTimeoutMillis: 250, ...options })
  cleanup.push(() => pool.end())
  return pool
}
const handlerFor = (options = {}) => createOidcHttpHandler({ protocol, transactionStore: { create: async () => ({ cookie: 'cookie' }), consume: async () => transaction }, sessionStore: { create: async () => ({ cookie: 'cookie', csrfCookie: 'csrf' }) }, identityMapper: async () => ({}), redirectUri: 'https://console.invalid/callback', ...options })
const invoke = async (handler: ReturnType<typeof handlerFor>, route = 'callback', correlationId: unknown = id) => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  let status = 0
  try {
    await handler({ pathname: path + route, correlationId, request: { method: 'GET', url: path + route, headers: { 'x-correlation-id': 'x'.repeat(129), cookie: '__Host-ok_console_oidc=' + 'a'.repeat(43) } }, response: { writeHead(value: number) { status = value }, end() {} } })
    return { status, lines: log.mock.calls.map(call => JSON.parse(call[0])) }
  } finally { log.mockRestore() }
}

it.each(['start', 'callback', 'failure'])('H1 app router uses exactly one independently recorded server ID for %s', async route => {
  const query = vi.fn(async () => ({ rowCount: 1 }))
  const audit = new PostgresAuthenticationAudit({ pool: { query }, pepper: Buffer.alloc(32) })
  const generated: string[] = [], received: string[] = []
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const server = httpServer(createConsoleBffHandler({ source: {}, authorizer: () => ({}),
    correlationId: () => { const value = `corr-00000000-0000-4000-8000-${String(generated.length + 1).padStart(12, '0')}`; generated.push(value); return value },
    requestObserver: (event: { correlationId: string }) => received.push(event.correlationId),
    oidcHandler: handlerFor({ audit: (input: object) => audit.record(input), ...(route === 'failure' ? { protocol: { ...protocol, exchange: async () => { throw new Error('rejected') } } } : {}) }) }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}${path}${route === 'start' ? 'start' : 'callback'}`, { redirect: 'manual', headers: { 'x-correlation-id': 'x'.repeat(129) } })
  expect(response.status).toBe(route === 'start' ? 302 : route === 'callback' ? 303 : 401)
  expect(generated).toHaveLength(1)
  expect(received).toEqual([generated[0]])
  expect(response.headers.get('x-correlation-id')).toBe(generated[0])
  expect(query).toHaveBeenCalledTimes(1)
  expect(query.mock.calls[0][1][0]).toBe(generated[0])
  const lines = log.mock.calls.map(call => JSON.parse(call[0]))
  expect(lines).toHaveLength(route === 'failure' ? 1 : 0)
  for (const line of lines) expect(line.correlationId).toBe(generated[0])
})
it.each([undefined, null, '', 42, 'x'.repeat(129), 'corr-bad'])('H1 handler rejects missing or invalid correlation %j as wiring', async value => {
  const audit = vi.fn(), consume = vi.fn(), create = vi.fn()
  for (const route of ['start', 'callback']) {
    // Explicit undefined must reach the handler rather than invoke's default.
    const handler = handlerFor({ audit, transactionStore: { consume, create } })
    const result = await invoke((input: object) => handler({ ...input, correlationId: value }), route)
    expect(result).toEqual({ status: 503, lines: [{ stage: 'REQUEST_RECEIVED', correlationId: 'OTHER', event: route === 'start' ? 'OIDC_START_FAILED' : 'OIDC_CALLBACK_FAILED', cause: 'WIRING', errorCode: 'CORRELATION_MISSING' }] })
  }
  expect(audit).not.toHaveBeenCalled(); expect(consume).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled()
})
it.each(['missing', 'unmapped', 'verified', 'catch'])('H2 callback real audit uses server ID at %s site', async site => {
  const query = vi.fn(async () => ({ rowCount: 1 }))
  const audit = new PostgresAuthenticationAudit({ pool: { query }, pepper: Buffer.alloc(32) })
  const result = await invoke(handlerFor({ audit: (input: object) => audit.record(input), transactionStore: { consume: async () => site === 'missing' ? null : transaction }, identityMapper: async () => site === 'unmapped' ? null : {}, protocol: { ...protocol, exchange: async () => { if (site === 'catch') throw new Error('rejected'); return { sub: 'subject' } } } }))
  expect(result.status).toBe({ missing: 401, unmapped: 403, verified: 303, catch: 401 }[site])
  expect(query).toHaveBeenCalledTimes(1)
  expect(query.mock.calls[0][1][0]).toBe(id)
  expect(query.mock.calls[0][1][3]).toBe({ missing: 'TRANSACTION_INVALID', unmapped: 'UNMAPPED_SUBJECT', verified: 'VERIFIED', catch: 'CALLBACK_REJECTED' }[site])
})
it.each(['TRANSACTION_STORE', 'AUDIT'])('H3 callback real pool preserves %s failure and code', async step => {
  const pool = poolFor(await serve(() => {}))
  const audit = new PostgresAuthenticationAudit({ pool, pepper: Buffer.alloc(32) })
  const store = new PostgresOidcTransactionStore({ pool, codec, deploymentEpoch: 'epoch-123' })
  const result = await invoke(handlerFor(step === 'TRANSACTION_STORE' ? { transactionStore: store } : { audit: (input: object) => audit.record(input) }))
  expect(result.status).toBe(step === 'AUDIT' ? 503 : 401)
  expect(result.lines[0]).toEqual({ stage: 'REQUEST_RECEIVED', correlationId: id, event: 'OIDC_CALLBACK_FAILED', cause: step, errorCode: 'PG_CONNECT_TIMEOUT' })
  if (step === 'AUDIT') expect(result.lines[1]).toMatchObject({ cause: 'AUDIT', errorCode: 'PG_CONNECT_TIMEOUT' })
})
it.each(['TOKEN_EXCHANGE', 'SUBJECT_MAP', 'OTHER'])('H3 callback identifies %s and bounds deepest own code', async step => {
  const fail = () => { throw new Error('wrapper', { cause: Object.assign(new Error('private text'), { code: 'ECONNRESET' }) }) }
  const handler = handlerFor({ ...(step === 'TOKEN_EXCHANGE' ? { protocol: { ...protocol, exchange: fail } } : {}), ...(step === 'SUBJECT_MAP' ? { identityMapper: fail } : {}) })
  if (step === 'OTHER') {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    let first = true
    await handler({ pathname: path + 'callback', correlationId: id, request: { method: 'GET', url: '/callback', headers: {} }, response: { writeHead() { if (first) { first = false; fail() } }, end() {} } })
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ event: 'OIDC_CALLBACK_FAILED', cause: step, errorCode: 'ECONNRESET' })
    log.mockRestore()
  } else expect((await invoke(handler)).lines[0]).toMatchObject({ event: 'OIDC_CALLBACK_FAILED', cause: step, errorCode: 'ECONNRESET' })
})
it('H4 twelve concurrent starts with ten in-flight connects distinguish slot timeout', async () => {
  const pool = poolFor(await serve(() => {}), { max: 10 })
  const store = new PostgresOidcTransactionStore({ pool, codec, deploymentEpoch: 'epoch-123' })
  const handler = handlerFor({ transactionStore: store })
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const statuses: number[] = []
  try {
    await Promise.all(Array.from({ length: 12 }, (_, index) => handler({ pathname: path + 'start', correlationId: `corr-00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, request: { method: 'GET', headers: {} }, response: { writeHead(status: number) { statuses.push(status) }, end() {} } })))
    const lines = log.mock.calls.map(call => JSON.parse(call[0]))
    expect(statuses).toEqual(Array(12).fill(503))
    expect(lines.filter(line => line.errorCode === 'PG_CONNECT_TIMEOUT')).toHaveLength(10)
    expect(lines.filter(line => line.errorCode === 'PG_POOL_TIMEOUT')).toHaveLength(2)
    expect(new Set(lines.map(line => line.correlationId)).size).toBe(12)
    expect(lines.every(line => line.cause === 'TRANSACTION_STORE')).toBe(true)
    console.info('D4_R9_POOL ' + JSON.stringify(lines))
  } finally { log.mockRestore() }
})
it.each(['TRANSACTION_STORE', 'AUDIT'])('H5 silent query returns client timeout at %s within query_timeout', async step => {
  const port = await serve(socket => socket.once('data', () => socket.write(Buffer.from('5200000008000000005a0000000549', 'hex'))))
  const pool = poolFor(port, { query_timeout: 250 })
  const audit = new PostgresAuthenticationAudit({ pool, pepper: Buffer.alloc(32) })
  const store = new PostgresOidcTransactionStore({ pool, codec, deploymentEpoch: 'epoch-123' })
  const start = performance.now()
  const result = await invoke(handlerFor(step === 'TRANSACTION_STORE' ? { transactionStore: store } : { audit: (input: object) => audit.record(input) }), 'start')
  const elapsed = performance.now() - start
  expect(result.status).toBe(503)
  expect(result.lines[0]).toMatchObject({ cause: step, errorCode: 'PG_QUERY_TIMEOUT' })
  expect(elapsed).toBeGreaterThanOrEqual(200); expect(elapsed).toBeLessThan(1500)
  console.info('D4_R9_QUERY ' + JSON.stringify({ step, elapsed, lines: result.lines }))
})
it('H6 pins pg-pool 3.14.0 message owner', () => {
  const require = createRequire(import.meta.url)
  const pgRequire = createRequire(require.resolve('pg'))
  expect(JSON.parse(readFileSync(join(dirname(pgRequire.resolve('pg-pool')), 'package.json'), 'utf8')).version).toBe('3.14.0')
})
it('H6 production strict TLS pool geometries keep timeout termination and wrong CA distinct', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ok-d4-r9-'))
  cleanup.unshift(async () => rmSync(root, { recursive: true }))
  const openssl = (...args: string[]) => execFileSync('openssl', args, { cwd: root, stdio: 'ignore' })
  for (const name of ['ca', 'wrong', 'server']) {
    openssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', name + '.key', '-out', name + '.csr', '-subj', '/CN=' + (name === 'server' ? 'localhost' : name))
    issueTestCertificate({ root, name, issuer: name === 'server' ? 'ca' : name, selfSigned: name !== 'server', extensions: name === 'server' ? 'basicConstraints=CA:FALSE\nsubjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\n' : 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n' })
  }
  const cert = readFileSync(join(root, 'server.crt')), key = readFileSync(join(root, 'server.key'))
  const leaf = new X509Certificate(cert)
  expect(Date.parse(leaf.validFrom)).toBeLessThan(Date.now() - 3600000)
  expect(Date.parse(leaf.validTo)).toBeGreaterThan(Date.now() + 3600000)
  for (const geometry of ['ssl-silent', 'ssl-close', 'handshake-silent', 'startup-silent', 'startup-close', 'startup-destroy', 'wrong-ca']) {
    const port = await serve(socket => {
      if (geometry === 'ssl-silent') return
      socket.once('data', () => {
        if (geometry === 'ssl-close') { socket.destroy(); return }
        socket.write('S')
        if (geometry === 'handshake-silent') return
        const secure = new TLSSocket(socket, { isServer: true, cert, key })
        secure.on('error', () => {})
        secure.once('secure', () => {
          if (geometry === 'startup-close') secure.once('data', () => secure.end())
          if (geometry === 'startup-destroy') secure.once('data', () => socket.destroy())
        })
      })
    })
    const pool = poolFor(port, { ssl: { ca: readFileSync(join(root, geometry === 'wrong-ca' ? 'wrong.crt' : 'ca.crt')), rejectUnauthorized: true } })
    const store = new PostgresOidcTransactionStore({ pool, codec, deploymentEpoch: 'epoch-123' })
    const result = await invoke(handlerFor({ transactionStore: store }), 'start')
    console.info('D4_R9_TLS ' + JSON.stringify({ geometry, lines: result.lines }))
    expect(result.status).toBe(503)
    expect(result.lines[0]).toMatchObject({ cause: 'TRANSACTION_STORE', errorCode: geometry === 'wrong-ca' ? 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' : geometry.endsWith('close') || geometry.endsWith('destroy') ? 'PG_CONNECTION_TERMINATED' : 'PG_CONNECT_TIMEOUT' })
  }
}, 15000)

it.each(['missing', 'unmapped'])('H3 callback denial response failure is OTHER after successful %s audit', async site => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const audit = vi.fn(async () => {})
  let first = true
  try {
    await handlerFor({ audit, transactionStore: { consume: async () => site === 'missing' ? null : transaction }, identityMapper: async () => null })({ pathname: path + 'callback', correlationId: id, request: { method: 'GET', url: '/callback', headers: {} }, response: { writeHead() { if (first) { first = false; throw Object.assign(new Error('write failed'), { code: 'ECONNRESET' }) } }, end() {} } })
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({ stage: 'REQUEST_RECEIVED', correlationId: id, event: 'OIDC_CALLBACK_FAILED', cause: 'OTHER', errorCode: 'ECONNRESET' })
    expect(audit).toHaveBeenCalledTimes(2)
  } finally { log.mockRestore() }
})

it('J5 H3 callback real PostgresSessionStore preserves query failure cause', async () => {
  const port = await serve(socket => socket.once('data', () => socket.write(Buffer.from('5200000008000000005a0000000549', 'hex'))))
  const store = new PostgresSessionStore({ pool: poolFor(port, { query_timeout: 2000 }), codec, deploymentEpoch: 'epoch-123' })
  const authorization = { subject: { id: 'user', providerId: 'provider', subjectId: 'subject', displayName: 'User', method: 'OIDC', assurance: ['Federated'] }, scope: { environmentId: 'env', tenantIds: ['platform'] }, permissions: ['platform.read'], authorizationRevision: 'rev' }
  const result = await invoke(handlerFor({ sessionStore: store, identityMapper: async () => authorization }))
  expect(result.status).toBe(401)
  expect(result.lines[0]).toMatchObject({ cause: 'SESSION_STORE', errorCode: 'PG_QUERY_TIMEOUT' })
})
it.each(['missing', 'unmapped'])('J7 callback denial real audit failure names AUDIT at %s site', async site => {
  const pool = poolFor(await serve(() => {}))
  const audit = new PostgresAuthenticationAudit({ pool, pepper: Buffer.alloc(32) })
  const result = await invoke(handlerFor({ audit: (input: object) => audit.record(input), transactionStore: { consume: async () => site === 'missing' ? null : transaction }, identityMapper: async () => null }))
  expect(result.status).toBe(503)
  expect(result.lines).toHaveLength(2)
  expect(result.lines[0]).toMatchObject({ cause: 'AUDIT', errorCode: 'PG_CONNECT_TIMEOUT' })
  expect(result.lines[1]).toMatchObject({ cause: 'AUDIT', errorCode: 'PG_CONNECT_TIMEOUT' })
})
