// Isolated process: an unhandled pg error makes this fixture exit nonzero.
import { createServer } from 'node:http'
import pg from 'pg'
import { PostgresLocalAccessThrottle, createLocalAccessVerifier } from '../security/localAccess.mjs'
import { createLocalAccessHttpHandler } from '../security/localAccessHttp.mjs'
import { createSessionRuntime } from '../security/runtime.mjs'

const scenario = process.argv[2]
const connectionString = process.env.OK_CONSOLE_TEST_POSTGRES_URL
const admin = new pg.Pool({ connectionString })
const pool = new pg.Pool({ connectionString, max: 1, statement_timeout: 5000, query_timeout: 6000,
  options: scenario.includes('idle') ? '-c idle_in_transaction_session_timeout=200' : undefined })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let kdf = 0, sessions = 0, fired = false
const throttle = new PostgresLocalAccessThrottle({ pool, pepper: Buffer.alloc(32, 5), afterStatement: async ({ client, sql }) => {
  if (fired || !sql.includes('FOR UPDATE')) return
  if (scenario.endsWith('reset') && kdf === 0) return
  fired = true
  if (scenario.startsWith('terminate')) {
    await admin.query('SELECT pg_terminate_backend($1)', [client.processID])
    await sleep(50)
  } else {
    const end = Date.now() + 350
    while (Date.now() < end) { /* scheduling stall between statements */ }
    await sleep(50)
  }
} })
const account = { username: 'reader', enabled: true, salt: Buffer.alloc(16).toString('base64'), verifier: Buffer.alloc(32, 2).toString('base64'), identityId: 'reader', displayName: 'Reader', environmentId: 'prod', tenantIds: ['platform'], permissions: ['platform.read'] }
const verifier = createLocalAccessVerifier({ mode: 'Bootstrap', accounts: [account], throttle,
  derive: async () => { kdf++; return Buffer.alloc(32, 2) }, sessionStore: { create: async () => { sessions++; return {} } } })
let handler = createLocalAccessHttpHandler({ verifier, expectedOrigin: 'https://console.invalid' })
let runtime
if (scenario === 'pool') {
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)
  // The injected pool already owns transport. Supply a valid runtime profile for either host type.
  const files = { url: connectionString, ca: 'test-only injected pool CA', keys: JSON.stringify({ key: Buffer.alloc(32, 1).toString('base64') }) }
  runtime = await createSessionRuntime({ env: {
    OK_CONSOLE_SESSION_STORE_MODE: 'postgres', OK_CONSOLE_ORIGIN: 'https://console.invalid', OK_CONSOLE_ENVIRONMENT_ID: 'prod',
    OK_CONSOLE_TENANT_ID: 'platform', OK_CONSOLE_SESSION_EPOCH: 'epoch', OK_CONSOLE_AUTHORIZATION_REVISION: 'revision',
    OK_CONSOLE_SESSION_ENVELOPE_PRIMARY_KEY_ID: 'key', OK_CONSOLE_SESSION_ENVELOPE_KEYS_FILE: '/keys', OK_CONSOLE_POSTGRES_URL_FILE: '/url',
    OK_CONSOLE_POSTGRES_ALLOW_INSECURE_LOOPBACK: String(loopback), OK_CONSOLE_POSTGRES_CA_FILE: '/ca',
  }, fileReader: async path => Buffer.from(files[path.slice(1)]), poolFactory: () => pool })
  await pool.query('SELECT 1')
  const idle = await pool.connect(), pid = idle.processID
  idle.release()
  await admin.query('SELECT pg_terminate_backend($1)', [pid])
  await sleep(100)
  // A new checkout must perform real work after the pool contained the idle error.
  handler = async ({ response }) => { const result = await pool.query('SELECT 42 AS answer'); response.writeHead(200); response.end(JSON.stringify(result.rows[0])); return true }
}
const server = createServer(async (request, response) => handler({ request, response, pathname: '/api/console/v0/auth/local', correlationId: 'corr-r3' }))
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/console/v0/auth/local`, {
    method: 'POST', headers: { origin: 'https://console.invalid', 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'reader', password: 'correct', reason: 'Emergency recovery verification' }),
  })
  console.log(JSON.stringify({ status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie'), kdf, sessions, fired, alive: true }))
} finally {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  if (runtime) await runtime.close()
  else await pool.end()
  await admin.end()
}
