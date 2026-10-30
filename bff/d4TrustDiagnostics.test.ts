// @vitest-environment node
import { captureFailureLine, captureFailure, captureChildFailureLines } from './test-fixtures/failureCapture'
import dns from 'node:dns'
import { X509Certificate } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as httpsServer, request as httpsRequest, type ServerOptions } from 'node:https'
import { createServer as tcpServer, type Socket } from 'node:net'
import { ClientRequest, type Server as HttpServer, type RequestListener } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { issueTestCertificate } from './test-fixtures/certificates.mjs'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import schema from '../contracts/presentation/v0alpha1/schema.json'
import { createObservedStateMtlsFetch } from './adapters/mtlsFetch.mjs'
import { createConsoleServer } from './server.mjs'
import { OpenKubesObservedStateAdapter } from './adapters/openKubesObservedState.mjs'
import { processClock } from './diagnostics.mjs'
import { classifySourceFailure } from './adapters/sourceFailure.mjs'
import { FixtureObservedStateAdapter } from './adapters/fixtureObservedState.mjs'

// The existing allOf branches omit local object types; strictTypes rejects them.
// Keep schema semantics/version unchanged while validating formats explicitly.
const ajv = new Ajv2020({ strict: true, strictTypes: false })
addFormats(ajv)
const validateResponse = ajv.compile(schema)

let root: string
let body: string
const canary = 'password=canary-TLS-private /private/issuer.pem SAN=secret.example 192.0.2.15'
const openssl = (...args: string[]) => execFileSync('openssl', args, { stdio: 'ignore', cwd: root })
const file = (name: string) => readFileSync(join(root, name))
const profile = { 'Content-Type': 'application/json; profile="observed.openkubes.io/v0alpha2"' }

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'ok-d4-tls-'))
  try {
    for (const ca of ['ca', 'wrong']) {
      openssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', ca + '.key', '-out', ca + '.csr', '-subj', '/CN=' + ca)
      issueTestCertificate({ root, name: ca, issuer: ca, selfSigned: true, extensions: 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n' })
    }
    for (const [name, usage] of [['server', 'serverAuth'], ['client', 'clientAuth'], ['expired', 'serverAuth'], ['future', 'serverAuth'], ['client-expired', 'clientAuth'], ['client-future', 'clientAuth'], ['client-wrong-eku', 'serverAuth']]) {
      openssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', name + '.key', '-out', name + '.csr', '-subj', '/CN=localhost')
      const extensions = `extendedKeyUsage=${usage}\nsubjectAltName=DNS:localhost\n`
      const expired = ['expired', 'client-expired'].includes(name)
      const future = ['future', 'client-future'].includes(name)
      issueTestCertificate({ root, name, extensions, ...(expired ? { startDate: '20200101000000Z', endDate: '20200102000000Z' } : future ? { startDate: '20400101000000Z', endDate: '20400102000000Z' } : {}) })
    }
    openssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'self.key', '-out', 'self.csr', '-subj', '/CN=localhost')
    issueTestCertificate({ root, name: 'self', issuer: 'self', selfSigned: true, extensions: 'basicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n' })
    openssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'nc.key', '-out', 'nc.csr', '-subj', '/CN=nc')
    openssl('req', '-new', '-key', 'nc.key', '-out', 'nc-good.csr', '-subj', '/CN=nc')
    for (const [name, permitted] of [['nc', 'example.org'], ['nc-good', 'localhost']]) {
      issueTestCertificate({ root, name, issuer: name, privateKey: 'nc.key', selfSigned: true, extensions: `basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nnameConstraints=critical,permitted;DNS:${permitted}\n` })
    }
    issueTestCertificate({ root, name: 'ncleaf', csr: 'server.csr', issuer: 'nc', extensions: 'extendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n' })
    const fixture = await new FixtureObservedStateAdapter().readSnapshot()
    body = JSON.stringify({ apiVersion: 'observed.openkubes.io/v0alpha2', kind: 'ConsoleObservedState', metadata: { observedAt: fixture.observedAt, sourceRevision: fixture.sourceRevision }, data: fixture })
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}, 30_000)
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }) })

const listen = async (server: HttpServer | ReturnType<typeof tcpServer>) => {
  const sockets = new Set<Socket>()
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing ephemeral test port')
  return { port: address.port, close: async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  } }
}
const producer = async (options: ServerOptions = {}, handler: RequestListener = (_req, res) => { res.writeHead(200, profile); res.end(body) }) => {
  let requests = 0
  const server = httpsServer({ key: file('server.key'), cert: file('server.crt'), ca: file('ca.crt'), requestCert: true, rejectUnauthorized: true, ...options }, (req, res) => { requests++; handler(req, res) })
  const runtime = await listen(server)
  return { ...runtime, requests: () => requests }
}
const environment = (port: number, overrides = {}) => ({
  OK_CONSOLE_OBSERVED_STATE_MODE: 'openkubes',
  OK_CONSOLE_OBSERVED_STATE_URL: `https://localhost:${port}/api/console-observed-state/v0alpha2`,
  OK_CONSOLE_OBSERVED_STATE_CA_FILE: join(root, 'ca.crt'),
  OK_CONSOLE_OBSERVED_STATE_CLIENT_CERT_FILE: join(root, 'client.crt'),
  OK_CONSOLE_OBSERVED_STATE_CLIENT_KEY_FILE: join(root, 'client.key'),
  OK_CONSOLE_OBSERVED_STATE_TIMEOUT_MS: '2000',
  ...overrides,
})
const request = async (env: ReturnType<typeof environment>, route = 'overview', options = {}, headers = {}) => {
  const lines: string[] = []
  const runtime = await createConsoleServer({ env, sourceFailureLog: (line: string) => { lines.push(line); captureFailureLine(line) },
    sessionRuntimeFactory: async () => ({ prototypeEnabled: true, ready: async () => true }),
    runtimeHttpFactory: ({ apiHandler }: { apiHandler: RequestListener }) => apiHandler,
    ...options,
  })
  const server = await listen(runtime.server)
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/console/v0/${route}`, { headers })
    const payload = await response.json()
    if (response.status === 503) expect(validateResponse(payload), JSON.stringify(validateResponse.errors)).toBe(true)
    return { status: response.status, payload, lines }
  } finally { await server.close() }
}
const assertFailure = (result: Awaited<ReturnType<typeof request>>, classification: string, reason: string, codes: string[] = ['OTHER'], httpStatus = 'NONE', route = 'OVERVIEW') => {
  expect(result.status).toBe(503)
  expect(result.payload).toEqual({ apiVersion: 'console.openkubes.io/v0alpha1', kind: 'Error', error: {
    code: 'SOURCE_UNAVAILABLE', message: 'The observed platform source is unavailable.', retryable: true, retryAfterSeconds: 15, reason,
  }, meta: { contractVersion: 'console.openkubes.io/v0alpha1', correlationId: expect.any(String) } })
  expect(result.lines).toHaveLength(1)
  const event = JSON.parse(result.lines[0])
  expect(Object.keys(event)).toEqual(['time', 'stage', 'route', 'correlationId', 'class', 'reason', 'nodeCode', 'httpStatus', 'failedStage', 'elapsedMs', 'phaseMs', 'wallClockStepMs', 'clockOffsetMs', 'clockStepSinceLastObservationMs', 'lastObservationAgeMs', 'stages'])
  expect(event).toMatchObject({ time: expect.stringMatching(/^\d{4}-\d\d-\d\dT/), route, correlationId: result.payload.meta.correlationId, class: classification, reason, nodeCode: expect.any(String), httpStatus })
  expect(codes).toContain(event.nodeCode)
  expect(Buffer.byteLength(result.lines[0] + '\n')).toBeLessThanOrEqual(2048)
  expect(JSON.stringify(result)).not.toContain(canary)
}

describe('D4 real local TLS through the production BFF wiring', () => {
  it.each(Array.from({ length: Number(process.env.OK_CONSOLE_D4_HEALTHY_REPETITIONS ?? 1) }, (_, i) => i))('serves a verified healthy source without failure events %i', async () => {
    const server = await producer()
    try { const result = await request(environment(server.port)); expect(result.status, result.lines.join('\n')).toBe(200); expect(result.lines).toEqual([]); expect(server.requests()).toBe(1) } finally { await server.close() }
  })
  it.each(['self-signed', 'wrong CA', 'hostname mismatch', 'expired', 'not yet valid'])('diagnoses %s without application traffic', async (scenario) => {
    const name = scenario === 'self-signed' ? 'self' : scenario === 'expired' ? 'expired' : scenario === 'not yet valid' ? 'future' : 'server'
    const server = await producer({ key: file(name + '.key'), cert: file(name + '.crt') })
    try {
      const env = environment(server.port, scenario === 'wrong CA' ? { OK_CONSOLE_OBSERVED_STATE_CA_FILE: join(root, 'wrong.crt') } : scenario === 'hostname mismatch' ? { OK_CONSOLE_OBSERVED_STATE_URL: `https://127.0.0.1:${server.port}/` } : {})
      const codes = scenario === 'self-signed' ? ['DEPTH_ZERO_SELF_SIGNED_CERT'] : scenario === 'wrong CA' ? ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'SELF_SIGNED_CERT_IN_CHAIN'] : scenario === 'expired' ? ['CERT_HAS_EXPIRED'] : scenario === 'not yet valid' ? ['CERT_NOT_YET_VALID'] : ['ERR_TLS_CERT_ALTNAME_INVALID']
      assertFailure(await request(env), 'TRUST_REJECTED', 'CERTIFICATE_VERIFICATION', codes)
      expect(server.requests()).toBe(0)
    } finally { await server.close() }
  })
  it('diagnoses connection refused', async () => {
    const server = await listen(tcpServer())
    await server.close()
    assertFailure(await request(environment(server.port)), 'SOURCE_UNREACHABLE', 'TRANSPORT_FAILURE', ['ECONNREFUSED'])
  })
  it('diagnoses adapter deadline before TLS', async () => {
    let closed = false
    const server = await listen(tcpServer((socket) => { socket.on('close', () => { closed = true }); socket.resume() }))
    try { assertFailure(await request(environment(server.port, { OK_CONSOLE_OBSERVED_STATE_TIMEOUT_MS: '80' })), 'SOURCE_UNREACHABLE', 'DEADLINE_EXCEEDED'); await vi.waitFor(() => expect(closed).toBe(true)) } finally { await server.close() }
  })
  it('keeps a hang after TLS inconclusive and closes the connection', async () => {
    let closed = false
    const server = await producer({}, (req) => { req.socket.on('close', () => { closed = true }) })
    try {
      const result = await request(environment(server.port, { OK_CONSOLE_OBSERVED_STATE_TIMEOUT_MS: '500' }))
      assertFailure(result, 'INCONCLUSIVE', 'DEADLINE_EXCEEDED')
      expect(JSON.parse(result.lines[0])).toMatchObject({ stage: 'TLS_ESTABLISHED', failedStage: 'AWAIT_HEADERS' })
      expect(server.requests()).toBe(1)
      await vi.waitFor(() => expect(closed).toBe(true))
    } finally { await server.close() }
  })
  it('keeps a slow producer after TLS inconclusive before headers', async () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const server = await producer({}, (_req, res) => {
      timer = setTimeout(() => { res.writeHead(200, profile); res.end(body) }, 1500)
    })
    try {
      const result = await request(environment(server.port, { OK_CONSOLE_OBSERVED_STATE_TIMEOUT_MS: '500' }))
      assertFailure(result, 'INCONCLUSIVE', 'DEADLINE_EXCEEDED')
      expect(JSON.parse(result.lines[0])).toMatchObject({ stage: 'TLS_ESTABLISHED', failedStage: 'AWAIT_HEADERS' })
      expect(server.requests()).toBe(1)
    } finally { clearTimeout(timer); await server.close() }
  })
  it.each([false, true])('keeps a pre-header socket timeout class tied to TLS completion: %s', async (tls) => {
    let injected = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const originalEmit = ClientRequest.prototype.emit
    const emitted = vi.spyOn(ClientRequest.prototype, 'emit').mockImplementation(function (event, ...args) {
      const result = originalEmit.call(this, event, ...args)
      if (event === 'socket') {
        args[0].once(tls ? 'secureConnect' : 'connect', () => {
          timer = setTimeout(() => {
            injected = true
            args[0].destroy(Object.assign(new Error(canary), { code: 'ETIMEDOUT' }))
          }, 50)
        })
      }
      return result
    })
    const server = tls ? await producer({}, () => {}) : await listen(tcpServer(socket => socket.resume()))
    try {
      const result = await request(environment(server.port))
      assertFailure(result, tls ? 'INCONCLUSIVE' : 'SOURCE_UNREACHABLE', 'TRANSPORT_FAILURE', ['ETIMEDOUT'])
      expect(injected).toBe(true)
      expect(JSON.parse(result.lines[0])).toMatchObject({ stage: tls ? 'TLS_ESTABLISHED' : 'TCP_CONNECTED', failedStage: tls ? 'AWAIT_HEADERS' : 'TLS_HANDSHAKE' })
      if ('requests' in server) expect(server.requests()).toBe(1)
    } finally { clearTimeout(timer); emitted.mockRestore(); await server.close() }
  })
  it('diagnoses adapter deadline after headers and closes the body', async () => {
    let closed = false
    const server = await producer({}, (_req, res) => { res.on('close', () => { closed = true }); res.writeHead(200, profile); res.write('{') })
    try { assertFailure(await request(environment(server.port, { OK_CONSOLE_OBSERVED_STATE_TIMEOUT_MS: '1000' })), 'INCONCLUSIVE', 'BODY_DEADLINE_EXCEEDED'); expect(server.requests()).toBe(1); await vi.waitFor(() => expect(closed).toBe(true)) } finally { await server.close() }
  })
  it('keeps a reset inconclusive', async () => {
    const server = await producer({}, (req) => req.socket.destroy())
    try { assertFailure(await request(environment(server.port)), 'INCONCLUSIVE', 'TRANSPORT_AMBIGUOUS', ['ECONNRESET', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE']) } finally { await server.close() }
  })
  it.each([
    ['client-expired', 'ca.crt', 'CERTIFICATE_EXPIRED'],
    ['client-future', 'ca.crt', 'BAD_CERTIFICATE'],
    ['client-wrong-eku', 'ca.crt', 'UNSUPPORTED_CERTIFICATE'],
    ['client', 'wrong.crt', 'UNKNOWN_CA'],
  ])('normalises the real CERT_OPTIONAL peer alert for %s', async (client, ca, alert) => {
    // Python OpenSSL stand-in: minimum TLS 1.2, no maximum, CERT_OPTIONAL.
    // The production client must negotiate TLS 1.3 without a server-side force.
    let rawCode: unknown
    const originalEmit = ClientRequest.prototype.emit
    const emitted = vi.spyOn(ClientRequest.prototype, 'emit').mockImplementation(function (event, ...args) {
      if (event === 'error') rawCode = Object.getOwnPropertyDescriptor(args[0], 'code')?.value
      return originalEmit.call(this, event, ...args)
    })
    const child = spawn('python3', ['-u', '-c', `
import ssl,sys,http.server
ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.minimum_version=ssl.TLSVersion.TLSv1_2
ctx.load_cert_chain('server.crt','server.key')
ctx.load_verify_locations(cafile=sys.argv[1])
ctx.verify_mode=ssl.CERT_OPTIONAL
server=http.server.HTTPServer(('127.0.0.1',0),http.server.BaseHTTPRequestHandler)
server.socket=ctx.wrap_socket(server.socket,server_side=True)
print(server.server_port,flush=True)
server.serve_forever()
`, ca], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
    try {
      const port = await new Promise<number>((resolve, reject) => {
        child.stdout.once('data', (data) => resolve(Number(String(data).trim())))
        child.once('exit', () => reject(new Error('Python TLS server exited during setup')))
      })
      const result = await request(environment(port, { OK_CONSOLE_OBSERVED_STATE_CLIENT_CERT_FILE: join(root, client + '.crt'), OK_CONSOLE_OBSERVED_STATE_CLIENT_KEY_FILE: join(root, client + '.key') }))
      assertFailure(result, 'INCONCLUSIVE', 'PEER_TLS_ALERT', [alert])
      expect(rawCode).toMatch(/^ERR_SSL_(?:SSLV3|TLSV1|TLSV13|SSL\/TLS)_ALERT_[A-Z_]+$/)
      console.info('D4 peer alert:', process.version, process.versions.openssl, client, rawCode, '=>', JSON.parse(result.lines[0]).nodeCode)
    } finally {
      emitted.mockRestore()
      child.kill('SIGTERM')
      if (child.exitCode === null) await new Promise<void>((resolve) => child.once('exit', () => resolve()))
    }
  })
  it('classifies a real name-constraint verifier rejection as trust rejected', async () => {
    const server = await producer({ cert: file('ncleaf.crt') })
    try {
      assertFailure(await request(environment(server.port, { OK_CONSOLE_OBSERVED_STATE_CA_FILE: join(root, 'nc.crt') })), 'TRUST_REJECTED', 'CERTIFICATE_VERIFICATION', ['UNSPECIFIED'])
      expect(server.requests()).toBe(0)
      // Same server leaf, issuer key and subject; only the trust anchor's
      // permitted DNS subtree now includes localhost.
      expect((await request(environment(server.port, { OK_CONSOLE_OBSERVED_STATE_CA_FILE: join(root, 'nc-good.crt') }))).status).toBe(200)
      expect(server.requests()).toBe(1)
    } finally { await server.close() }
  })
  it('requires TLS 1.3 from the client', async () => {
    let protocol: string | null = null
    const server = await producer({}, (req, res) => { protocol = (req.socket as import('node:tls').TLSSocket).getProtocol(); res.writeHead(200, profile); res.end(body) })
    try { expect((await request(environment(server.port))).status).toBe(200); expect(protocol).toBe('TLSv1.3') } finally { await server.close() }
    const legacy = await producer({ maxVersion: 'TLSv1.2' })
    try { assertFailure(await request(environment(legacy.port)), 'INCONCLUSIVE', 'TLS_PROTOCOL_FAILURE', ['EPROTO']); expect(legacy.requests()).toBe(0) } finally { await legacy.close() }
  })
  it.each([[403, 'IDENTITY_REJECTED', 'IDENTITY_REJECTED'], [503, 'HTTP_SERVER_ERROR', '5XX'], [404, 'HTTP_NON_SUCCESS', 'OTHER'], [304, 'HTTP_NON_SUCCESS', 'OTHER']])('closes producer HTTP %s', async (status, reason, httpStatus) => {
    const server = await producer({}, (_req, res) => { res.writeHead(Number(status), profile); res.end(JSON.stringify({ error: 'workload_identity_required', message: canary })) })
    try {
    const result = await request(environment(server.port))
    assertFailure(result, 'INCONCLUSIVE', String(reason), ['OTHER'], String(httpStatus))
    expect(JSON.parse(result.lines[0]).failedStage).toBe('AWAIT_HEADERS')
  } finally { await server.close() }
  })
  it.each([204, 205])('maps bodyless success HTTP %s to contract-incompatible', async (status) => {
    const server = await producer({}, (_req, res) => { res.writeHead(status, profile); res.end() })
    try {
      const result = await request(environment(server.port))
      expect(result.status).toBe(502)
      expect(result.payload.error.code).toBe('CONTRACT_INCOMPATIBLE')
      expect(result.lines).toHaveLength(1)
    } finally { await server.close() }
  })
  it('preserves contract-incompatible as 502 with one bounded event', async () => {
    const server = await producer({}, (_req, res) => { res.writeHead(200, profile); res.end('{') })
    try {
      const result = await request(environment(server.port))
      expect(result.status).toBe(502)
      expect(result.payload.error.code).toBe('CONTRACT_INCOMPATIBLE')
      expect(result.lines).toHaveLength(1)
      expect(JSON.parse(result.lines[0])).toMatchObject({ class: 'CONTRACT_INCOMPATIBLE', reason: 'CONTRACT_VALIDATION' })
    } finally { await server.close() }
  })
  it.each([['overview', 'OVERVIEW'], ['clusters', 'CLUSTERS'], ['clusters/ok-mgmt', 'CLUSTER_DETAIL'], ['evidence', 'EVIDENCE'], ['evidence/item-1', 'EVIDENCE_DETAIL']])('keeps %s response and log safe with canaries', async (route, routeClass) => {
    const error = Object.assign(new Error(canary), { code: 'ERR_TLS_CERT_ALTNAME_INVALID', cert: canary, address: canary, port: canary, cause: { code: 'ECONNREFUSED' } })
    assertFailure(await request(environment(1), route, { sourceFactory: () => ({ readSnapshot: async () => { throw error } }) }), 'TRUST_REJECTED', 'CERTIFICATE_VERIFICATION', ['ERR_TLS_CERT_ALTNAME_INVALID'], 'NONE', routeClass)
  })
  it('does not observe or read before authorization', async () => {
    const readSnapshot = vi.fn()
    const result = await request(environment(1), 'overview', { sourceFactory: () => ({ readSnapshot }), sessionRuntimeFactory: async () => ({ authorizer: async () => ({ allowed: false }) }) })
    expect(result.status).toBe(403); expect(readSnapshot).not.toHaveBeenCalled(); expect(result.lines).toEqual([])
  })
  it('uses the default JSON logger through the runtime HTTP handler', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const result = await request(environment(1), 'overview', { sourceFailureLog: undefined, runtimeHttpFactory: undefined })
      expect(result.status).toBe(503)
      const events = log.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith('{') && 'class' in JSON.parse(line))
      expect(events).toHaveLength(1)
      expect(JSON.parse(events[0])).toMatchObject({ class: 'SOURCE_UNREACHABLE', nodeCode: 'ECONNREFUSED' })
    } finally { log.mockRestore() }
  })
  it('keeps projection failures outside upstream classification', async () => {
    const result = await request(environment(1), 'overview', { sourceFactory: () => ({ readSnapshot: async () => { const snapshot = await new FixtureObservedStateAdapter().readSnapshot(); return { ...snapshot, get clusters() { throw Object.assign(new Error(canary), { code: 'CERT_HAS_EXPIRED' }) } } } }) })
    expect(result.status).toBe(503)
    expect(result.lines).toEqual([])
    expect(result.payload.error.reason).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain(canary)
  })
  it('isolates logging failure', async () => {
    const result = await request(environment(1), 'overview', { sourceFailureLog: () => { throw new Error(canary) } })
    expect(result.status).toBe(503); expect(result.payload.error.reason).toBe('TRANSPORT_FAILURE'); expect(JSON.stringify(result)).not.toContain(canary)
  })
  it('rejects invalid error bodies against the complete JSON Schema', () => {
    const payload = { apiVersion: 'console.openkubes.io/v0alpha1', kind: 'Error', error: { code: 'SOURCE_UNAVAILABLE', message: 'Unavailable', retryable: true, reason: 'TRANSPORT_FAILURE' }, meta: { contractVersion: 'console.openkubes.io/v0alpha1', correlationId: 'corr-test' } }
    expect(validateResponse(payload)).toBe(true)
    expect(validateResponse({ ...payload, error: { ...payload.error, reason: 'NOT_A_REASON' } })).toBe(false)
    expect(validateResponse({ ...payload, meta: { contractVersion: payload.meta.contractVersion } })).toBe(false)
    expect(validateResponse({ ...payload, error: { ...payload.error, unexpected: 'value' } })).toBe(false)
  })
  it('generates the logged correlation ID independently of hostile request headers', async () => {
    const result = await request(environment(1), 'overview', {}, { 'X-Correlation-ID': canary.repeat(64), 'X-Request-ID': canary.repeat(64) })
    assertFailure(result, 'SOURCE_UNREACHABLE', 'TRANSPORT_FAILURE', ['ECONNREFUSED'])
    expect(result.payload.meta.correlationId).toMatch(/^corr-[0-9a-f-]{36}$/)
  })
  it('does not mistake an external abort for the private deadline', async () => {
    const NativeController = AbortController
    const external: AbortController[] = []
    let observedSignal: AbortSignal | undefined
    vi.stubGlobal('AbortController', class extends NativeController { constructor() { super(); external.push(this) } })
    try {
      const adapter = new OpenKubesObservedStateAdapter({ url: 'https://localhost/', fetchImpl: async (_url: URL, { signal }: { signal: AbortSignal }) => {
        observedSignal = signal
        external[0].abort('external cancellation')
        throw Object.assign(new Error(canary), { code: 'ABORT_ERR' })
      } })
      await expect(adapter.readSnapshot().catch((error: unknown) => classifySourceFailure(error))).resolves.toMatchObject({ class: 'INCONCLUSIVE', reason: 'UNCLASSIFIED' })
      expect(observedSignal?.aborted).toBe(true)
      expect(observedSignal?.reason).toBe('external cancellation')
    } finally { vi.unstubAllGlobals() }
  })
  it('cancels a rejected HTTP body and preserves its status when cancellation crosses the deadline', async () => {
    let cancelled = false
    const adapter = new OpenKubesObservedStateAdapter({ url: 'https://localhost/', timeoutMs: 10, fetchImpl: async (_url: URL, { signal }: { signal: AbortSignal }) => new Response(new ReadableStream({
      cancel: async () => {
        cancelled = true
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      },
    }), { status: 403 }) })
    await expect(adapter.readSnapshot().catch((error: unknown) => classifySourceFailure(error))).resolves.toMatchObject({ class: 'INCONCLUSIVE', reason: 'IDENTITY_REJECTED', httpStatus: 'IDENTITY_REJECTED' })
    expect(cancelled).toBe(true)
  })
  it('drains a bodyless 205 response to the end of its Node stream', async () => {
    const server = await producer({}, (_req, res) => { res.writeHead(205, { 'Content-Length': '262144' }); res.end(Buffer.alloc(262144, 120)) })
    const { Readable } = await import('node:stream')
    const resumed = vi.spyOn(Readable.prototype, 'resume')
    try {
      const fetchImpl = createObservedStateMtlsFetch({ ca: file('ca.crt'), certificate: file('client.crt'), privateKey: file('client.key') })
      const response = await fetchImpl(`https://localhost:${server.port}/`).catch((error: unknown) => { captureFailure(error); throw error })
      expect(response.body).toBeNull()
      await vi.waitFor(() => {
        const observed = resumed.mock.instances.find((stream) => (stream as import('node:http').IncomingMessage).statusCode === 205)
        expect(observed).toBeDefined()
        expect(observed?.readableEnded).toBe(true)
      })
    } finally { resumed.mockRestore(); await server.close() }
  })
  it('preserves own trust code even if the private deadline fired', async () => {
    const adapter = new OpenKubesObservedStateAdapter({ url: 'https://localhost/', timeoutMs: 1, fetchImpl: async (_url: URL, { signal }: { signal: AbortSignal }) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      throw Object.assign(new Error(canary), { code: 'CERT_HAS_EXPIRED' })
    } })
    await expect(adapter.readSnapshot().catch((error: unknown) => classifySourceFailure(error))).resolves.toMatchObject({ class: 'TRUST_REJECTED' })
  })
})

// These assertions run outside the child's process so an uncaught callback error
// or unhandled rejection is a failing assertion, rather than a crashed test runner.
it('isolates an async logging rejection from the process and response', () => {
  let output = ''
  try { output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { createConsoleServer } from './bff/server.mjs'
    const runtime = await createConsoleServer({
      env: {}, sourceFailureLog: async (line) => { console.log(line); throw new Error('private canary') },
      sourceFactory: () => ({ readSnapshot: async () => { throw Object.assign(new Error(), {code:'ECONNREFUSED'}) } }),
      sessionRuntimeFactory: async () => ({ prototypeEnabled:true, ready:async()=>true }),
      runtimeHttpFactory: ({apiHandler}) => apiHandler,
    })
    await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve))
    const response = await fetch('http://127.0.0.1:' + runtime.server.address().port + '/api/console/v0/overview')
    const payload = await response.json()
    await new Promise(resolve => setTimeout(resolve, 30))
    console.log(JSON.stringify({status:response.status,reason:payload.error.reason}))
    runtime.server.closeAllConnections()
    await new Promise(resolve => runtime.server.close(resolve))
  `], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 })
  } catch (error) { captureChildFailureLines(String((error as { stdout?: unknown }).stdout ?? '') + '\n' + String((error as { stderr?: unknown }).stderr ?? '')) }
  captureChildFailureLines(output)
  expect(output.trim().split('\n').at(-1)).toBe(JSON.stringify({ status: 503, reason: 'TRANSPORT_FAILURE' }))
}, 15_000)
it('rejects unsupported status 600 without crashing the process', () => {
  let output = ''
  try {
    output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { createServer } from 'node:https'
      import { readFileSync } from 'node:fs'
      import { createObservedStateMtlsFetch } from './bff/adapters/mtlsFetch.mjs'
      import { OpenKubesObservedStateAdapter } from './bff/adapters/openKubesObservedState.mjs'
      import { classifySourceFailure, sourceFailureLogLine } from './bff/adapters/sourceFailure.mjs'
      const file = name => readFileSync(process.argv[1] + '/' + name)
      const server = createServer({key:file('server.key'),cert:file('server.crt')}, (_req,res)=>{res.writeHead(600);res.end()})
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      try {
        const fetchImpl = createObservedStateMtlsFetch({ca:file('ca.crt'),certificate:file('client.crt'),privateKey:file('client.key')})
        const adapter = new OpenKubesObservedStateAdapter({url:'https://localhost:' + server.address().port,fetchImpl})
        console.log(JSON.stringify(await adapter.readSnapshot().catch(error => { console.log(sourceFailureLogLine('/', classifySourceFailure(error), undefined, error)); return classifySourceFailure(error) })))
      } finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)) }
    `, root], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 })
  } catch (error) { captureChildFailureLines(String((error as { stdout?: unknown }).stdout ?? '') + '\n' + String((error as { stderr?: unknown }).stderr ?? '')) }
  captureChildFailureLines(output)
  expect(output.trim().split('\n').at(-1)).toBe(JSON.stringify({ class: 'INCONCLUSIVE', reason: 'HTTP_NON_SUCCESS', nodeCode: 'OTHER', httpStatus: 'OTHER' }))
})
it('ignores an informational 199 before a final 403 status', async () => {
  const server = await producer({}, (_req, res) => { res.socket!.write('HTTP/1.1 199 Informational\r\n\r\n'); res.writeHead(403); res.end() })
  try { assertFailure(await request(environment(server.port)), 'INCONCLUSIVE', 'IDENTITY_REJECTED', ['OTHER'], 'IDENTITY_REJECTED') } finally { await server.close() }
})
it('observes a real TLS 1.3 certificate_required alert without a client certificate', async () => {
  const server = await producer({ minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' })
  try {
    const failure = await new Promise<unknown>((resolve, reject) => {
      const req = httpsRequest(`https://localhost:${server.port}`, { ca: file('ca.crt'), minVersion: 'TLSv1.3', agent: false }, () => reject(new Error('Unexpected HTTP response')))
      req.once('error', resolve)
      req.end()
    })
    captureFailure(failure)
    const code = Object.getOwnPropertyDescriptor(failure, 'code')?.value ?? 'OTHER'
    console.info('D4 missing client certificate:', process.version, process.versions.openssl, code)
    expect(code).toBe('ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED')
    expect(classifySourceFailure(failure)).toEqual({ class: 'INCONCLUSIVE', reason: 'PEER_TLS_ALERT', nodeCode: 'CERTIFICATE_REQUIRED', httpStatus: 'NONE' })
    expect(server.requests()).toBe(0)
  } finally { await server.close() }
})
it.each([401, 403])('preserves HTTP %s when body cancellation rejects', async (status) => {
  let cancelled = false
  const adapter = new OpenKubesObservedStateAdapter({ url: 'https://localhost/', fetchImpl: async () => new Response(new ReadableStream({ cancel: () => { cancelled = true; throw Object.assign(new Error(canary), { code: 'ECONNRESET' }) } }), { status }) })
  await expect(adapter.readSnapshot().catch(classifySourceFailure)).resolves.toMatchObject({ reason: 'IDENTITY_REJECTED', httpStatus: 'IDENTITY_REJECTED' })
  expect(cancelled).toBe(true)
})
it('keeps ETIMEDOUT after headers in the body phase', async () => {
  const adapter = new OpenKubesObservedStateAdapter({ url: 'https://localhost/', fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.error(Object.assign(new Error(canary), { code: 'ETIMEDOUT' })) } }), { headers: profile }) })
  await expect(adapter.readSnapshot().catch(classifySourceFailure)).resolves.toMatchObject({ class: 'INCONCLUSIVE', reason: 'BODY_DEADLINE_EXCEEDED', nodeCode: 'ETIMEDOUT', httpStatus: 'NONE' })
})
it('retains a real TLS body socket timeout through the production transport', async () => {
  let injected = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const originalEmit = ClientRequest.prototype.emit
  const emitted = vi.spyOn(ClientRequest.prototype, 'emit').mockImplementation(function (event, ...args) {
    const result = originalEmit.call(this, event, ...args)
    if (event === 'response') {
      const socket = this.socket
      timer = setTimeout(() => {
        injected = true
        socket?.destroy(Object.assign(new Error(canary), { code: 'ETIMEDOUT' }))
      }, 50)
    }
    return result
  })
  const server = await producer({}, (_req, res) => { res.writeHead(200, profile); res.write('{') })
  try {
    assertFailure(await request(environment(server.port)), 'INCONCLUSIVE', 'BODY_DEADLINE_EXCEEDED', ['ETIMEDOUT'])
    expect(injected).toBe(true)
    expect(server.requests()).toBe(1)
  } finally {
    clearTimeout(timer)
    emitted.mockRestore()
    await server.close()
  }
})
it('documents the strict schema limitation and validates explicit date-time formats', () => {
  const strict = new Ajv2020({ strict: true })
  addFormats(strict)
  expect(() => strict.compile(schema)).toThrow(/missing type "object" for keyword "properties"/)
  expect(ajv.opts.strict).toBe(true)
  expect(ajv.opts.strictTypes).toBe(false)
  const timestamp = ajv.compile(schema.$defs.timestamp)
  expect(timestamp('2026-10-23T00:00:00Z')).toBe(true)
  expect(timestamp('not-a-date')).toBe(false)
})

it('rejects an unexpected 101 upgrade before the deadline', async () => {
  const server = await producer({}, (_req, res) => { res.writeHead(101, { Connection: 'Upgrade', Upgrade: 'test' }); res.end() })
  try {
    const fetchImpl = createObservedStateMtlsFetch({ ca: file('ca.crt'), certificate: file('client.crt'), privateKey: file('client.key') })
    const adapter = new OpenKubesObservedStateAdapter({ url: `https://localhost:${server.port}`, fetchImpl, timeoutMs: 2000 })
    const diagnostic = await Promise.race([adapter.readSnapshot().catch(classifySourceFailure), new Promise(resolve => setTimeout(() => resolve('HUNG_PAST_DEADLINE'), 3000))])
    expect(diagnostic).toEqual({ class: 'INCONCLUSIVE', reason: 'HTTP_NON_SUCCESS', nodeCode: 'OTHER', httpStatus: 'OTHER' })
  } finally { await server.close() }
})
it.each(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETDOWN', 'EHOSTDOWN', 'EHOSTUNREACH', 'ENETUNREACH'])('keeps body-phase %s inconclusive', async (code) => {
  const adapter = new OpenKubesObservedStateAdapter({ url: 'https://localhost/', fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.error(Object.assign(new Error(canary), { code })) } }), { headers: profile }) })
  await expect(adapter.readSnapshot().catch(classifySourceFailure)).resolves.toMatchObject({ class: 'INCONCLUSIVE', reason: 'TRANSPORT_AMBIGUOUS', nodeCode: code })
})
it('records a Node TLS server rejecting a presented client certificate', async () => {
  const server = await producer({ ca: file('wrong.crt') })
  try {
    const result = await request(environment(server.port))
    assertFailure(result, 'INCONCLUSIVE', 'TRANSPORT_AMBIGUOUS', ['ECONNRESET'])
    console.info('D4 Node client certificate rejection:', process.version, process.versions.openssl, JSON.parse(result.lines[0]).nodeCode)
    expect(server.requests()).toBe(0)
  } finally { await server.close() }
})
it('records plain HTTP written on the TLS port', async () => {
  const server = await listen(tcpServer(socket => { socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n') }))
  try { assertFailure(await request(environment(server.port)), 'INCONCLUSIVE', 'TLS_PROTOCOL_FAILURE', ['EPROTO']) } finally { await server.close() }
})

it('preserves an HTTP 403 with an already-errored body', async () => {
  const adapter = new OpenKubesObservedStateAdapter({ url: 'https://localhost/', fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.error(Object.assign(new Error(canary), { code: 'ECONNRESET' })) } }), { status: 403 }) })
  await expect(adapter.readSnapshot().catch(classifySourceFailure)).resolves.toMatchObject({ reason: 'IDENTITY_REJECTED', httpStatus: 'IDENTITY_REJECTED' })
})

it.each([99, 101])('preserves unsupported final status %s without upgrade headers', async (status) => {
  const server = await producer({}, (_req, res) => { res.socket!.end(`HTTP/1.1 ${String(status).padStart(3, '0')} Test\r\nContent-Length: 0\r\n\r\n`) })
  try { assertFailure(await request(environment(server.port)), 'INCONCLUSIVE', 'HTTP_NON_SUCCESS', ['OTHER'], 'OTHER') } finally { await server.close() }
})
it('preserves HTTP 403 when Fetch rejects the status reason phrase', async () => {
  const server = await producer({}, (_req, res) => { res.socket!.end('HTTP/1.1 403 Fo\x01o\r\nContent-Length: 0\r\n\r\n') })
  try { assertFailure(await request(environment(server.port)), 'INCONCLUSIVE', 'IDENTITY_REJECTED', ['OTHER'], 'IDENTITY_REJECTED') } finally { await server.close() }
})
it.each([['cipher', { ciphers: 'TLS_AES_128_CCM_SHA256', minVersion: 'TLSv1.3' }], ['group', { ecdhCurve: 'secp256k1', minVersion: 'TLSv1.3' }]] as const)('records write-path %s mismatch as EPROTO', async (_name, options) => {
  const server = await producer(options)
  try { assertFailure(await request(environment(server.port)), 'INCONCLUSIVE', 'TLS_PROTOCOL_FAILURE', ['EPROTO']); expect(server.requests()).toBe(0) } finally { await server.close() }
})

it.each(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETDOWN', 'EHOSTDOWN', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT'])('preserves pre-header network code %s', async (code) => {
  const adapter = new OpenKubesObservedStateAdapter({ url: 'https://localhost/', fetchImpl: async () => { throw Object.assign(new Error(canary), { code }) } })
  await expect(adapter.readSnapshot().catch(classifySourceFailure)).resolves.toMatchObject({ class: 'SOURCE_UNREACHABLE', reason: 'TRANSPORT_FAILURE', nodeCode: code })
})
it('closes an unsupported-status streaming body before server teardown', async () => {
  let closed = false
  const server = await producer({}, (_req, res) => { res.on('close', () => { closed = true }); res.writeHead(600, profile); res.write('partial') })
  try {
    assertFailure(await request(environment(server.port)), 'INCONCLUSIVE', 'HTTP_NON_SUCCESS', ['OTHER'], 'OTHER')
    await vi.waitFor(() => expect(closed).toBe(true))
  } finally { await server.close() }
})
it('closes a rejected upgraded socket before server teardown', async () => {
  let closed = false
  const server = await producer({}, (req, res) => { req.socket.on('close', () => { closed = true }); res.writeHead(101, { Connection: 'Upgrade', Upgrade: 'test' }); res.flushHeaders() })
  try {
    assertFailure(await request(environment(server.port)), 'INCONCLUSIVE', 'HTTP_NON_SUCCESS', ['OTHER'], 'OTHER')
    await vi.waitFor(() => expect(closed).toBe(true))
  } finally { await server.close() }
})
it.each([[200, 'UNCLASSIFIED', 'NONE'], [300, 'HTTP_NON_SUCCESS', 'OTHER']])('reason-phrase rejection preserves status boundary %s', async (status, reason, httpStatus) => {
  const server = await producer({}, (_req, res) => { res.socket!.end(`HTTP/1.1 ${status} Fo\x01o\r\nContent-Length: 0\r\n\r\n`) })
  try {
    const result = await request(environment(server.port))
    assertFailure(result, 'INCONCLUSIVE', String(reason), ['OTHER'], String(httpStatus))
    expect(JSON.parse(result.lines[0]).failedStage).toBe('AWAIT_HEADERS')
  } finally { await server.close() }
})

it.each([
  ['absent content type', {}, 502],
  ['media type', { 'Content-Type': 'text/html; profile="observed.openkubes.io/v0alpha2"' }, 502],
  ['profile', { 'Content-Type': 'application/json; profile="observed.openkubes.io/unknown"' }, 502],
  ['declared length', { ...profile, 'Content-Length': String(2 * 1024 * 1024 + 1) }, 503],
] as const)('closes a streaming 2xx rejected for %s before server teardown', async (_name, headers, status) => {
  let closed = false
  const server = await producer({}, (_req, res) => { res.on('close', () => { closed = true }); res.writeHead(200, headers); res.write('partial') })
  try {
    const result = await request(environment(server.port))
    if (status === 503) assertFailure(result, 'INCONCLUSIVE', 'UNCLASSIFIED')
    else expect(result.status, result.lines.join('\n')).toBe(status)
    await vi.waitFor(() => expect(closed).toBe(true))
  } finally { await server.close() }
})
it('closes a streaming body exceeding the measured size limit before server teardown', async () => {
  let closed = false
  const server = await producer({}, (_req, res) => { res.on('close', () => { closed = true }); res.writeHead(200, profile); res.write(Buffer.alloc(2 * 1024 * 1024 + 1)) })
  try {
    const result = await request(environment(server.port))
    assertFailure(result, 'INCONCLUSIVE', 'UNCLASSIFIED')
    await vi.waitFor(() => expect(closed).toBe(true))
  } finally { await server.close() }
})
it.each([
  ['profile', { 'Content-Type': 'application/json; profile="observed.openkubes.io/unknown"' }, 'CONTRACT_INCOMPATIBLE'],
  ['declared length', { ...profile, 'Content-Length': String(2 * 1024 * 1024 + 1) }, 'SOURCE_UNAVAILABLE'],
] as const)('preserves the %s rejection when body cancellation fails', async (_name, headers, expected) => {
  let cancelled = false
  const result = await request(environment(1), 'overview', { sourceFactory: () => new OpenKubesObservedStateAdapter({
    url: 'https://localhost/', fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; throw Object.assign(new Error(canary), { code: 'ETIMEDOUT' }) } }), { headers }),
  }) })
  expect(result.payload.error.code).toBe(expected)
  expect(result.lines).toHaveLength(1)
  expect(JSON.parse(result.lines[0]).reason).toBe(expected === 'CONTRACT_INCOMPATIBLE' ? 'CONTRACT_VALIDATION' : 'UNCLASSIFIED')
  expect(cancelled).toBe(true)
})
it('preserves the measured size rejection when reader cancellation fails', async () => {
  const adapter = new OpenKubesObservedStateAdapter({ url: 'https://localhost/', fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)) },
    cancel() { throw Object.assign(new Error(canary), { code: 'ETIMEDOUT' }) },
  }), { headers: profile }) })
  await expect(adapter.readSnapshot().catch(classifySourceFailure)).resolves.toEqual({ class: 'INCONCLUSIVE', reason: 'UNCLASSIFIED', nodeCode: 'OTHER', httpStatus: 'NONE' })
})

it('closes a streaming bodyless 205 before server teardown', async () => {
  let closed = false
  const server = await producer({}, (_req, res) => { res.on('close', () => { closed = true }); res.writeHead(205, profile); res.write('partial') })
  try {
    const result = await request(environment(server.port))
    expect(result.status).toBe(502)
    await vi.waitFor(() => expect(closed).toBe(true))
  } finally { await server.close() }
})
it('retains a measured body socket timeout when the adapter deadline also fired', async () => {
  const adapter = new OpenKubesObservedStateAdapter({ url: 'https://localhost/', timeoutMs: 10, fetchImpl: async (_url: URL, { signal }: { signal: AbortSignal }) => new Response(new ReadableStream({
    start(controller) { signal.addEventListener('abort', () => controller.error(Object.assign(new Error(canary), { code: 'ETIMEDOUT' })), { once: true }) },
  }), { headers: profile }) })
  await expect(adapter.readSnapshot().catch(classifySourceFailure)).resolves.toEqual({ class: 'INCONCLUSIVE', reason: 'BODY_DEADLINE_EXCEEDED', nodeCode: 'ETIMEDOUT', httpStatus: 'NONE' })
})
it.each([
  ['bad header', 'HTTP/1.1 403 Forbidden\r\nX-Bad: a\x01b\r\nContent-Length: 0\r\n\r\n'],
  ['duplicate Content-Length', 'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nContent-Length: 1\r\n\r\n'],
  ['malformed status token', 'HTTP/1.1 4033 Forbidden\r\nContent-Length: 0\r\n\r\n'],
])('records a parser-rejected %s as unclassified without HTTP status', async (_name, bytes) => {
  const server = await producer({}, (_req, res) => { res.socket!.end(bytes) })
  try { assertFailure(await request(environment(server.port)), 'INCONCLUSIVE', 'UNCLASSIFIED') } finally { await server.close() }
})
it.each([true, false])('accepts a body exactly at the size limit (declared length: %s)', async (declared) => {
  const limit = 2 * 1024 * 1024
  const bytes = Buffer.concat([Buffer.from(body), Buffer.alloc(limit - Buffer.byteLength(body), 32)])
  const server = await producer({}, (_req, res) => { res.writeHead(200, { ...profile, ...(declared ? { 'Content-Length': String(limit) } : {}) }); res.end(bytes) })
  try { const result = await request(environment(server.port)); expect(result.status, result.lines.join('\n')).toBe(200); expect(result.lines).toEqual([]) } finally { await server.close() }
})

it('closes a streaming identity-rejected 403 body before server teardown', async () => {
  let closed = false
  const server = await producer({}, (_req, res) => { res.on('close', () => { closed = true }); res.writeHead(403); res.write('partial') })
  try {
    assertFailure(await request(environment(server.port)), 'INCONCLUSIVE', 'IDENTITY_REJECTED', ['OTHER'], 'IDENTITY_REJECTED')
    await vi.waitFor(() => expect(closed).toBe(true))
  } finally { await server.close() }
})
it('keeps the pre-header phase when the private deadline and a socket timeout coincide', async () => {
  const adapter = new OpenKubesObservedStateAdapter({ url: 'https://localhost/', timeoutMs: 10, fetchImpl: async (_url: URL, { signal }: { signal: AbortSignal }) => {
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    throw Object.assign(new Error(canary), { code: 'ETIMEDOUT' })
  } })
  await expect(adapter.readSnapshot().catch(classifySourceFailure)).resolves.toEqual({ class: 'SOURCE_UNREACHABLE', reason: 'DEADLINE_EXCEEDED', nodeCode: 'OTHER', httpStatus: 'NONE' })
})

it('gives every normal TLS fixture a wide validity window around the host clock', () => {
  const now = Date.now()
  for (const name of ['ca', 'wrong', 'server', 'client', 'self', 'nc', 'nc-good', 'ncleaf', 'client-wrong-eku']) {
    const certificate = new X509Certificate(file(name + '.crt'))
    expect(Date.parse(certificate.validFrom), name).toBeLessThan(now - 60 * 60 * 1000)
    expect(Date.parse(certificate.validTo), name).toBeGreaterThan(now + 60 * 60 * 1000)
  }
})

// Round 5: deterministic production-wiring reenactments. The line itself must
// carry the discriminating observation; status alone cannot identify a cause.
it.each(['future', 'refused', 'headers-deadline', 'body-deadline', 'http-503', 'validation'])('traces the failing stage with bounded evidence: %s', async (scenario) => {
  const server = scenario === 'refused' ? await listen(tcpServer()) : await producer(
    scenario === 'future' ? { key: file('future.key'), cert: file('future.crt') } : {},
    (_req, res) => {
      if (scenario === 'headers-deadline') return
      res.writeHead(scenario === 'http-503' ? 503 : 200, profile)
      if (scenario === 'body-deadline') res.write('{')
      else res.end('{')
    })
  if (scenario === 'refused') await server.close()
  try {
    const result = await request(environment(server.port, { OK_CONSOLE_OBSERVED_STATE_TIMEOUT_MS: '500' }))
    expect(result.status).toBe(scenario === 'validation' ? 502 : 503)
    expect(result.lines).toHaveLength(1)
    const event = JSON.parse(result.lines[0])
    const expected = { future: 'TLS_HANDSHAKE', refused: 'CONNECT', 'headers-deadline': 'AWAIT_HEADERS', 'body-deadline': 'BODY', 'http-503': 'AWAIT_HEADERS', validation: 'VALIDATION' }[scenario]
    expect(event.failedStage).toBe(expected)
    expect(event.stage).toBe(event.stages.at(-1)?.stage)
    if (scenario === 'future') expect(event.nodeCode).toBe('CERT_NOT_YET_VALID')
    expect(event.elapsedMs).toBeGreaterThanOrEqual(0)
    if (scenario === 'headers-deadline' || scenario === 'body-deadline') expect(event.elapsedMs).toBeGreaterThanOrEqual(450)
    expect(event.elapsedMs).toBeLessThanOrEqual(600000)
    expect(Number.isInteger(event.elapsedMs)).toBe(true)
    expect(Number.isInteger(event.wallClockStepMs)).toBe(true)
    expect(Math.abs(event.wallClockStepMs)).toBeLessThanOrEqual(86400000)
    expect(event.stages.slice(0, 3).map((entry: { stage: string }) => entry.stage)).toEqual(['REQUEST_RECEIVED', 'AUTHZ_CHECKED', 'SOURCE_ATTEMPT_START'])
    const order = ['REQUEST_RECEIVED', 'AUTHZ_CHECKED', 'SOURCE_ATTEMPT_START', 'DNS_RESOLVED', 'TCP_CONNECTED', 'TLS_ESTABLISHED', 'HEADERS_RECEIVED', 'BODY_COMPLETE', 'CONTRACT_VALIDATED']
    const indices = event.stages.map((entry: { stage: string }) => order.indexOf(entry.stage))
    expect(indices).toEqual([...indices].sort((a: number, b: number) => a - b))
    expect(event.stages.length).toBeLessThanOrEqual(16)
    for (const [key, value] of Object.entries(event.phaseMs)) {
      expect(['dns', 'connect', 'tls', 'headers']).toContain(key)
      expect(Number.isInteger(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(600000)
    }
    if (['body-deadline', 'http-503', 'validation', 'headers-deadline'].includes(scenario)) expect(Object.keys(event.phaseMs)).toEqual(scenario === 'headers-deadline' ? ['dns', 'connect', 'tls'] : ['dns', 'connect', 'tls', 'headers'])
    expect(Object.keys(event).sort()).toEqual(['time', 'stage', 'route', 'correlationId', 'class', 'reason', 'nodeCode', 'httpStatus', 'failedStage', 'elapsedMs', 'phaseMs', 'wallClockStepMs', 'clockOffsetMs', 'clockStepSinceLastObservationMs', 'lastObservationAgeMs', 'stages'].sort())
    for (const entry of event.stages) {
      expect(Object.keys(entry)).toEqual(['stage', 'atMs'])
      expect(order).toContain(entry.stage)
      expect(Number.isInteger(entry.atMs)).toBe(true)
      expect(entry.atMs).toBeGreaterThanOrEqual(0)
      expect(entry.atMs).toBeLessThanOrEqual(600000)
    }
    console.info('D4_R5_REENACTMENT ' + scenario + ' ' + result.lines[0])
  } finally { if (scenario !== 'refused') await server.close() }
})

it('joins access and stage trace lines through response sent on the correlation ID', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  const prior = process.env.OK_CONSOLE_TRACE
  process.env.OK_CONSOLE_TRACE = 'stages'
  const server = await producer()
  try {
    const result = await request(environment(server.port))
    expect(result.status).toBe(200)
    const logged = log.mock.calls.map(([line]) => String(line))
    const events = logged.filter((line) => line.startsWith('{')).map((line) => JSON.parse(line))
    const stages = events.filter((event) => 'atMs' in event)
    expect(stages.map((event) => event.stage)).toEqual(['REQUEST_RECEIVED', 'AUTHZ_CHECKED', 'SOURCE_ATTEMPT_START', 'DNS_RESOLVED', 'TCP_CONNECTED', 'TLS_ESTABLISHED', 'HEADERS_RECEIVED', 'BODY_COMPLETE', 'CONTRACT_VALIDATED', 'RESPONSE_SENT'])
    expect(stages.every((event) => event.correlationId === result.payload.meta.correlationId)).toBe(true)
    expect(logged).toContain(`GET /api/console/v0/overview · ${result.payload.meta.correlationId} stage=REQUEST_RECEIVED`)
  } finally { await server.close(); log.mockRestore(); if (prior === undefined) delete process.env.OK_CONSOLE_TRACE; else process.env.OK_CONSOLE_TRACE = prior }
})

it('identifies a real future certificate and a backward step in the same failure line', async () => {
  const server = await producer({ key: file('future.key'), cert: file('future.crt') })
  const realWall = Date.now.bind(Date)
  let offset = 0
  const wall = vi.spyOn(Date, 'now').mockImplementation(() => realWall() + offset)
  const originalEmit = ClientRequest.prototype.emit
  const events = vi.spyOn(ClientRequest.prototype, 'emit').mockImplementation(function (event, ...args) {
    if (event === 'socket') args[0].once('connect', () => { offset = -60000 })
    return originalEmit.call(this, event, ...args)
  })
  try {
    const result = await request(environment(server.port))
    expect(result.status).toBe(503)
    expect(result.lines).toHaveLength(1)
    const event = JSON.parse(result.lines[0])
    expect(event).toMatchObject({ failedStage: 'TLS_HANDSHAKE', nodeCode: 'CERT_NOT_YET_VALID' })
    expect(event.elapsedMs).toBeGreaterThan(0)
    expect(event.wallClockStepMs).toBeLessThan(-59000)
    expect(event.wallClockStepMs).toBeGreaterThan(-61000)
    expect(event).not.toHaveProperty('certValiditySkewS')
    console.info('D4_R5_REAL_CLOCK_REENACTMENT ' + result.lines[0])
  } finally { events.mockRestore(); wall.mockRestore(); await server.close() }
})

it('records a between-attempts backward step on a real strict TLS rejection', async () => {
  const healthy = await producer()
  const future = await producer({ key: file('future.key'), cert: file('future.crt') })
  const wall = Date.now.bind(Date)
  let clockSpy: ReturnType<typeof vi.spyOn> | undefined
  try {
    expect((await request(environment(healthy.port))).status).toBe(200)
    clockSpy = vi.spyOn(Date, 'now').mockImplementation(() => wall() - 645)
    await new Promise((resolve) => setTimeout(resolve, 40))
    const result = await request(environment(future.port))
    expect(result.status).toBe(503)
    const event = JSON.parse(result.lines[0])
    expect(event).toMatchObject({ nodeCode: 'CERT_NOT_YET_VALID', failedStage: 'TLS_HANDSHAKE', wallClockStepMs: 0, clockStepSinceLastObservationMs: expect.any(Number), lastObservationAgeMs: expect.any(Number) })
    expect(event.clockStepSinceLastObservationMs).toBeLessThan(0)
    expect(event.clockStepSinceLastObservationMs).toBeGreaterThan(-650)
    expect(event.lastObservationAgeMs).toBeGreaterThanOrEqual(40)
    console.info('D4_R6_BETWEEN_ATTEMPTS ' + result.lines[0])
  } finally { clockSpy?.mockRestore(); await healthy.close(); await future.close() }
})
it('closes production adapter monitor windows after repeated successful reads', async () => {
  const server = await producer()
  const before = processClock.activeWindowCount
  try {
    const adapter = new OpenKubesObservedStateAdapter({ url: `https://localhost:${server.port}/`, fetchImpl: createObservedStateMtlsFetch({ ca: file('ca.crt'), certificate: file('client.crt'), privateKey: file('client.key') }) })
    for (let i = 0; i < 8; i++) { await adapter.readSnapshot(); expect(processClock.activeWindowCount).toBe(before) }
    expect(server.requests()).toBe(8)
  } finally { await server.close() }
})
it('isolates overlapping real healthy, TLS and HTTP request trails', async () => {
  const latch = () => {
    let release!: () => void
    const promise = new Promise<void>((resolve) => { release = resolve })
    return { promise, release }
  }
  const healthyEntered = latch(), httpEntered = latch(), releaseHealthy = latch(), releaseHttp = latch()
  const tlsFailed = latch(), httpFailed = latch(), releaseFailureResponses = latch()
  const heldFailure = (failed: ReturnType<typeof latch>) => {
    const lines: string[] = []
    return { lines, options: {
      sourceFailureLog: (line: string) => { lines.push(line); captureFailureLine(line); failed.release() },
      runtimeHttpFactory: ({ apiHandler }: { apiHandler: RequestListener }) => ((req, res) => {
        const end = res.end.bind(res)
        res.end = ((...args: Parameters<typeof res.end>) => {
          void releaseFailureResponses.promise.then(() => { Reflect.apply(end, res, args) })
          return res
        }) as typeof res.end
        apiHandler(req, res)
      }) satisfies RequestListener,
    } }
  }
  const healthy = await producer({}, (_req, res) => { healthyEntered.release(); void releaseHealthy.promise.then(() => { res.writeHead(200, profile); res.end(body) }) })
  const tls = await producer({ key: file('future.key'), cert: file('future.crt') })
  const http = await producer({}, (_req, res) => { httpEntered.release(); void releaseHttp.promise.then(() => { res.writeHead(503); res.end() }) })
  const prior = process.env.OK_CONSOLE_TRACE
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  process.env.OK_CONSOLE_TRACE = 'stages'
  try {
    const httpCapture = heldFailure(httpFailed), tlsCapture = heldFailure(tlsFailed)
    const pendingHttp = request(environment(http.port), 'overview', httpCapture.options)
    await httpEntered.promise
    const pendingHealthy = request(environment(healthy.port))
    await healthyEntered.promise
    // All three requests are now inside the BFF when either failure is logged.
    const pendingTls = request(environment(tls.port), 'overview', tlsCapture.options)
    await tlsFailed.promise
    releaseHttp.release()
    await httpFailed.promise
    // Keep both failed BFF responses open until both lines have been written.
    releaseFailureResponses.release()
    const [tlsResult, httpResult] = await Promise.all([pendingTls, pendingHttp])
    const badTls = { ...tlsResult, lines: tlsCapture.lines }
    const badHttp = { ...httpResult, lines: httpCapture.lines }
    releaseHealthy.release()
    const ok = await pendingHealthy
    expect(ok.status).toBe(200)
    expect(ok.lines).toEqual([])
    const healthyTrail = log.mock.calls.map(([line]) => { try { return JSON.parse(line) } catch { return null } }).filter((entry) => entry?.correlationId === ok.payload.meta.correlationId).map((entry) => entry.stage)
    expect(healthyTrail).toEqual(['REQUEST_RECEIVED', 'AUTHZ_CHECKED', 'SOURCE_ATTEMPT_START', 'DNS_RESOLVED', 'TCP_CONNECTED', 'TLS_ESTABLISHED', 'HEADERS_RECEIVED', 'BODY_COMPLETE', 'CONTRACT_VALIDATED', 'RESPONSE_SENT'])
    const tlsEvent = JSON.parse(badTls.lines[0])
    const httpEvent = JSON.parse(badHttp.lines[0])
    expect(tlsEvent).toMatchObject({ stage: 'TCP_CONNECTED', failedStage: 'TLS_HANDSHAKE', nodeCode: 'CERT_NOT_YET_VALID', correlationId: badTls.payload.meta.correlationId })
    expect(tlsEvent.stages.map((s: { stage: string }) => s.stage)).toEqual(['REQUEST_RECEIVED', 'AUTHZ_CHECKED', 'SOURCE_ATTEMPT_START', 'DNS_RESOLVED', 'TCP_CONNECTED'])
    expect(httpEvent).toMatchObject({ stage: 'HEADERS_RECEIVED', failedStage: 'AWAIT_HEADERS', correlationId: badHttp.payload.meta.correlationId })
    expect(httpEvent.stages.map((s: { stage: string }) => s.stage)).toEqual(['REQUEST_RECEIVED', 'AUTHZ_CHECKED', 'SOURCE_ATTEMPT_START', 'DNS_RESOLVED', 'TCP_CONNECTED', 'TLS_ESTABLISHED', 'HEADERS_RECEIVED'])
    expect(new Set([ok.payload.meta.correlationId, tlsEvent.correlationId, httpEvent.correlationId]).size).toBe(3)
  } finally { releaseHttp.release(); releaseHealthy.release(); releaseFailureResponses.release(); log.mockRestore(); if (prior === undefined) delete process.env.OK_CONSOLE_TRACE; else process.env.OK_CONSOLE_TRACE = prior; await healthy.close(); await tls.close(); await http.close() }
})
it('distinguishes real reserved DNS failure from IP literal connection refusal', async () => {
  const closed = await listen(tcpServer()); await closed.close()
  for (const [host, nodeCode, failedStage] of [['missing.invalid', ['ENOTFOUND', 'EAI_AGAIN'], 'DNS'], ['127.0.0.1', ['ECONNREFUSED'], 'CONNECT']]) {
    const result = await request(environment(closed.port, { OK_CONSOLE_OBSERVED_STATE_URL: `https://${host}:${closed.port}/` }))
    expect(result.status).toBe(503)
    const event = JSON.parse(result.lines[0])
    expect(event).toMatchObject({ failedStage }); expect(nodeCode).toContain(event.nodeCode)
    expect(event.stages.map((s: { stage: string }) => s.stage)).not.toContain('DNS_RESOLVED')
    expect(event.phaseMs).not.toHaveProperty('dns')
  }
})

it('deterministically traces injected lookup ENOTFOUND at DNS', async () => {
  const realLookup = dns.lookup
  const lookup = vi.spyOn(dns, 'lookup').mockImplementation(((host: string, options: unknown, callback: (error: Error) => void) => {
    if (host !== 'missing.invalid') return Reflect.apply(realLookup, dns, [host, options, callback])
    callback(Object.assign(new Error('lookup failed'), { code: 'ENOTFOUND' }))
  }) as typeof dns.lookup)
  try {
    const result = await request(environment(1, { OK_CONSOLE_OBSERVED_STATE_URL: 'https://missing.invalid:1/' }))
    expect(result.status).toBe(503)
    const event = JSON.parse(result.lines[0])
    expect(event).toMatchObject({ nodeCode: 'ENOTFOUND', failedStage: 'DNS' })
    expect(event.stages.map((entry: { stage: string }) => entry.stage)).not.toContain('DNS_RESOLVED')
  } finally { lookup.mockRestore() }
})

it.each(['G1', 'G2'])('retains persistent offset on every real strict TLS failure after %s', async (geometry) => {
  let offset = 0, armed = false
  const realWall = Date.now.bind(Date)
  const wall = vi.spyOn(Date, 'now').mockImplementation(() => realWall() + offset)
  const healthy = await producer({}, (_req, res) => { if (armed && geometry === 'G1') offset = -645; res.writeHead(200, profile); res.end(body) })
  const future = await producer({ key: file('future.key'), cert: file('future.crt') })
  try {
    expect((await request(environment(healthy.port))).status).toBe(200)
    const baseline = processClock.clockOffsetMs ?? 0
    armed = true
    expect((await request(environment(healthy.port))).status).toBe(200)
    if (geometry === 'G2') offset = -645
    for (let i = 0; i < 3; i++) {
      const result = await request(environment(future.port))
      expect(result.status).toBe(503)
      expect(result.lines).toHaveLength(1)
      const event = JSON.parse(result.lines[0])
      expect(event).toMatchObject({ nodeCode: 'CERT_NOT_YET_VALID', failedStage: 'TLS_HANDSHAKE' })
      expect(event.clockOffsetMs - baseline).toBeGreaterThan(-670)
      expect(event.clockOffsetMs - baseline).toBeLessThan(-620)
      console.info('D4_R7_REAL_' + geometry + ' ' + result.lines[0])
    }
  } finally { wall.mockRestore(); await healthy.close(); await future.close() }
})
