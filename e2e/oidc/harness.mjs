// Disposable OIDC proof harness (OK-173).
// Keycloak + PostgreSQL run in a uniquely named compose project bound to loopback; a test CA
// issues one leaf certificate for localhost; two in-process HTTPS proxies front Keycloak (the
// issuer) and the BFF (the Console origin, as an ingress would). The BFF trusts the issuer only
// through NODE_EXTRA_CA_CERTS, i.e. its normal TLS verification path. Nothing touches a cluster.
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import http from 'node:http'
import https from 'node:https'
import { randomBytes, scryptSync } from 'node:crypto'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

export const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const COMPOSE_FILE = fileURLToPath(new URL('./compose.yaml', import.meta.url))
const REALM_TEMPLATE = fileURLToPath(new URL('./realm-ok-e2e.json', import.meta.url))
const MIGRATIONS = fileURLToPath(new URL('../../bff/security/postgres/', import.meta.url))
export const BUILD_ROOT = `${ROOT}dist-e2e-oidc`
export const STATE_ENV = 'OK_OIDC_E2E_STATE_FILE'
export const MAPPED_SUBJECT = '6d3c1f3e-5f0a-4c55-9a52-173000000001'
// Must equal the fixture snapshot's environment: projections fail closed for any other scope.
export const ENVIRONMENT_ID = 'community-preview'
export const MODES = ['breakglass', 'bootstrap']
// The read-only Console projections need all three (bff/app.mjs); fewer yields FORBIDDEN.
const CONSOLE_READ_PERMISSIONS = ['platform.read', 'clusters.read', 'evidence.read']
const KDF = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1_024 * 1_024 }

const secret = (bytes = 24) => randomBytes(bytes).toString('base64url')
const freePort = () => new Promise((resolve, reject) => {
  const server = createNetServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)) })
})
const portFrom = async (name) => {
  if (!process.env[name]) return freePort()
  const port = Number(process.env[name])
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${name} must be a TCP port.`)
  return port
}
export const waitFor = async (label, probe, timeoutMs, intervalMs = 500) => {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try { const value = await probe(); if (value) return value } catch (error) { last = error }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`${label} did not become ready within ${timeoutMs} ms${last ? `: ${last.message}` : ''}`)
}

export const loadState = (path = process.env[STATE_ENV]) => {
  if (!path) throw new Error(`${STATE_ENV} is not set; run through playwright.oidc.config.ts.`)
  return JSON.parse(readFileSync(path, 'utf8'))
}
const saveState = (state) => writeFileSync(state.stateFile, JSON.stringify(state, null, 2), { mode: 0o600 })

const compose = (state, args) => execFileSync('docker', ['compose', '-p', state.composeProject, '-f', COMPOSE_FILE, ...args], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    OK_OIDC_E2E_ISSUER_ORIGIN: state.issuerOrigin,
    OK_OIDC_E2E_REALM_FILE: state.realmFile,
    OK_OIDC_E2E_KC_PORT: String(state.ports.keycloak),
    OK_OIDC_E2E_PG_PORT: String(state.ports.postgres),
    OK_OIDC_E2E_PG_PASSWORD: state.pgPassword,
  },
})

const createCertificates = (dir) => {
  const openssl = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' })
  openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=OK-173 disposable test CA',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    '-keyout', 'ca.key', '-out', 'ca.pem')
  openssl('req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-keyout', 'leaf.key', '-out', 'leaf.csr')
  writeFileSync(`${dir}/leaf.ext`, 'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n')
  openssl('x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '1', '-extfile', 'leaf.ext', '-out', 'leaf.pem')
  return { ca: `${dir}/ca.pem`, cert: `${dir}/leaf.pem`, key: `${dir}/leaf.key` }
}

// Buffers each exchange so the issuer proxy can record token-endpoint traffic. The recording is
// what the leak scanners search for; it stays in the run's temp directory and is never copied out.
const startProxy = ({ listenPort, targetPort, tls, tapFile }) => new Promise((resolve, reject) => {
  const server = https.createServer({ key: readFileSync(tls.key), cert: readFileSync(tls.cert) }, (request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks)
      const headers = { ...request.headers, 'x-forwarded-proto': 'https', 'x-forwarded-host': request.headers.host ?? '', 'x-forwarded-port': String(listenPort) }
      delete headers['accept-encoding']
      const upstream = http.request({ host: '127.0.0.1', port: targetPort, method: request.method, path: request.url, headers }, (reply) => {
        const parts = []
        reply.on('data', (chunk) => parts.push(chunk))
        reply.on('end', () => {
          const replyBody = Buffer.concat(parts)
          if (tapFile && request.method === 'POST' && request.url.split('?')[0].endsWith('/protocol/openid-connect/token')) {
            appendFileSync(tapFile, `${JSON.stringify({ request: body.toString('utf8'), authorization: request.headers.authorization ?? '', response: replyBody.toString('utf8') })}\n`, { mode: 0o600 })
          }
          const replyHeaders = { ...reply.headers }
          delete replyHeaders['transfer-encoding']
          delete replyHeaders.connection
          replyHeaders['content-length'] = String(replyBody.length)
          response.writeHead(reply.statusCode ?? 502, replyHeaders)
          response.end(replyBody)
        })
      })
      upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end() })
      upstream.end(body)
    })
  })
  server.once('error', reject)
  server.listen(listenPort, '127.0.0.1', () => resolve(server))
})

const httpsJson = (url, ca) => new Promise((resolve, reject) => {
  https.get(url, { ca }, (response) => {
    const parts = []
    response.on('data', (chunk) => parts.push(chunk))
    response.on('end', () => {
      if (response.statusCode !== 200) return reject(new Error(`HTTP ${response.statusCode}`))
      try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))) } catch (error) { reject(error) }
    })
  }).on('error', reject)
})

const applyMigrations = async (url) => {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    for (const file of (await readdir(MIGRATIONS)).filter((name) => name.endsWith('.sql')).sort()) {
      await client.query(await readFile(`${MIGRATIONS}${file}`, 'utf8'))
    }
  } finally { await client.end() }
}

export const buildModes = () => {
  for (const mode of MODES) {
    if (process.env.OK_OIDC_E2E_SKIP_BUILD === 'true' && existsSync(`${BUILD_ROOT}/${mode}/index.html`)) continue
    execFileSync('pnpm', ['exec', 'vite', 'build', '--outDir', `${BUILD_ROOT}/${mode}`, '--emptyOutDir'], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, VITE_CONSOLE_DATA_MODE: 'bff', VITE_CONSOLE_AUTH_MODE: mode },
    })
  }
}

const localAccount = (username, password, displayName) => {
  const salt = randomBytes(16)
  return {
    username, enabled: true, salt: salt.toString('base64'),
    verifier: scryptSync(password, salt, 32, KDF).toString('base64'),
    identityId: `${username}-id`, displayName, environmentId: ENVIRONMENT_ID,
    tenantIds: ['platform'], permissions: CONSOLE_READ_PERMISSIONS,
  }
}

const put = async (state, name, value, mode = 0o600) => {
  const path = `${state.dir}/${name}`
  await writeFile(path, value, { mode })
  return path
}

const processAlive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

export const stopBff = async (state) => {
  if (!state.bffPid || !processAlive(state.bffPid)) return
  try { process.kill(-state.bffPid, 'SIGTERM') } catch { process.kill(state.bffPid, 'SIGTERM') }
  try {
    await waitFor('BFF shutdown', () => !processAlive(state.bffPid), 10_000, 100)
  } catch {
    try { process.kill(-state.bffPid, 'SIGKILL') } catch { /* already gone */ }
    await waitFor('BFF kill', () => !processAlive(state.bffPid), 5_000, 100)
  }
}

// mode 'breakglass': OIDC primary + break-glass exceptional path (the OK-173 target).
// mode 'bootstrap': the documented rollback: OIDC disabled, bootstrap-only local access.
export const startBff = async (state, mode, { epoch = state.epoch } = {}) => {
  if (!MODES.includes(mode)) throw new Error(`Unknown BFF mode ${mode}`)
  await stopBff(state)
  await rm(`${ROOT}dist`, { recursive: true, force: true })
  await cp(`${BUILD_ROOT}/${mode}`, `${ROOT}dist`, { recursive: true })
  const account = mode === 'breakglass'
    ? localAccount('breakglass-operator', state.passwords.local, 'Break-glass Operator')
    : localAccount('bootstrap-admin', state.passwords.local, 'Bootstrap Admin')
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: 'production',
    NODE_EXTRA_CA_CERTS: state.tls.ca,
    OK_CONSOLE_BFF_HOST: '127.0.0.1',
    OK_CONSOLE_BFF_PORT: String(state.ports.bff),
    OK_CONSOLE_ORIGIN: state.origin,
    OK_CONSOLE_OBSERVED_STATE_MODE: 'fixture',
    OK_CONSOLE_SESSION_STORE_MODE: 'postgres',
    OK_CONSOLE_ENVIRONMENT_ID: ENVIRONMENT_ID,
    OK_CONSOLE_TENANT_ID: 'platform',
    OK_CONSOLE_SESSION_EPOCH: epoch,
    OK_CONSOLE_AUTHORIZATION_REVISION: 'ok173-e2e-revision-1',
    OK_CONSOLE_SESSION_ENVELOPE_PRIMARY_KEY_ID: 'ok173-e2e-key',
    OK_CONSOLE_SESSION_ENVELOPE_KEYS_FILE: await put(state, 'envelope-keys.json', JSON.stringify({ 'ok173-e2e-key': state.envelopeKey })),
    OK_CONSOLE_POSTGRES_URL_FILE: await put(state, 'postgres-url', state.pgUrl),
    OK_CONSOLE_POSTGRES_ALLOW_INSECURE_LOOPBACK: 'true',
    OK_CONSOLE_LOCAL_ACCESS_MODE: mode,
    OK_CONSOLE_LOCAL_ACCESS_ACCOUNTS_FILE: await put(state, `${mode}-accounts.json`, JSON.stringify({ version: 'v1', accounts: [account] })),
    OK_CONSOLE_LOCAL_ACCESS_PEPPER_FILE: await put(state, 'pepper', state.pepper),
  }
  if (mode === 'breakglass') {
    Object.assign(env, {
      OK_CONSOLE_OIDC_ENABLED: 'true',
      OK_CONSOLE_OIDC_PROVIDER_ID: 'ok-e2e-keycloak',
      OK_CONSOLE_OIDC_ISSUER: state.issuer,
      OK_CONSOLE_OIDC_CLIENT_ID: state.clientId,
      OK_CONSOLE_OIDC_CLIENT_SECRET_FILE: await put(state, 'oidc-client-secret', state.clientSecret),
      OK_CONSOLE_OIDC_SUBJECT_MAPPINGS_FILE: await put(state, 'oidc-subjects.json', JSON.stringify({
        version: 'v1',
        subjects: [{ providerSubject: MAPPED_SUBJECT, identityId: 'mapped-operator-id', displayName: 'Mapped Operator', assurance: ['Federated'], tenantIds: ['platform'], permissions: CONSOLE_READ_PERMISSIONS }],
      })),
    })
  }
  appendFileSync(state.bffLog, `\n=== BFF start mode=${mode} epoch=${epoch} ===\n`)
  const fd = openSync(state.bffLog, 'a')
  const child = spawn(process.execPath, ['bff/server.mjs'], { cwd: ROOT, env, stdio: ['ignore', fd, fd], detached: true })
  closeSync(fd)
  child.unref()
  state.bffPid = child.pid
  state.mode = mode
  state.epochInUse = epoch
  saveState(state)
  await waitFor('BFF readiness', async () => {
    if (!processAlive(child.pid)) throw new Error(`BFF exited; see ${state.bffLog}`)
    return new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: state.ports.bff, path: '/health/ready' }, (response) => { response.resume(); resolve(response.statusCode === 204) })
        .on('error', () => resolve(false))
    })
  }, 60_000, 250)
  return state
}

export const startHarness = async () => {
  // Docker Desktop shares the host temp dir; Colima/Rancher Desktop may share only $HOME.
  const dir = await mkdtemp(`${process.env.OK_OIDC_E2E_TMPDIR ?? tmpdir()}/ok173-oidc-`)
  let ports
  for (let attempt = 0; attempt < 5; attempt += 1) {
    ports = {
      keycloak: await portFrom('OK_OIDC_E2E_KC_PORT'),
      postgres: await portFrom('OK_OIDC_E2E_PG_PORT'),
      bff: await portFrom('OK_OIDC_E2E_BFF_PORT'),
      issuerProxy: await portFrom('OK_OIDC_E2E_ISSUER_PROXY_PORT'),
      consoleProxy: await portFrom('OK_OIDC_E2E_PROXY_PORT'),
    }
    if (new Set(Object.values(ports)).size === 5) break
  }
  if (new Set(Object.values(ports)).size !== 5) throw new Error('The OIDC proof needs five distinct ports.')
  const issuerOrigin = `https://localhost:${ports.issuerProxy}`
  const origin = `https://localhost:${ports.consoleProxy}`
  const state = {
    dir, ports, issuerOrigin, origin,
    stateFile: `${dir}/state.json`,
    issuer: `${issuerOrigin}/realms/ok-e2e`,
    clientId: 'ok-console-e2e',
    clientSecret: secret(32),
    passwords: { mapped: secret(18), unmapped: secret(18), local: secret(18) },
    pgPassword: secret(18),
    envelopeKey: randomBytes(32).toString('base64'),
    pepper: randomBytes(32).toString('base64'),
    epoch: 'ok173-e2e-epoch-1',
    composeProject: `ok173-oidc-${process.pid}-${randomBytes(3).toString('hex')}`,
    tapFile: `${dir}/issuer-token-tap.jsonl`,
    bffLog: `${dir}/bff.log`,
    tls: createCertificates(dir),
  }
  state.pgUrl = `postgres://postgres:${encodeURIComponent(state.pgPassword)}@127.0.0.1:${ports.postgres}/ok_console`
  const realm = (await readFile(REALM_TEMPLATE, 'utf8'))
    .replace('__CLIENT_SECRET__', state.clientSecret)
    .replace('__REDIRECT_URI__', `${origin}/api/console/v0/auth/oidc/callback`)
    .replace('__CONSOLE_ORIGIN__', origin)
    .replace('__MAPPED_PASSWORD__', state.passwords.mapped)
    .replace('__UNMAPPED_PASSWORD__', state.passwords.unmapped)
  state.realmFile = await put(state, 'realm-ok-e2e.json', realm, 0o644)
  writeFileSync(state.tapFile, '', { mode: 0o600 })
  writeFileSync(state.bffLog, '', { mode: 0o600 })
  saveState(state)
  process.env[STATE_ENV] = state.stateFile
  const proxies = []
  // Installed before anything starts, so an interrupt during image pull or Keycloak boot still
  // removes the compose project, its volumes, the temp dir and restores dist/.
  const onSignal = (signal) => { stopHarness(state, proxies).finally(() => process.exit(signal === 'SIGINT' ? 130 : 143)) }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, onSignal)
  const dispose = () => { for (const signal of ['SIGINT', 'SIGTERM']) process.off(signal, onSignal) }
  // The BFF serves the fixed dist/ directory; keep the developer's build and restore it on stop.
  if (existsSync(`${ROOT}dist`)) {
    state.distBackup = `${BUILD_ROOT}/.dist-backup-${process.pid}`
    await rm(state.distBackup, { recursive: true, force: true })
    await mkdir(BUILD_ROOT, { recursive: true })
    await rename(`${ROOT}dist`, state.distBackup)
    saveState(state)
  }
  try {
    compose(state, ['up', '-d', '--quiet-pull'])
    proxies.push(await startProxy({ listenPort: ports.issuerProxy, targetPort: ports.keycloak, tls: state.tls, tapFile: state.tapFile }))
    proxies.push(await startProxy({ listenPort: ports.consoleProxy, targetPort: ports.bff, tls: state.tls }))
    await waitFor('PostgreSQL', async () => { await applyMigrations(state.pgUrl); return true }, 60_000, 1_000)
    const ca = readFileSync(state.tls.ca)
    await waitFor('Keycloak discovery', async () => (await httpsJson(`${state.issuer}/.well-known/openid-configuration`, ca)).issuer === state.issuer, 180_000, 2_000)
    await startBff(state, 'breakglass')
  } catch (error) {
    dispose()
    await stopHarness(state, proxies)
    throw error
  }
  return { state, proxies, dispose }
}

// One cleanup per run, whichever of teardown, SIGINT or SIGTERM asks first: a second pass could
// otherwise delete the dist/ the first one restored.
const stopping = new Map()
export const stopHarness = (state, proxies = []) => {
  if (!stopping.has(state.stateFile)) stopping.set(state.stateFile, cleanup(state, proxies))
  return stopping.get(state.stateFile)
}

const cleanup = async (state, proxies) => {
  const current = existsSync(state.stateFile) ? loadState(state.stateFile) : state
  await stopBff(current).catch(() => {})
  await Promise.all(proxies.map((server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()) })))
  let composeFailure
  try { compose(current, ['down', '-v', '--remove-orphans', '--timeout', '5']) } catch (error) { composeFailure = error }
  if (current.distBackup && existsSync(current.distBackup)) {
    await rm(`${ROOT}dist`, { recursive: true, force: true })
    await rename(current.distBackup, `${ROOT}dist`)
  } else {
    await rm(`${ROOT}dist`, { recursive: true, force: true })
  }
  const evidence = `${ROOT}test-results/e2e-oidc`
  await mkdir(evidence, { recursive: true }).then(() => cp(current.bffLog, `${evidence}/bff.log`)).catch(() => {})
  if (composeFailure) {
    // Keep the run directory: it holds the compose project name and inputs needed to clean up.
    throw new Error(`docker compose down failed for project ${current.composeProject}; run directory kept at ${current.dir}: ${composeFailure.message}`)
  }
  if (process.env.OK_OIDC_E2E_KEEP !== 'true') await rm(current.dir, { recursive: true, force: true })
}
