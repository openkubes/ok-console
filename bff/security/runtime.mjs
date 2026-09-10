import { timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { SessionEnvelopeCodec } from './envelope.mjs'
import { createLocalAccessVerifier, PostgresLocalAccessAudit, PostgresLocalAccessThrottle } from './localAccess.mjs'
import { createLocalAccessHttpHandler } from './localAccessHttp.mjs'
import { createOidcHttpHandler, createOidcProtocolClient, createStaticOidcIdentityMapper } from './oidc.mjs'
import { PostgresOidcTransactionStore } from './oidcTransactionStore.mjs'
import { PostgresSessionStore } from './postgresSessionStore.mjs'
import { validateSessionCreationInput, validSessionString } from './session.mjs'

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

const exactHttpsUrl = (value, label) => {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new SessionRuntimeConfigurationError(`${label} must be an exact HTTPS URL.`)
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.href !== value) {
    throw new SessionRuntimeConfigurationError(`${label} must be an exact HTTPS URL.`)
  }
  return url.href
}

const localRedirect = (value, expectedOrigin) => {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')
    || [...value].some((character) => character.charCodeAt(0) < 32)) {
    throw new SessionRuntimeConfigurationError('OK_CONSOLE_OIDC_SUCCESS_REDIRECT must be a local absolute path.')
  }
  const parsed = new URL(value, expectedOrigin)
  if (parsed.origin !== expectedOrigin) {
    throw new SessionRuntimeConfigurationError('OK_CONSOLE_OIDC_SUCCESS_REDIRECT must be a local absolute path.')
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`
}

const parseIdentityMappings = (content, providerId, environmentId) => {
  let document
  try {
    document = JSON.parse(content)
  } catch {
    throw new SessionRuntimeConfigurationError('The OIDC subject mapping file is invalid.')
  }
  if (!document || document.version !== 'v1' || !Array.isArray(document.subjects)
    || document.subjects.length < 1 || document.subjects.length > 10_000) {
    throw new SessionRuntimeConfigurationError('The OIDC subject mapping file is invalid.')
  }
  const seen = new Set()
  try {
    for (const mapping of document.subjects) {
      if (!mapping || !validSessionString(mapping.providerSubject) || seen.has(mapping.providerSubject)) throw new Error()
      seen.add(mapping.providerSubject)
      validateSessionCreationInput({
        subject: {
          id: mapping.identityId,
          providerId,
          subjectId: mapping.providerSubject,
          displayName: mapping.displayName,
          method: 'OIDC',
          assurance: mapping.assurance,
        },
        scope: { environmentId, tenantIds: mapping.tenantIds },
        permissions: mapping.permissions,
      })
    }
  } catch {
    throw new SessionRuntimeConfigurationError('The OIDC subject mapping file is invalid.')
  }
  return document.subjects
}

const parseLocalAccounts = (content, mode, environmentId) => {
  let document
  try { document = JSON.parse(content) } catch { throw new SessionRuntimeConfigurationError('The local-access account file is invalid.') }
  if (!document || document.version !== 'v1' || !Array.isArray(document.accounts)
    || document.accounts.length < 1 || document.accounts.length > 32) {
    throw new SessionRuntimeConfigurationError('The local-access account file is invalid.')
  }
  const seen = new Set()
  try {
    for (const account of document.accounts) {
      const normalized = account.username.normalize('NFKC').trim().toLowerCase()
      if (!validSessionString(normalized) || seen.has(normalized) || account.environmentId !== environmentId
        || typeof account.enabled !== 'boolean' || !/^[A-Za-z0-9+/]{22}==$/.test(account.salt)
        || !BASE64_32_BYTE_KEY_PATTERN.test(account.verifier)) throw new Error()
      seen.add(normalized)
      validateSessionCreationInput({
        subject: { id: account.identityId, providerId: 'local', subjectId: account.username, displayName: account.displayName, method: mode, assurance: ['Password', 'ExceptionalAccess'] },
        scope: { environmentId, tenantIds: account.tenantIds }, permissions: account.permissions,
      })
    }
  } catch { throw new SessionRuntimeConfigurationError('The local-access account file is invalid.') }
  return document.accounts
}

export const createSessionRuntime = async ({
  env = process.env,
  fileReader = readFile,
  poolFactory = (configuration) => new Pool(configuration),
  storeFactory = (configuration) => new PostgresSessionStore(configuration),
  transactionStoreFactory = (configuration) => new PostgresOidcTransactionStore(configuration),
  oidcProtocolFactory = createOidcProtocolClient,
  throttleFactory = (configuration) => new PostgresLocalAccessThrottle(configuration),
  auditFactory = (configuration) => new PostgresLocalAccessAudit(configuration),
} = {}) => {
  const mode = env.OK_CONSOLE_SESSION_STORE_MODE ?? 'disabled'
  if (mode === 'disabled') {
    if ((env.OK_CONSOLE_LOCAL_ACCESS_MODE ?? 'disabled') !== 'disabled') {
      throw new SessionRuntimeConfigurationError('Exceptional local access requires the PostgreSQL session runtime.')
    }
    if ((env.OK_CONSOLE_OBSERVED_STATE_MODE ?? 'fixture') !== 'fixture') {
      throw new SessionRuntimeConfigurationError('A non-fixture observed-state source requires the PostgreSQL session runtime.')
    }
    return { mode, sessionStore: null, expectedOrigin: undefined, authorizer: undefined, oidcHandler: null, localAccessHandler: null, ready: async () => true, close: async () => {} }
  }
  if (mode !== 'postgres') {
    throw new SessionRuntimeConfigurationError('OK_CONSOLE_SESSION_STORE_MODE must be disabled or postgres.')
  }

  const expectedOrigin = parseOrigin(required(env, 'OK_CONSOLE_ORIGIN'))
  const environmentId = required(env, 'OK_CONSOLE_ENVIRONMENT_ID')
  const tenantId = required(env, 'OK_CONSOLE_TENANT_ID')
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
    tenantId,
  })
  let oidcHandler = null
  if (env.OK_CONSOLE_OIDC_ENABLED === 'true') {
    try {
      const providerId = required(env, 'OK_CONSOLE_OIDC_PROVIDER_ID')
      const issuer = exactHttpsUrl(required(env, 'OK_CONSOLE_OIDC_ISSUER'), 'OK_CONSOLE_OIDC_ISSUER')
      const clientId = required(env, 'OK_CONSOLE_OIDC_CLIENT_ID')
      const clientSecret = await secretFile(required(env, 'OK_CONSOLE_OIDC_CLIENT_SECRET_FILE'), 'OK_CONSOLE_OIDC_CLIENT_SECRET_FILE', fileReader)
      const subjects = parseIdentityMappings(
        await secretFile(required(env, 'OK_CONSOLE_OIDC_SUBJECT_MAPPINGS_FILE'), 'OK_CONSOLE_OIDC_SUBJECT_MAPPINGS_FILE', fileReader),
        providerId,
        environmentId,
      )
      const redirectUri = `${expectedOrigin}/api/console/v0/auth/oidc/callback`
      const successRedirect = localRedirect(env.OK_CONSOLE_OIDC_SUCCESS_REDIRECT ?? '/', expectedOrigin)
      const protocol = await oidcProtocolFactory({
        issuer,
        clientId,
        clientSecret,
        timeoutSeconds: boundedInteger(env, 'OK_CONSOLE_OIDC_TIMEOUT_SECONDS', 5, 1, 30),
      })
      const transactionStore = transactionStoreFactory({ pool, codec, deploymentEpoch })
      const identityMapper = createStaticOidcIdentityMapper({
        providerId,
        environmentId,
        authorizationRevision,
        subjects,
      })
      oidcHandler = createOidcHttpHandler({
        protocol,
        transactionStore,
        sessionStore,
        identityMapper,
        redirectUri,
        successRedirect,
      })
    } catch (error) {
      await pool.end().catch(() => {})
      throw error
    }
  }
  let localAccessHandler = null
  const localAccessMode = env.OK_CONSOLE_LOCAL_ACCESS_MODE ?? 'disabled'
  if (!['disabled', 'bootstrap', 'breakglass'].includes(localAccessMode)) {
    await pool.end().catch(() => {})
    throw new SessionRuntimeConfigurationError('OK_CONSOLE_LOCAL_ACCESS_MODE must be disabled, bootstrap, or breakglass.')
  }
  if (localAccessMode !== 'disabled') {
    try {
      const oidcEnabled = env.OK_CONSOLE_OIDC_ENABLED === 'true'
      if ((localAccessMode === 'bootstrap' && oidcEnabled) || (localAccessMode === 'breakglass' && !oidcEnabled)) {
        throw new SessionRuntimeConfigurationError('Bootstrap requires OIDC disabled; breakglass requires OIDC enabled.')
      }
      const method = localAccessMode === 'bootstrap' ? 'Bootstrap' : 'BreakGlass'
      const accounts = parseLocalAccounts(
        await secretFile(required(env, 'OK_CONSOLE_LOCAL_ACCESS_ACCOUNTS_FILE'), 'OK_CONSOLE_LOCAL_ACCESS_ACCOUNTS_FILE', fileReader),
        method, environmentId,
      )
      const pepperValue = await secretFile(required(env, 'OK_CONSOLE_LOCAL_ACCESS_PEPPER_FILE'), 'OK_CONSOLE_LOCAL_ACCESS_PEPPER_FILE', fileReader)
      if (!BASE64_32_BYTE_KEY_PATTERN.test(pepperValue)) throw new SessionRuntimeConfigurationError('The local-access pepper file is invalid.')
      const pepper = Buffer.from(pepperValue, 'base64')
      const throttle = throttleFactory({ pool, pepper })
      const auditStore = auditFactory({ pool, pepper })
      const verifier = createLocalAccessVerifier({
        mode: method, accounts, throttle, sessionStore, authorizationRevision,
        audit: (event) => auditStore.record(event),
      })
      localAccessHandler = createLocalAccessHttpHandler({ verifier, expectedOrigin })
    } catch (error) {
      await pool.end().catch(() => {})
      throw error
    }
  }
  let closed = false
  const requiredRelations = [
    'ok_console.sessions',
    ...(env.OK_CONSOLE_OIDC_ENABLED === 'true' ? ['ok_console.oidc_transactions'] : []),
    ...(localAccessMode !== 'disabled' ? ['ok_console.local_access_throttle', 'ok_console.local_access_audit'] : []),
  ]
  const ready = async () => {
    try {
      const result = await pool.query(`
        SELECT COALESCE(bool_and(to_regclass(name) IS NOT NULL), false) AS ready
        FROM unnest($1::text[]) AS required(name)`, [requiredRelations])
      return result.rows[0]?.ready === true
    } catch {
      return false
    }
  }

  return {
    mode,
    sessionStore,
    expectedOrigin,
    authorizer,
    oidcHandler,
    localAccessHandler,
    ready,
    close: async () => {
      if (closed) return
      closed = true
      await pool.end()
    },
  }
}
