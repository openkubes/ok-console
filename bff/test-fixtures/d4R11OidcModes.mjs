// Adapted reviewer reproduction: real openid-client 6.8.7 over strict local HTTPS.
// Generated test CA is trusted only by the disposable child, with normal TLS validation.
import { createServer } from 'node:https'
import { createServer as tcp } from 'node:net'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
import { issueTestCertificate } from './certificates.mjs'
import { createOidcHttpHandler, createOidcProtocolClient } from '../security/oidc.mjs'
const mode = process.argv[2]
const modes = ['bodycode', 'bodycodeallowed', 'bodycause', 'wrongname', 'untrusted', 'selfsigned', 'expired', 'future', 'html500', 'json500', 'notjson', 'malformedjson', 'noaccess', 'noid', 'badstate', 'grant', 'reset', 'enotfound', 'chainroot', 'chainintermediate', 'client401']
const scratch = process.env.RT_SCRATCH ?? '/tmp'
if (!process.env.D4_OIDC_TLS_DIR) {
  const root = mkdtempSync(join(scratch, 'ok-d4-r11-oidc-'))
  try {
    const openssl = (...args) => execFileSync('openssl', args, { cwd: root, stdio: 'ignore' })
    const ext = { ca: 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n', server: 'basicConstraints=CA:FALSE\nsubjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\n' }
    for (const [name, issuer, e, cn] of [['ca', 'ca', ext.ca, 'Test CA'], ['server', 'ca', ext.server, 'localhost'], ['wrongname', 'ca', 'basicConstraints=CA:FALSE\nsubjectAltName=DNS:other.invalid\nextendedKeyUsage=serverAuth\n', 'other.invalid'], ['ca2', 'ca2', ext.ca, 'Other CA'], ['untrusted', 'ca2', ext.server, 'localhost'], ['intermediate', 'ca2', ext.ca, 'Intermediate'], ['interleaf', 'intermediate', ext.server, 'localhost'], ['selfsigned', 'selfsigned', ext.server, 'localhost'], ['expired', 'ca', ext.server, 'localhost'], ['future', 'ca', ext.server, 'localhost']]) {
      openssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', name + '.key', '-out', name + '.csr', '-subj', '/CN=' + cn)
      issueTestCertificate({ root, name, issuer, selfSigned: name === issuer, extensions: e, ...(name === 'expired' ? { startDate: '20000101000000Z', endDate: '20010101000000Z' } : name === 'future' ? { startDate: '20990101000000Z', endDate: '21000101000000Z' } : {}) })
    }
    writeFileSync(join(root, 'chainroot.crt'), readFileSync(join(root, 'untrusted.crt'), 'utf8') + readFileSync(join(root, 'ca2.crt'), 'utf8'))
    writeFileSync(join(root, 'chainroot.key'), readFileSync(join(root, 'untrusted.key')))
    writeFileSync(join(root, 'chainintermediate.crt'), readFileSync(join(root, 'interleaf.crt'), 'utf8') + readFileSync(join(root, 'intermediate.crt'), 'utf8'))
    writeFileSync(join(root, 'chainintermediate.key'), readFileSync(join(root, 'interleaf.key')))
    for (const selected of mode === 'all' ? modes : [mode]) {
      const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), selected], { encoding: 'utf8', env: { ...process.env, NODE_EXTRA_CA_CERTS: join(root, 'ca.crt'), D4_OIDC_TLS_DIR: root }, timeout: 15000 })
      process.stdout.write(child.stdout ?? ''); process.stderr.write(child.stderr ?? '')
      if (child.error) throw child.error
      if (child.status !== 0) throw new Error('OIDC child failed: ' + selected)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
} else {
  const root = process.env.D4_OIDC_TLS_DIR
  const key = n => ({ key: readFileSync(join(root, n + '.key')), cert: readFileSync(join(root, n + '.crt')) })
  const sockets = new Set()
  const reset = tcp(socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('data', () => socket.resetAndDestroy()) })
  await new Promise(r => reset.listen(0, '127.0.0.1', r))
  const alt = createServer(key(['wrongname', 'selfsigned', 'expired', 'future', 'chainroot', 'chainintermediate'].includes(mode) ? mode : 'untrusted'), (q, s) => s.end('{}'))
  await new Promise(r => alt.listen(0, '127.0.0.1', r))
  const bodies = {
    client401: [401, 'application/json', JSON.stringify({ error: 'invalid_client' })],
    bodycode: [400, 'application/json', JSON.stringify({ error: 'invalid_grant', error_description: 'x', code: 'oidc.invalid_grant' })],
    bodycodeallowed: [400, 'application/json', JSON.stringify({ error: 'invalid_grant', code: 'ECONNREFUSED' })],
    bodycause: [400, 'application/json', JSON.stringify({ error: 'invalid_grant', cause: { code: '57P01' } })],
    html500: [500, 'text/html', '<html>oops</html>'],
    json500: [500, 'application/json', JSON.stringify({ message: 'boom' })],
    malformedjson: [200, 'application/json', '{broken'],
    noaccess: [200, 'application/json', JSON.stringify({ token_type: 'Bearer' })],
    noid: [200, 'application/json', JSON.stringify({ access_token: 'a', token_type: 'Bearer', expires_in: 60 })],
    notjson: [200, 'text/plain', 'hello'],
  }
  const server = createServer(key('server'), (request, response) => {
    const issuer = `https://127.0.0.1:${server.address().port}`
    if (request.url === '/.well-known/openid-configuration') {
      const token = mode === 'reset' ? `https://127.0.0.1:${reset.address().port}/token` : (['wrongname', 'untrusted', 'selfsigned', 'expired', 'future', 'chainroot', 'chainintermediate'].includes(mode)) ? `https://127.0.0.1:${alt.address().port}/token` : mode === 'enotfound' ? 'https://nonexistent-host.invalid/token' : issuer + '/token'
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ issuer, authorization_endpoint: issuer + '/auth', token_endpoint: token, jwks_uri: issuer + '/jwks', response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'] }))
    } else { if (mode === 'client401') response.setHeader('WWW-Authenticate', 'Basic realm="token", error="invalid_client"'); const [st, ct, b] = bodies[mode] ?? [400, 'application/json', '{"error":"invalid_grant"}']; response.statusCode = st; response.setHeader('content-type', ct); response.end(b) }
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const lines = [], original = console.error
  try {
    const protocol = await createOidcProtocolClient({ issuer: `https://127.0.0.1:${server.address().port}`, clientId: 'fixture', clientSecret: 'fixture', timeoutSeconds: 2 })
    const handler = createOidcHttpHandler({ protocol, transactionStore: { consume: async () => ({ codeVerifier: 'v'.repeat(43), state: 'st', nonce: 'n' }) }, sessionStore: {}, identityMapper: async () => null, redirectUri: 'https://console.invalid/callback' })
    const chain = []
    const origEx = protocol.exchange
    protocol.exchange = async (...a) => { try { return await origEx(...a) } catch (err) { let x = err; const seen = new Set(); while (x && typeof x === 'object' && !seen.has(x)) { seen.add(x); chain.push({ ctor: x.constructor?.name, ownCode: Object.getOwnPropertyDescriptor(x, 'code')?.value, msg: String(x.message ?? '').slice(0, 100), causeCtor: x.cause?.constructor?.name, causeStatus: x.cause?.status }); x = Object.getOwnPropertyDescriptor(x, 'cause')?.value } throw err } }
    console.error = line => lines.push(line)
    let status, body = ''
    await handler({ pathname: '/api/console/v0/auth/oidc/callback', correlationId: 'corr-00000000-0000-4000-8000-000000000003', request: { method: 'GET', url: `/cb?code=abc&state=${mode === 'badstate' ? 'other' : 'st'}`, headers: {} }, response: { setHeader() {}, writeHead(v) { status = v }, end(b) { body = String(b ?? '') } } })
    console.log(JSON.stringify({ mode, status, errorCode: lines[0] && JSON.parse(lines[0]).errorCode, cause: lines[0] && JSON.parse(lines[0]).cause, chain, body }))
  } finally {
    console.error = original
    server.closeAllConnections(); await new Promise(r => server.close(r)); alt.closeAllConnections(); await new Promise(r => alt.close(r))
    for (const s of sockets) s.destroy(); await new Promise(r => reset.close(r))
  }
}
