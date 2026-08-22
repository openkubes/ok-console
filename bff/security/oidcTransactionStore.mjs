import { randomBytes } from 'node:crypto'
import { digestSessionValue, opaqueSessionValue, validSessionString } from './session.mjs'

export const OIDC_TRANSACTION_COOKIE = '__Host-ok_console_oidc'
const TRANSACTION_LIFETIME_SECONDS = 5 * 60

export const oidcTransactionCookie = (value, maxAge = TRANSACTION_LIFETIME_SECONDS) => [
  `${OIDC_TRANSACTION_COOKIE}=${value}`,
  'Path=/',
  'Secure',
  'HttpOnly',
  'SameSite=Lax',
  `Max-Age=${maxAge}`,
].join('; ')

export const clearOidcTransactionCookie = () => oidcTransactionCookie('', 0)

const readCookie = (header) => {
  if (typeof header !== 'string') return null
  const values = header.split(';').map((value) => value.trim()).filter((value) => value.startsWith(`${OIDC_TRANSACTION_COOKIE}=`))
  if (values.length !== 1) return null
  const value = values[0].slice(OIDC_TRANSACTION_COOKIE.length + 1)
  return /^[A-Za-z0-9_-]{40,128}$/.test(value) ? value : null
}

const validPayload = (value) => value
  && validSessionString(value.codeVerifier)
  && validSessionString(value.state)
  && validSessionString(value.nonce)

export class OidcTransactionStoreError extends Error {
  constructor() {
    super('OIDC transaction store operation failed.')
    this.name = 'OidcTransactionStoreError'
  }
}

export class PostgresOidcTransactionStore {
  constructor({ pool, codec, deploymentEpoch, random = randomBytes }) {
    if (!pool?.query || !codec?.encrypt || !codec?.decrypt || !validSessionString(deploymentEpoch)) {
      throw new OidcTransactionStoreError()
    }
    this.pool = pool
    this.codec = codec
    this.deploymentEpoch = deploymentEpoch
    this.random = random
  }

  async create(payload) {
    if (!validPayload(payload)) throw new OidcTransactionStoreError()
    try {
      const reference = opaqueSessionValue(this.random)
      const envelope = this.codec.encrypt(payload)
      await this.pool.query(`
        INSERT INTO ok_console.oidc_transactions (
          transaction_digest, payload_envelope, key_id, deployment_epoch, expires_at
        ) VALUES ($1, $2, $3, $4, clock_timestamp() + make_interval(secs => $5))`, [
        digestSessionValue(reference), envelope.ciphertext, envelope.keyId,
        this.deploymentEpoch, TRANSACTION_LIFETIME_SECONDS,
      ])
      return { cookie: oidcTransactionCookie(reference) }
    } catch {
      throw new OidcTransactionStoreError()
    }
  }

  async consume(cookieHeader) {
    const reference = readCookie(cookieHeader)
    if (!reference) return null
    try {
      const result = await this.pool.query(`
        DELETE FROM ok_console.oidc_transactions
        WHERE transaction_digest = $1
          AND deployment_epoch = $2
          AND expires_at > clock_timestamp()
        RETURNING payload_envelope, key_id`, [digestSessionValue(reference), this.deploymentEpoch])
      if (!result.rows[0]) return null
      const payload = this.codec.decrypt({
        ciphertext: result.rows[0].payload_envelope,
        keyId: result.rows[0].key_id,
      })
      if (!validPayload(payload)) throw new OidcTransactionStoreError()
      return payload
    } catch {
      throw new OidcTransactionStoreError()
    }
  }

  async purgeExpired(limit = 500) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new OidcTransactionStoreError()
    try {
      const result = await this.pool.query(`
        DELETE FROM ok_console.oidc_transactions
        WHERE transaction_digest IN (
          SELECT transaction_digest FROM ok_console.oidc_transactions
          WHERE expires_at <= clock_timestamp()
          ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED
        )`, [limit])
      return result.rowCount ?? 0
    } catch {
      throw new OidcTransactionStoreError()
    }
  }
}
