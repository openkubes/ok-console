import { createHmac, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { pgConnect, pgQuery } from './pgFailure.mjs'

const scrypt = promisify(nodeScrypt)
const KDF = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1_024 * 1_024 }
const DUMMY_SALT = Buffer.alloc(16, 91)
const DUMMY_VERIFIER = Buffer.alloc(32, 173)

const normalize = (value) => typeof value === 'string' ? value.normalize('NFKC').trim().toLowerCase() : ''
const validInput = ({ username, password, reason }) => username.length >= 1 && username.length <= 128
  && typeof password === 'string' && password.length >= 1 && password.length <= 1024
  && typeof reason === 'string' && reason.trim().length >= 12 && reason.length <= 512

export class LocalAccessError extends Error {
  constructor(code = 'LOCAL_ACCESS_REJECTED', { cause, step } = {}) {
    super('Exceptional local access was rejected.', { cause })
    this.step = step
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

  async transaction(operation) {
    const client = await pgConnect(this.pool)
    let rollbackError
    try {
      await pgQuery(client, 'BEGIN')
      const result = await operation(client)
      // A blocked reservation also rolls back any newly seeded zero-count rows.
      await pgQuery(client, result?.blocked ? 'ROLLBACK' : 'COMMIT')
      return result
    } catch (error) {
      try { await pgQuery(client, 'ROLLBACK') } catch (cause) { rollbackError = cause }
      throw error
    } finally {
      client.release(rollbackError)
    }
  }

  async reserve(username) {
    const globalDigest = this.digest('__global__')
    const digests = [...new Set([this.digest(username), globalDigest])].sort()
    if (digests.length !== 2) throw new LocalAccessError('INVALID_CONFIGURATION')
    return this.transaction(async (client) => {
      // Consistent lock order also covers concurrent creation of missing rows.
      await pgQuery(client, `
        INSERT INTO ok_console.local_access_throttle
          (principal_digest, failures, window_started_at, blocked_until)
        SELECT principal_digest, 0, clock_timestamp(), NULL
        FROM unnest($1::text[]) AS input(principal_digest) ORDER BY principal_digest
        ON CONFLICT (principal_digest) DO NOTHING`, [digests])
      const prior = await pgQuery(client, `
        SELECT principal_digest, blocked_until > clock_timestamp() AS blocked
        FROM ok_console.local_access_throttle
        WHERE principal_digest = ANY($1::text[]) ORDER BY principal_digest FOR UPDATE`, [digests])
      // Blocked attempts neither increment counters nor move the block deadline.
      if (prior.rows.some((row) => row.blocked)) return { blocked: true }
      const reserved = await pgQuery(client, `
        UPDATE ok_console.local_access_throttle SET
          failures = CASE WHEN window_started_at < clock_timestamp() - interval '15 minutes' THEN 1 ELSE failures + 1 END,
          window_started_at = CASE WHEN window_started_at < clock_timestamp() - interval '15 minutes' THEN clock_timestamp() ELSE window_started_at END,
          blocked_until = CASE WHEN (CASE WHEN window_started_at < clock_timestamp() - interval '15 minutes' THEN 1 ELSE failures + 1 END) >= CASE WHEN principal_digest = $2 THEN 50 ELSE 5 END THEN clock_timestamp() + interval '15 minutes' ELSE blocked_until END,
          updated_at = clock_timestamp()
        WHERE principal_digest = ANY($1::text[])
        RETURNING principal_digest, window_started_at::text AS window`, [digests, globalDigest])
      return { blocked: false, globalWindow: reserved.rows.find((row) => row.principal_digest === globalDigest).window }
    })
  }

  async success(username, reservation) {
    return this.transaction(async (client) => {
      // Lock in reserve's order before deleting/updating either row.
      await pgQuery(client, `
        SELECT principal_digest FROM ok_console.local_access_throttle
        WHERE principal_digest = ANY($1::text[]) ORDER BY principal_digest FOR UPDATE`,
      [[this.digest(username), this.digest('__global__')]])
      await pgQuery(client, 'DELETE FROM ok_console.local_access_throttle WHERE principal_digest = $1', [this.digest(username)])
      // Keep the exact PostgreSQL timestamp text: JS Date would lose microseconds.
      await pgQuery(client, `
        UPDATE ok_console.local_access_throttle SET
          failures = GREATEST(failures - 1, 0),
          blocked_until = CASE WHEN failures - 1 < 50 THEN NULL ELSE blocked_until END,
          updated_at = clock_timestamp()
        WHERE principal_digest = $1 AND window_started_at = $2::timestamptz`,
      [this.digest('__global__'), reservation.globalWindow])
    })
  }
}

export class PostgresLocalAccessAudit {
  constructor({ pool, pepper }) {
    if (!pool?.query || !Buffer.isBuffer(pepper) || pepper.length < 32) throw new LocalAccessError('INVALID_CONFIGURATION')
    this.pool = pool
    this.pepper = pepper
  }

  async record(event) {
    const principalDigest = createHmac('sha256', this.pepper).update(`audit:${event.principal}`).digest('base64url')
    await pgQuery(this.pool, `
      INSERT INTO ok_console.local_access_audit (
        principal_digest, authentication_method, outcome, cause,
        operational_reason, correlation_id
      ) VALUES ($1, $2, $3, $4, $5, $6)`, [
      principalDigest, event.method, event.outcome, event.cause,
      event.reason, event.correlationId,
    ])
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
    const run = async (step, operation) => {
      try { return await operation() } catch (cause) {
        throw new LocalAccessError('LOCAL_ACCESS_UNAVAILABLE', { cause, step })
      }
    }
    const reservation = await run('THROTTLE_RESERVE', () => throttle.reserve(username))
    if (reservation.blocked) {
      await run('AUDIT', () => audit({ outcome: 'Denied', method: mode, reason: input.reason.trim(), principal: username, cause: 'THROTTLED', correlationId: input.correlationId }))
      throw new LocalAccessError()
    }
    const account = mapped.get(username)
    const salt = account ? Buffer.from(account.salt, 'base64') : DUMMY_SALT
    const expected = account ? Buffer.from(account.verifier, 'base64') : DUMMY_VERIFIER
    const actual = await run('KDF', () => derive(input.password, salt, 32, KDF))
    const accepted = account?.enabled === true && expected.length === 32 && actual.length === 32 && timingSafeEqual(actual, expected)
    if (!accepted) {
      await run('AUDIT', () => audit({ outcome: 'Denied', method: mode, reason: input.reason.trim(), principal: username, cause: 'INVALID_CREDENTIAL', correlationId: input.correlationId }))
      throw new LocalAccessError()
    }
    await run('THROTTLE_RESET', () => throttle.success(username, reservation))
    const issued = await run('SESSION_STORE', () => sessionStore.create({
      subject: { id: account.identityId, providerId: 'local', subjectId: account.username, displayName: account.displayName, method: mode, assurance: ['Password', 'ExceptionalAccess'] },
      scope: { environmentId: account.environmentId, tenantIds: [...account.tenantIds] },
      permissions: [...account.permissions], authorizationRevision,
    }))
    try {
      await run('AUDIT', () => audit({ outcome: 'Granted', method: mode, reason: input.reason.trim(), principal: username, cause: 'VERIFIED', correlationId: input.correlationId }))
    } catch (error) {
      try { await sessionStore.revoke?.(issued.cookie, 'AUDIT_FAILED') } catch (compensationError) {
        error.compensationError = compensationError
      }
      throw error
    }
    return issued
  }
}
