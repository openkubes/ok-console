import { createHmac, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { bounded, safeReason } from './authenticationAudit.mjs'
import { classifyPgError, pgConnect, pgQuery } from './pgFailure.mjs'

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
  && bounded(username, 256) && safeReason(reason.trim())

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
  constructor({ pool, pepper, afterStatement }) {
    if (typeof pool?.query !== 'function' || typeof pool?.connect !== 'function'
      || !Buffer.isBuffer(pepper) || pepper.length < 32) throw new LocalAccessError('INVALID_CONFIGURATION')
    this.pool = pool
    this.pepper = pepper
    // Injection seam for scheduling failures; runtime configuration never supplies it.
    this.afterStatement = afterStatement
  }

  digest(username) {
    return createHmac('sha256', this.pepper).update(`throttle:principal:${username}`).digest('base64url')
  }

  globalDigest() {
    return createHmac('sha256', this.pepper).update('throttle:global').digest('base64url')
  }

  async transaction(operation) {
    const client = await pgConnect(this.pool)
    let failure, result
    const recordFailure = error => { failure ??= classifyPgError(error) }
    client.on('error', recordFailure)
    const checked = { query: async (...args) => {
      try {
        if (failure) throw failure
        const value = await pgQuery(client, ...args)
        await this.afterStatement?.({ client, sql: args[0] })
        if (failure) throw failure
        return value
      } catch (error) {
        recordFailure(error)
        throw failure
      }
    } }
    try {
      await checked.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      const settings = await checked.query(`
        SELECT setting::bigint AS statement_timeout,
          (SELECT setting::bigint FROM pg_settings WHERE name = 'lock_timeout') AS lock_timeout,
          (SELECT setting::bigint FROM pg_settings WHERE name = 'idle_in_transaction_session_timeout') AS idle_timeout
        FROM pg_settings WHERE name = 'statement_timeout'`)
      const { statement_timeout: statementTimeout, lock_timeout: lockTimeout, idle_timeout: idleTimeout } = settings.rows[0]
      const cap = Number(statementTimeout) > 0 ? Math.max(1, Number(statementTimeout) - 1) : Infinity
      const configured = value => Number(value) > 0 ? Number(value) : Infinity
      await checked.query(`SELECT set_config('lock_timeout', $1, true),
        set_config('idle_in_transaction_session_timeout', $2, true)`,
      [`${Math.min(LOCK_TIMEOUT_MS, cap, configured(lockTimeout))}ms`, `${Math.min(IDLE_IN_TRANSACTION_TIMEOUT_MS, cap, configured(idleTimeout))}ms`])
      result = await operation(checked)
      // Refused successes commit their global release; only a blocked reserve rolls back.
      await checked.query(result?.blocked ? 'ROLLBACK' : 'COMMIT')
    } catch (error) {
      recordFailure(error)
    } finally {
      try { client.release(failure) } catch (error) { recordFailure(error) }
      finally { client.removeListener('error', recordFailure) }
    }
    if (failure) throw failure
    return result
  }

  async instant(client) {
    const result = await pgQuery(client, `SELECT floor(extract(epoch FROM clock_timestamp()) * 1e6)::bigint AS now`)
    return result.rows[0].now
  }

  async reserve(username) {
    const globalDigest = this.globalDigest()
    const digests = [this.digest(username), globalDigest].sort()
    // Reject known blocks without acquiring the shared global row lock.
    const precheck = await pgQuery(this.pool, `
      SELECT principal_digest FROM ok_console.local_access_throttle
      WHERE principal_digest = ANY($1::text[]) AND blocked_until > clock_timestamp()`, [digests])
    if (precheck.rows.length) return { blocked: true }
    return this.transaction(async (client) => {
      await pgQuery(client, `
        INSERT INTO ok_console.local_access_throttle
          (principal_digest, failures, window_started_at, blocked_until)
        SELECT principal_digest, 0, clock_timestamp(), NULL
        FROM unnest($1::text[]) AS input(principal_digest) ORDER BY principal_digest
        ON CONFLICT (principal_digest) DO NOTHING`, [digests])
      const prior = await pgQuery(client, `
        SELECT principal_digest, floor(extract(epoch FROM blocked_until) * 1e6)::bigint AS block_token
        FROM ok_console.local_access_throttle
        WHERE principal_digest = ANY($1::text[]) ORDER BY principal_digest FOR UPDATE`, [digests])
      // No retry: refuse before KDF if an expected row vanished or is foreign.
      if (!holdsBoth(prior, digests)) throw new LocalAccessError('LOCAL_ACCESS_UNAVAILABLE')
      const now = await this.instant(client)
      if (prior.rows.some(row => row.block_token != null && BigInt(row.block_token) > BigInt(now))) return { blocked: true }
      const lockedDigests = prior.rows.map(row => row.principal_digest)
      const reserved = await pgQuery(client, `
        UPDATE ok_console.local_access_throttle SET
          failures = CASE WHEN window_started_at < to_timestamp($3::numeric / 1e6) - interval '15 minutes' THEN 1 ELSE failures + 1 END,
          window_started_at = CASE WHEN window_started_at < to_timestamp($3::numeric / 1e6) - interval '15 minutes' THEN to_timestamp($3::numeric / 1e6) ELSE window_started_at END,
          blocked_until = CASE WHEN (CASE WHEN window_started_at < to_timestamp($3::numeric / 1e6) - interval '15 minutes' THEN 1 ELSE failures + 1 END) >= CASE WHEN principal_digest = $2 THEN 50 ELSE 5 END THEN to_timestamp($3::numeric / 1e6) + interval '15 minutes' ELSE blocked_until END,
          updated_at = to_timestamp($3::numeric / 1e6)
        WHERE principal_digest = ANY($1::text[])
        RETURNING principal_digest, floor(extract(epoch FROM window_started_at) * 1e6)::bigint AS window,
          floor(extract(epoch FROM blocked_until) * 1e6)::bigint AS block_token`, [lockedDigests, globalDigest, now])
      if (reserved.rowCount !== 2 || !holdsBoth(reserved, lockedDigests)) throw new LocalAccessError('LOCAL_ACCESS_UNAVAILABLE')
      return { blocked: false, globalWindow: reserved.rows.find((row) => row.principal_digest === globalDigest)?.window,
        principalBlock: reserved.rows.find(row => row.principal_digest !== globalDigest).block_token }
    })
  }

  async success(username, reservation) {
    const principalDigest = this.digest(username)
    const globalDigest = this.globalDigest()
    const digests = [principalDigest, globalDigest].sort()
    return this.transaction(async (client) => {
      const locked = await pgQuery(client, `
        SELECT principal_digest, floor(extract(epoch FROM blocked_until) * 1e6)::bigint AS block_token
        FROM ok_console.local_access_throttle
        WHERE principal_digest = ANY($1::text[]) ORDER BY principal_digest FOR UPDATE`, [digests])
      if (!holdsBoth(locked, digests)) throw new LocalAccessError('LOCAL_ACCESS_UNAVAILABLE')
      const now = await this.instant(client)
      const principal = locked.rows.find(row => row.principal_digest === principalDigest)
      const refused = principal.block_token != null && BigInt(principal.block_token) > BigInt(now)
        && principal.block_token !== reservation.principalBlock
      // Only a block owned by this reservation may be reset while active.
      if (!refused) await pgQuery(client, `UPDATE ok_console.local_access_throttle SET
        failures = 0, blocked_until = NULL, window_started_at = to_timestamp($2::numeric / 1e6),
        updated_at = to_timestamp($2::numeric / 1e6) WHERE principal_digest = $1`, [principalDigest, now])
      await pgQuery(client, `
        UPDATE ok_console.local_access_throttle SET
          failures = GREATEST(failures - 1, 0),
          blocked_until = CASE WHEN failures - 1 < 50 THEN NULL ELSE blocked_until END,
          updated_at = to_timestamp($3::numeric / 1e6)
        WHERE principal_digest = $1 AND floor(extract(epoch FROM window_started_at) * 1e6)::bigint = $2::bigint`,
      [globalDigest, reservation.globalWindow, now])
      return { refused }
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

export const createLocalAccessVerifier = ({ mode, accounts, throttle, sessionStore, authorizationRevision, audit = async () => {}, derive = scrypt, isEnabled = async () => true }) => {
  if (!['Bootstrap', 'BreakGlass'].includes(mode) || !Array.isArray(accounts) || !throttle || !sessionStore?.create) {
    throw new LocalAccessError('INVALID_CONFIGURATION')
  }
  const mapped = new Map(accounts.map((account) => [normalize(account.username), account]))
  return async (input) => {
    const username = normalize(input?.username)
    if (!validInput({ username, password: input?.password, reason: input?.reason })) throw new LocalAccessError('INVALID_REQUEST')
    const run = async (step, operation) => {
      try { return await operation() } catch (cause) {
        throw new LocalAccessError('LOCAL_ACCESS_UNAVAILABLE', { cause, step })
      }
    }
    if (!await run('ENABLED_CHECK', isEnabled)) {
      await run('AUDIT', () => audit({ outcome: 'Denied', method: mode, reason: input.reason.trim(), principal: username, cause: 'THROTTLED', correlationId: input.correlationId }))
      throw new LocalAccessError()
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
    const outcome = await run('THROTTLE_RESET', () => throttle.success(username, reservation))
    if (outcome?.refused) {
      await run('AUDIT', () => audit({ outcome: 'Denied', method: mode, reason: input.reason.trim(), principal: username, cause: 'THROTTLED', correlationId: input.correlationId }))
      throw new LocalAccessError()
    }
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
