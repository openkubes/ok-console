import { createHmac, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { pgConnect, pgQuery } from './pgFailure.mjs'

const scrypt = promisify(nodeScrypt)
const KDF = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1_024 * 1_024 }
const LOCK_TIMEOUT_MS = 1000
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 5000
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

// Check both identity and cardinality: a foreign or duplicated row is not a reservation.
const holdsBoth = (result, digests) => result.rows.length === 2
  && new Set(result.rows.map(row => row.principal_digest)).size === 2
  && result.rows.every(row => digests.includes(row.principal_digest))

export class PostgresLocalAccessThrottle {
  constructor({ pool, pepper }) {
    if (typeof pool?.query !== 'function' || typeof pool?.connect !== 'function'
      || !Buffer.isBuffer(pepper) || pepper.length < 32) throw new LocalAccessError('INVALID_CONFIGURATION')
    this.pool = pool
    this.pepper = pepper
  }

  digest(username) {
    return createHmac('sha256', this.pepper).update(`throttle:principal:${username}`).digest('base64url')
  }

  globalDigest() {
    return createHmac('sha256', this.pepper).update('throttle:global').digest('base64url')
  }

  async transaction(operation) {
    const client = await pgConnect(this.pool)
    let failure
    try {
      await pgQuery(client, 'BEGIN ISOLATION LEVEL READ COMMITTED')
      const settings = await pgQuery(client, `
        SELECT setting::bigint AS statement_timeout,
          floor(extract(epoch FROM clock_timestamp()) * 1e6)::bigint AS now
        FROM pg_settings WHERE name = 'statement_timeout'`)
      const { statement_timeout: statementTimeout, now } = settings.rows[0]
      const cap = Number(statementTimeout) > 0 ? Number(statementTimeout) - 1 : Infinity
      await pgQuery(client, `SELECT set_config('lock_timeout', $1, true),
        set_config('idle_in_transaction_session_timeout', $2, true)`,
      [`${Math.min(LOCK_TIMEOUT_MS, cap)}ms`, `${Math.min(IDLE_IN_TRANSACTION_TIMEOUT_MS, cap)}ms`])
      const result = await operation(client, now)
      // Only a normal blocked result uses ROLLBACK. Errors destroy the client:
      // queuing another query after a client-side timeout can hang the pool.
      await pgQuery(client, result?.blocked ? 'ROLLBACK' : 'COMMIT')
      return result
    } catch (error) {
      failure = error
      throw error
    } finally {
      client.release(failure)
    }
  }

  async reserve(username) {
    const globalDigest = this.globalDigest()
    const digests = [this.digest(username), globalDigest].sort()
    // Reject known blocks without acquiring the shared global row lock.
    const precheck = await pgQuery(this.pool, `
      SELECT principal_digest FROM ok_console.local_access_throttle
      WHERE principal_digest = ANY($1::text[]) AND blocked_until > clock_timestamp()`, [digests])
    if (precheck.rows.length) return { blocked: true }
    return this.transaction(async (client, now) => {
      await pgQuery(client, `
        INSERT INTO ok_console.local_access_throttle
          (principal_digest, failures, window_started_at, blocked_until)
        SELECT principal_digest, 0, to_timestamp($2::numeric / 1e6), NULL
        FROM unnest($1::text[]) AS input(principal_digest) ORDER BY principal_digest
        ON CONFLICT (principal_digest) DO NOTHING`, [digests, now])
      const prior = await pgQuery(client, `
        SELECT principal_digest, blocked_until > to_timestamp($2::numeric / 1e6) AS blocked
        FROM ok_console.local_access_throttle
        WHERE principal_digest = ANY($1::text[]) ORDER BY principal_digest FOR UPDATE`, [digests, now])
      // No retry: refuse before KDF if either expected row vanished or is foreign.
      if (!holdsBoth(prior, digests)) throw new LocalAccessError('LOCAL_ACCESS_UNAVAILABLE')
      if (prior.rows.some((row) => row.blocked)) return { blocked: true }
      const lockedDigests = prior.rows.map(row => row.principal_digest)
      const reserved = await pgQuery(client, `
        UPDATE ok_console.local_access_throttle SET
          failures = CASE WHEN window_started_at < to_timestamp($3::numeric / 1e6) - interval '15 minutes' THEN 1 ELSE failures + 1 END,
          window_started_at = CASE WHEN window_started_at < to_timestamp($3::numeric / 1e6) - interval '15 minutes' THEN to_timestamp($3::numeric / 1e6) ELSE window_started_at END,
          blocked_until = CASE WHEN (CASE WHEN window_started_at < to_timestamp($3::numeric / 1e6) - interval '15 minutes' THEN 1 ELSE failures + 1 END) >= CASE WHEN principal_digest = $2 THEN 50 ELSE 5 END THEN to_timestamp($3::numeric / 1e6) + interval '15 minutes' ELSE blocked_until END,
          updated_at = to_timestamp($3::numeric / 1e6)
        WHERE principal_digest = ANY($1::text[])
        RETURNING principal_digest, floor(extract(epoch FROM window_started_at) * 1e6)::bigint AS window`, [lockedDigests, globalDigest, now])
      if (reserved.rowCount !== 2 || !holdsBoth(reserved, lockedDigests)) throw new LocalAccessError('LOCAL_ACCESS_UNAVAILABLE')
      return { blocked: false, globalWindow: reserved.rows.find((row) => row.principal_digest === globalDigest).window }
    })
  }

  async success(username, reservation) {
    const principalDigest = this.digest(username)
    const globalDigest = this.globalDigest()
    const digests = [principalDigest, globalDigest].sort()
    return this.transaction(async (client, now) => {
      const locked = await pgQuery(client, `
        SELECT principal_digest FROM ok_console.local_access_throttle
        WHERE principal_digest = ANY($1::text[]) ORDER BY principal_digest FOR UPDATE`, [digests])
      if (!holdsBoth(locked, digests)) throw new LocalAccessError('LOCAL_ACCESS_UNAVAILABLE')
      // A correct credential resets this principal, including newer attempts.
      await pgQuery(client, `UPDATE ok_console.local_access_throttle SET
        failures = 0, blocked_until = NULL, window_started_at = to_timestamp($2::numeric / 1e6),
        updated_at = to_timestamp($2::numeric / 1e6) WHERE principal_digest = $1`, [principalDigest, now])
      await pgQuery(client, `
        UPDATE ok_console.local_access_throttle SET
          failures = GREATEST(failures - 1, 0),
          blocked_until = CASE WHEN failures - 1 < 50 THEN NULL ELSE blocked_until END,
          updated_at = to_timestamp($3::numeric / 1e6)
        WHERE principal_digest = $1 AND floor(extract(epoch FROM window_started_at) * 1e6)::bigint = $2::bigint`,
      [globalDigest, reservation.globalWindow, now])
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
