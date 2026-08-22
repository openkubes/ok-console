import { timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { SessionEnvelopeCodec } from './envelope.mjs'
import { PostgresSessionStore } from './postgresSessionStore.mjs'

const { Pool } = pg
const MAX_SECRET_FILE_BYTES = 64 * 1_024
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/
const BASE64_32_BYTE_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/

export class SessionRuntimeConfigurationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SessionRuntimeConfigurationError'
  }
}

const required = (env, name) => {
  const value = env[name]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SessionRuntimeConfigurationError(`${name} is required for the PostgreSQL session runtime.`)
  }
  return value.trim()
}

const boundedInteger = (env, name, fallback, minimum, maximum) => {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new SessionRuntimeConfigurationError(`${name} must be an integer between ${minimum} and ${maximum}.`)
  }
  return value
}

const secretFile = async (filename, label, fileReader) => {
  if (!path.isAbsolute(filename)) {
    throw new SessionRuntimeConfigurationError(`${label} must reference an absolute file path.`)
  }
  let content
  try {
    content = await fileReader(filename)
  } catch {
    throw new SessionRuntimeConfigurationError(`${label} could not be read.`)
  }
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content)
  if (bytes.length === 0 || bytes.length > MAX_SECRET_FILE_BYTES) {
    throw new SessionRuntimeConfigurationError(`${label} has an invalid size.`)
  }
  return bytes.toString('utf8').trim()
}

const exactRevision = (expected) => async ({ revision }) => {
  const actual = Buffer.from(String(revision ?? ''))
  const reference = Buffer.from(expected)
  return actual.length === reference.length && timingSafeEqual(actual, reference)
}

const parseOrigin = (value) => {
  let origin
  try {
    origin = new URL(value)
  } catch {
    throw new SessionRuntimeConfigurationError('OK_CONSOLE_ORIGIN must be an exact HTTPS origin.')
  }
  if (origin.protocol !== 'https:' || origin.origin !== value || origin.username || origin.password || origin.pathname !== '/') {
    throw new SessionRuntimeConfigurationError('OK_CONSOLE_ORIGIN must be an exact HTTPS origin.')
  }
  return origin.origin
}

const parseDatabaseUrl = (value, allowInsecureLoopback) => {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new SessionRuntimeConfigurationError('The PostgreSQL connection secret is invalid.')
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hash) {
    throw new SessionRuntimeConfigurationError('The PostgreSQL connection secret is invalid.')
  }
  for (const key of url.searchParams.keys()) {
    if (key.toLowerCase().startsWith('ssl')) {
      throw new SessionRuntimeConfigurationError('PostgreSQL TLS is configured only through the trusted runtime profile.')
    }
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (allowInsecureLoopback && !loopback) {
    throw new SessionRuntimeConfigurationError('Insecure PostgreSQL transport is restricted to loopback development.')
  }
  return url.toString()
}

const parseEnvelopeKeys = (content, primaryKeyId) => {
  let keys
  try {
    keys = JSON.parse(content)
  } catch {
    throw new SessionRuntimeConfigurationError('The session envelope key file is invalid.')
  }
  if (!keys || Array.isArray(keys) || typeof keys !== 'object') {
    throw new SessionRuntimeConfigurationError('The session envelope key file is invalid.')
  }
  const entries = Object.entries(keys)
  if (entries.length < 1 || entries.length > 8 || !entries.every(([id, value]) => KEY_ID_PATTERN.test(id)
    && typeof value === 'string' && BASE64_32_BYTE_KEY_PATTERN.test(value) && Buffer.from(value, 'base64').length === 32)) {
    throw new SessionRuntimeConfigurationError('The session envelope key file is invalid.')
  }
  if (!Object.hasOwn(keys, primaryKeyId)) {
    throw new SessionRuntimeConfigurationError('The primary session envelope key is not present in the key file.')
  }
  return keys
}

export const createSessionRuntime = async ({
  env = process.env,
  fileReader = readFile,
  poolFactory = (configuration) => new Pool(configuration),
  storeFactory = (configuration) => new PostgresSessionStore(configuration),
} = {}) => {
  const mode = env.OK_CONSOLE_SESSION_STORE_MODE ?? 'disabled'
  if (mode === 'disabled') {
    if ((env.OK_CONSOLE_OBSERVED_STATE_MODE ?? 'fixture') !== 'fixture') {
      throw new SessionRuntimeConfigurationError('A non-fixture observed-state source requires the PostgreSQL session runtime.')
    }
    return { mode, sessionStore: null, expectedOrigin: undefined, authorizer: undefined, close: async () => {} }
  }
  if (mode !== 'postgres') {
    throw new SessionRuntimeConfigurationError('OK_CONSOLE_SESSION_STORE_MODE must be disabled or postgres.')
  }

  const expectedOrigin = parseOrigin(required(env, 'OK_CONSOLE_ORIGIN'))
  const environmentId = required(env, 'OK_CONSOLE_ENVIRONMENT_ID')
  const deploymentEpoch = required(env, 'OK_CONSOLE_SESSION_EPOCH')
  const authorizationRevision = required(env, 'OK_CONSOLE_AUTHORIZATION_REVISION')
  const primaryKeyId = required(env, 'OK_CONSOLE_SESSION_ENVELOPE_PRIMARY_KEY_ID')
  if (!KEY_ID_PATTERN.test(primaryKeyId)) throw new SessionRuntimeConfigurationError('The primary session envelope key ID is invalid.')

  const connectionString = parseDatabaseUrl(
    await secretFile(required(env, 'OK_CONSOLE_POSTGRES_URL_FILE'), 'OK_CONSOLE_POSTGRES_URL_FILE', fileReader),
    env.OK_CONSOLE_POSTGRES_ALLOW_INSECURE_LOOPBACK === 'true',
  )
  const allowInsecureLoopback = env.OK_CONSOLE_POSTGRES_ALLOW_INSECURE_LOOPBACK === 'true'
  const ssl = allowInsecureLoopback
    ? false
    : {
        ca: await secretFile(required(env, 'OK_CONSOLE_POSTGRES_CA_FILE'), 'OK_CONSOLE_POSTGRES_CA_FILE', fileReader),
        rejectUnauthorized: true,
      }
  const keys = parseEnvelopeKeys(
    await secretFile(required(env, 'OK_CONSOLE_SESSION_ENVELOPE_KEYS_FILE'), 'OK_CONSOLE_SESSION_ENVELOPE_KEYS_FILE', fileReader),
    primaryKeyId,
  )
  const codec = new SessionEnvelopeCodec({ primaryKeyId, keys })

  const pool = poolFactory({
    connectionString,
    ssl,
    max: boundedInteger(env, 'OK_CONSOLE_POSTGRES_POOL_MAX', 10, 1, 50),
    connectionTimeoutMillis: boundedInteger(env, 'OK_CONSOLE_POSTGRES_CONNECT_TIMEOUT_MS', 5_000, 250, 60_000),
    idleTimeoutMillis: boundedInteger(env, 'OK_CONSOLE_POSTGRES_IDLE_TIMEOUT_MS', 30_000, 1_000, 300_000),
    statement_timeout: boundedInteger(env, 'OK_CONSOLE_POSTGRES_STATEMENT_TIMEOUT_MS', 5_000, 250, 60_000),
  })
  let sessionStore
  try {
    sessionStore = storeFactory({
      pool,
      codec,
      deploymentEpoch,
      authorizationRevisionValidator: exactRevision(authorizationRevision),
    })
  } catch (error) {
    await pool.end().catch(() => {})
    throw error
  }
  const authorizer = ({ request, permission }) => sessionStore.authorize(request.headers.cookie, {
    permission,
    environmentId,
  })
  let closed = false

  return {
    mode,
    sessionStore,
    expectedOrigin,
    authorizer,
    close: async () => {
      if (closed) return
      closed = true
      await pool.end()
    },
  }
}
