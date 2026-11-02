// Real pg in an isolated process: removing the store listener must crash this child.
import pg from 'pg'
import { SessionEnvelopeCodec } from '../security/envelope.mjs'
import { PostgresSessionStore } from '../security/postgresSessionStore.mjs'
import { startErrorCode } from '../diagnostics.mjs'

const [operation, mode] = process.argv.slice(2)
const connectionString = process.env.OK_CONSOLE_TEST_POSTGRES_URL
const pool = new pg.Pool({ connectionString, max: 1,
  options: mode === 'idle' ? '-c idle_in_transaction_session_timeout=200' : undefined })
const admin = new pg.Pool({ connectionString })
const codec = new SessionEnvelopeCodec({ primaryKeyId: 'key', keys: { key: Buffer.alloc(32, 11) } })
const store = new PostgresSessionStore({ pool, codec, deploymentEpoch: 'r4' })
let fired = false
try {
  const issued = await store.create({
    subject: { id: 'user', providerId: 'test', subjectId: 'test', displayName: 'User', method: 'OIDC', assurance: ['Federated'] },
    scope: { environmentId: 'test', tenantIds: ['platform'] }, permissions: ['platform.read'], authorizationRevision: 'revision',
  })
  const connect = pool.connect.bind(pool)
  pool.connect = async () => {
    const client = await connect()
    const query = client.query.bind(client)
    client.query = async (...args) => {
      const result = await query(...args)
      if (!fired && String(args[0]).includes('FOR UPDATE')) {
        fired = true
        if (mode === 'terminate') await admin.query('SELECT pg_terminate_backend($1)', [client.processID])
        else {
          const until = Date.now() + 350
          while (Date.now() < until) { /* stall between transaction statements */ }
        }
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      return result
    }
    return client
  }
  const error = await store[operation](issued.cookie).catch(error => error)
  const failedPoolCount = pool.totalCount
  const next = await store[operation](issued.cookie)
  console.log(JSON.stringify({ alive: true, fired, code: error?.code, errorCode: startErrorCode(error), failedPoolCount,
    nextWorks: operation === 'rotate' ? typeof next?.cookie === 'string' : next === true }))
} finally {
  await pool.end()
  await admin.end()
}
