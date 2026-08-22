import { createHmac, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(nodeScrypt)
const KDF = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1_024 * 1_024 }
const DUMMY_SALT = Buffer.alloc(16, 91)
const DUMMY_VERIFIER = Buffer.alloc(32, 173)

const normalize = (value) => typeof value === 'string' ? value.normalize('NFKC').trim().toLowerCase() : ''
const validInput = ({ username, password, reason }) => username.length >= 1 && username.length <= 128
  && typeof password === 'string' && password.length >= 1 && password.length <= 1024
  && typeof reason === 'string' && reason.trim().length >= 12 && reason.length <= 512

export class LocalAccessError extends Error {
  constructor(code = 'LOCAL_ACCESS_REJECTED') {
    super('Exceptional local access was rejected.')
    this.name = 'LocalAccessError'
    this.code = code
  }
}

export class PostgresLocalAccessThrottle {
  constructor({ pool, pepper }) {
    if (!pool?.query || !Buffer.isBuffer(pepper) || pepper.length < 32) throw new LocalAccessError('INVALID_CONFIGURATION')
    this.pool = pool
    this.pepper = pepper
  }

  digest(username) {
    return createHmac('sha256', this.pepper).update(username).digest('base64url')
  }

  async blocked(username) {
    const result = await this.pool.query(`
      SELECT blocked_until > clock_timestamp() AS blocked
      FROM ok_console.local_access_throttle WHERE principal_digest = $1`, [this.digest(username)])
    return result.rows[0]?.blocked === true
  }

  async failure(username) {
    await this.pool.query(`
      INSERT INTO ok_console.local_access_throttle
        (principal_digest, failures, window_started_at, blocked_until)
      VALUES ($1, 1, clock_timestamp(), NULL)
      ON CONFLICT (principal_digest) DO UPDATE SET
        failures = CASE WHEN ok_console.local_access_throttle.window_started_at < clock_timestamp() - interval '15 minutes' THEN 1 ELSE ok_console.local_access_throttle.failures + 1 END,
        window_started_at = CASE WHEN ok_console.local_access_throttle.window_started_at < clock_timestamp() - interval '15 minutes' THEN clock_timestamp() ELSE ok_console.local_access_throttle.window_started_at END,
        blocked_until = CASE WHEN (CASE WHEN ok_console.local_access_throttle.window_started_at < clock_timestamp() - interval '15 minutes' THEN 1 ELSE ok_console.local_access_throttle.failures + 1 END) >= 5 THEN clock_timestamp() + interval '15 minutes' ELSE ok_console.local_access_throttle.blocked_until END,
        updated_at = clock_timestamp()`, [this.digest(username)])
  }

  async success(username) {
    await this.pool.query('DELETE FROM ok_console.local_access_throttle WHERE principal_digest = $1', [this.digest(username)])
  }
}

export const createLocalAccessVerifier = ({ mode, accounts, throttle, sessionStore, authorizationRevision, audit = async () => {}, derive = scrypt }) => {
  if (!['Bootstrap', 'BreakGlass'].includes(mode) || !Array.isArray(accounts) || !throttle || !sessionStore?.create) {
    throw new LocalAccessError('INVALID_CONFIGURATION')
  }
  const mapped = new Map(accounts.map((account) => [normalize(account.username), account]))
  return async (input) => {
    const username = normalize(input?.username)
    if (!validInput({ username, password: input?.password, reason: input?.reason })) throw new LocalAccessError()
    if (await throttle.blocked(username)) {
      await audit({ outcome: 'Denied', method: mode, reason: input.reason.trim(), principal: username, cause: 'THROTTLED' })
      throw new LocalAccessError()
    }
    const account = mapped.get(username)
    const salt = account ? Buffer.from(account.salt, 'base64') : DUMMY_SALT
    const expected = account ? Buffer.from(account.verifier, 'base64') : DUMMY_VERIFIER
    let actual
    try {
      actual = await derive(input.password, salt, 32, KDF)
    } catch {
      throw new LocalAccessError('LOCAL_ACCESS_UNAVAILABLE')
    }
    const accepted = account?.enabled === true && expected.length === 32 && actual.length === 32 && timingSafeEqual(actual, expected)
    if (!accepted) {
      await throttle.failure(username)
      await audit({ outcome: 'Denied', method: mode, reason: input.reason.trim(), principal: username, cause: 'INVALID_CREDENTIAL' })
      throw new LocalAccessError()
    }
    await throttle.success(username)
    const issued = await sessionStore.create({
      subject: { id: account.identityId, providerId: 'local', subjectId: account.username, displayName: account.displayName, method: mode, assurance: ['Password', 'ExceptionalAccess'] },
      scope: { environmentId: account.environmentId, tenantIds: [...account.tenantIds] },
      permissions: [...account.permissions], authorizationRevision,
    })
    await audit({ outcome: 'Granted', method: mode, reason: input.reason.trim(), principal: username, cause: 'VERIFIED' })
    return issued
  }
}
