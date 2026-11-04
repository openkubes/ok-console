// Real openid-client against a disposable HTTPS issuer, with a test CA trusted
// only by the child process. Production TLS options are unchanged.
import { createServer } from 'node:https'
import { createServer as tcp } from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
import { issueTestCertificate } from './certificates.mjs'
import { createOidcHttpHandler, createOidcProtocolClient } from '../security/oidc.mjs'
const mode = process.argv[2]
if (!process.env.D4_OIDC_TLS_DIR) {
  const root = mkdtempSync(join(tmpdir(), 'ok-d4-oidc-'))
  try {
    const openssl = (...args) => execFileSync('openssl', args, { cwd: root, stdio: 'ignore' })
    for (const name of ['ca', 'server']) {
      openssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', name + '.key', '-out', name + '.csr', '-subj', '/CN=' + (name === 'server' ? 'localhost' : 'Test CA'))
      issueTestCertificate({ root, name, issuer: 'ca', selfSigned: name === 'ca', extensions: name === 'server' ? 'basicConstraints=CA:FALSE\nsubjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\n' : 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n' })
    }
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), mode], { encoding: 'utf8', env: { ...process.env, NODE_EXTRA_CA_CERTS: join(root, 'ca.crt'), D4_OIDC_TLS_DIR: root }, timeout: 10000 })
    process.stdout.write(child.stdout ?? '')
    process.stderr.write(child.stderr ?? '')
    if (child.error) throw child.error
    process.exitCode = child.status ?? 1
  } finally { rmSync(root, { recursive: true, force: true }) }
} else {
  const root = process.env.D4_OIDC_TLS_DIR
  const sockets = new Set()
  const silent = tcp(socket => { sockets.add(socket); socket.on('error', () => {}) })
  await new Promise(resolve => silent.listen(0, '127.0.0.1', resolve))
  const closed = tcp()
  await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve))
  const closedPort = closed.address().port
  await new Promise(resolve => closed.close(resolve))
  const server = createServer({ key: readFileSync(join(root, 'server.key')), cert: readFileSync(join(root, 'server.crt')) }, (request, response) => {
    const issuer = `https://127.0.0.1:${server.address().port}`
    response.setHeader('content-type', 'application/json')
    if (request.url === '/.well-known/openid-configuration') {
      const token = mode === 'refused' ? `https://127.0.0.1:${closedPort}/token` : mode === 'silent' ? `https://127.0.0.1:${silent.address().port}/token` : issuer + '/token'
      response.end(JSON.stringify({ issuer, authorization_endpoint: issuer + '/auth', token_endpoint: token, jwks_uri: issuer + '/jwks', response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'] }))
    } else { response.statusCode = 400; response.end(JSON.stringify({ error: 'invalid_grant' })) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const lines = [], original = console.error
  try {
    const protocol = await createOidcProtocolClient({ issuer: `https://127.0.0.1:${server.address().port}`, clientId: 'fixture', clientSecret: 'fixture', timeoutSeconds: 2 })
    const handler = createOidcHttpHandler({ protocol, transactionStore: { consume: async () => ({ codeVerifier: 'v'.repeat(43), state: 'st', nonce: 'n' }) }, sessionStore: {}, identityMapper: async () => null, redirectUri: 'https://console.invalid/callback' })
    console.error = line => lines.push(line)
    let status
    await handler({ pathname: '/api/console/v0/auth/oidc/callback', correlationId: 'corr-00000000-0000-4000-8000-000000000003', request: { method: 'GET', url: `/cb?code=abc&state=${mode === 'badstate' ? 'other' : 'st'}`, headers: {} }, response: { setHeader() {}, writeHead(value) { status = value }, end() {} } })
    console.log(JSON.stringify({ mode, status, lines }))
  } finally {
    console.error = original
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => silent.close(resolve))
  }
}
