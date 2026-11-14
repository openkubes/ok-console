// Run in a child so its disposable CA is trusted without weakening TLS checks.
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { createServer } from 'node:https'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { format } from 'node:util'
import { execFileSync, spawnSync } from 'node:child_process'
import { issueTestCertificate } from './certificates.mjs'
import { createOidcHttpHandler, createOidcProtocolClient, createStaticOidcIdentityMapper } from '../security/oidc.mjs'
import { oidcTransactionCookie } from '../security/oidcTransactionStore.mjs'
import { InMemorySessionStore } from '../security/session.mjs'

const clientId = 'callback-fixture'
const clientSecret = 'disposable-fixture-secret'
const callbackPath = '/api/console/v0/auth/oidc/callback'
const redirectUri = 'https://console.invalid' + callbackPath
const clearedTransaction = '__Host-ok_console_oidc=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0'
const opaque = () => randomBytes(32).toString('base64url')
const challenge = value => createHash('sha256').update(value).digest('base64url')
const modes = ['positive', 'wrong-iss', 'wrong-aud', 'multi-aud-no-azp', 'multi-aud-foreign-azp', 'nonce', 'state', 'pkce', 'redirect', 'expired', 'replay', 'single-aud-foreign-azp']

export const createCallbackIssuer = async root => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'callback-key', alg: 'RS256', use: 'sig' }
  const codes = new Map()
  const records = { discovery: 0, jwks: 0, tokenRequests: 0, redemptions: 0, idTokens: [], accessTokens: [], rejected: [] }
  let issuer
  const server = createServer({ key: readFileSync(join(root, 'server.key')), cert: readFileSync(join(root, 'server.crt')) }, async (request, response) => {
    const json = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)) }
    if (request.method === 'GET' && request.url === '/.well-known/openid-configuration') {
      records.discovery++
      json(200, { issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token', jwks_uri: issuer + '/jwks', response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_basic'] })
    } else if (request.method === 'GET' && request.url === '/jwks') {
      records.jwks++
      json(200, { keys: [jwk] })
    } else if (request.method === 'POST' && request.url === '/token') {
      records.tokenRequests++
      const basic = request.headers.authorization
      let credentials = []
      try {
        if (basic?.startsWith('Basic ')) credentials = Buffer.from(basic.slice(6), 'base64').toString().split(':').map(value => decodeURIComponent(value.replaceAll('+', ' ')))
      } catch { /* Malformed credentials fail closed below. */ }
      if (credentials.length !== 2 || credentials[0] !== clientId || credentials[1] !== clientSecret) { records.rejected.push('client'); return json(401, { error: 'invalid_client' }) }
      let body = ''
      for await (const chunk of request) body += chunk
      const parameters = new URLSearchParams(body)
      const code = parameters.get('code')
      const bound = codes.get(code)
      codes.delete(code)
      const rejected = !bound ? 'code' : parameters.get('grant_type') !== 'authorization_code' ? 'grant_type' : parameters.get('redirect_uri') !== bound.redirectUri ? 'redirect_uri' : challenge(parameters.get('code_verifier') ?? '') !== bound.challenge ? 'pkce' : null
      if (rejected) { records.rejected.push(rejected); return json(400, { error: 'invalid_grant' }) }
      records.redemptions++
      const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
      const payload = encode({ iss: issuer, aud: clientId, sub: 'fixture-subject', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, nonce: bound.nonce, ...bound.claims })
      const input = encode({ alg: 'RS256', kid: jwk.kid, typ: 'JWT' }) + '.' + payload
      const idToken = input + '.' + sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')
      const accessToken = opaque()
      records.idTokens.push(idToken); records.accessTokens.push(accessToken)
      json(200, { token_type: 'Bearer', access_token: accessToken, id_token: idToken, expires_in: 300 })
    } else json(404, { error: 'not_found' })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  issuer = `https://127.0.0.1:${server.address().port}`
  return {
    issuer, records,
    mint: bound => { const code = opaque(); codes.set(code, bound); return code },
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) },
  }
}

const flow = async (root, mode) => {
  const fixture = await createCallbackIssuer(root)
  const transactions = new Map(), audit = [], lines = []
  const originals = Object.fromEntries(['error', 'warn', 'log', 'info', 'debug'].map(method => [method, console[method]]))
  try {
    for (const method of Object.keys(originals)) console[method] = (...args) => lines.push(format(...args))
    const protocol = await createOidcProtocolClient({ issuer: fixture.issuer, clientId, clientSecret })
    const sessionStore = new InMemorySessionStore()
    const transactionStore = {
      create: async payload => { const reference = opaque(); transactions.set(reference, payload); return { cookie: oidcTransactionCookie(reference) } },
      consume: async cookie => {
        const reference = cookie?.split(';')[0].split('=')[1]
        const payload = transactions.get(reference)
        transactions.delete(reference)
        return payload
      },
    }
    const identityMapper = createStaticOidcIdentityMapper({ providerId: 'fixture', environmentId: 'test', authorizationRevision: '1', subjects: [{ providerSubject: 'fixture-subject', identityId: 'user', displayName: 'Fixture', assurance: ['Federated'], tenantIds: ['test'], permissions: ['platform.read'] }] })
    const handler = createOidcHttpHandler({ protocol, transactionStore, sessionStore, identityMapper, redirectUri, audit: async event => { audit.push(event) } })
    const invoke = async (pathname, url, cookie) => {
      const result = {}
      await handler({ pathname, correlationId: 'corr-00000000-0000-4000-8000-000000000163', request: { method: 'GET', url, headers: { cookie, host: 'request-host.invalid', 'x-forwarded-host': 'forwarded-host.invalid', 'x-forwarded-proto': 'http' } }, response: {
        setHeader() {}, writeHead(status, headers) { Object.assign(result, { status, headers }) }, end(body) { result.body = body },
      } })
      return result
    }
    const start = await invoke('/api/console/v0/auth/oidc/start', '/api/console/v0/auth/oidc/start')
    if (start.status !== 302 || transactions.size !== 1) throw new Error('Fixture start failed')
    const location = new URL(start.headers.Location)
    const cookie = start.headers['Set-Cookie'].split(';')[0]
    const transaction = [...transactions.values()][0]
    const claims = {}
    if (mode === 'wrong-iss') claims.iss = 'https://foreign.invalid'
    if (mode === 'wrong-aud') claims.aud = 'foreign-client'
    if (mode.startsWith('multi-aud')) claims.aud = [clientId, 'foreign-client']
    if (mode.endsWith('foreign-azp')) claims.azp = 'foreign-client'
    if (mode === 'nonce') claims.nonce = opaque()
    if (mode === 'expired') claims.exp = Math.floor(Date.now() / 1000) - 3600
    const code = fixture.mint({ nonce: location.searchParams.get('nonce'), challenge: mode === 'pkce' ? challenge(opaque()) : location.searchParams.get('code_challenge'), redirectUri: mode === 'redirect' ? 'https://foreign.invalid/callback' : location.searchParams.get('redirect_uri'), claims })
    const state = mode === 'state' ? opaque() : location.searchParams.get('state')
    const url = callbackPath + '?' + new URLSearchParams({ code, state })
    audit.length = 0; lines.length = 0
    const snapshot = result => {
      const setCookie = result.headers['Set-Cookie']
      const cookies = Array.isArray(setCookie) ? setCookie : [setCookie]
      const serialized = JSON.stringify({ audit, lines })
      const material = { code: [code], state: [state, transaction.state], nonce: [transaction.nonce, ...(claims.nonce ? [claims.nonce] : [])], code_verifier: [transaction.codeVerifier], id_token: fixture.records.idTokens, access_token: fixture.records.accessTokens }
      return { status: result.status, error: result.body ? JSON.parse(result.body).error?.code : null, cookieNames: cookies.map(value => value.split('=')[0]), onlyClearTransaction: cookies.length === 1 && cookies[0] === clearedTransaction, sessions: sessionStore.sessions.size, transactions: transactions.size, audit: structuredClone(audit), leaks: Object.keys(material).filter(key => material[key].some(value => serialized.includes(value))), tokenRequests: fixture.records.tokenRequests, redemptions: fixture.records.redemptions, signedTokens: fixture.records.idTokens.length, jwks: fixture.records.jwks }
    }
    const first = snapshot(await invoke(callbackPath, url, cookie))
    let replay
    if (mode === 'replay') {
      audit.length = 0; lines.length = 0
      replay = snapshot(await invoke(callbackPath, url, cookie))
    }
    return { mode, rejected: fixture.records.rejected, start: { status: start.status, method: location.searchParams.get('code_challenge_method'), challengeMatches: location.searchParams.get('code_challenge') === challenge(transaction.codeVerifier), stateMatches: location.searchParams.get('state') === transaction.state, nonceMatches: location.searchParams.get('nonce') === transaction.nonce }, first, replay }
  } finally {
    Object.assign(console, originals)
    await fixture.close()
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.OIDC_CALLBACK_TLS_DIR) {
    const root = mkdtempSync(join(tmpdir(), 'ok-oidc-callback-'))
    try {
      for (const name of ['ca', 'server']) {
        execFileSync('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', name + '.key', '-out', name + '.csr', '-subj', '/CN=' + (name === 'ca' ? 'Callback Test CA' : 'localhost')], { cwd: root, stdio: 'ignore' })
        issueTestCertificate({ root, name, selfSigned: name === 'ca', extensions: name === 'ca' ? 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n' : 'basicConstraints=CA:FALSE\nsubjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' })
      }
      const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { encoding: 'utf8', timeout: 60000, env: { ...process.env, OIDC_CALLBACK_TLS_DIR: root, NODE_EXTRA_CA_CERTS: join(root, 'ca.crt') } })
      process.stdout.write(child.stdout ?? ''); process.stderr.write(child.stderr ?? '')
      if (child.error) throw child.error
      process.exitCode = child.status ?? 1
    } finally { rmSync(root, { recursive: true, force: true }) }
  } else {
    for (const mode of modes) console.log(JSON.stringify(await flow(process.env.OIDC_CALLBACK_TLS_DIR, mode)))
  }
}
