import { pgQuery } from './pgFailure.mjs'
import { createHmac } from 'node:crypto'

const METHODS = new Set(['OIDC', 'Bootstrap', 'BreakGlass'])
const OUTCOMES = new Set(['Started', 'Granted', 'Denied', 'Restored', 'Rotated', 'Revoked'])
const CAUSES = new Set(['REQUESTED', 'VERIFIED', 'INVALID_CREDENTIAL', 'THROTTLED', 'UNMAPPED_SUBJECT', 'TRANSACTION_INVALID', 'CALLBACK_REJECTED', 'SESSION_INVALID', 'CSRF_REJECTED', 'AUDIT_FAILED'])

const bounded = (value, max = 256) => typeof value === 'string' && value.length > 0 && value.length <= max
  && value === value.trim() && ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
const safeReason = (value) => bounded(value, 512) && !/(?:access[_-]?token|id[_-]?token|refresh[_-]?token|authorization|bearer|client[_-]?secret|password|code_verifier|code=|https?:\/\/)/i.test(value)

export class AuthenticationAuditError extends Error {
  constructor(message = 'Authentication audit persistence failed.', cause) {
    super(message, { cause })
    this.name = 'AuthenticationAuditError'
  }
}

const validate = (event) => {
  if (!event || !METHODS.has(event.method) || !OUTCOMES.has(event.outcome) || !CAUSES.has(event.cause)) {
    throw Object.assign(new AuthenticationAuditError('Authentication audit event is invalid.'), { code: 'AUDIT_INPUT_INVALID' })
  }
  if (!bounded(event.correlationId, 128) || !safeReason(event.reason)) {
    throw Object.assign(new AuthenticationAuditError('Authentication audit event is invalid.'), { code: 'AUDIT_INPUT_INVALID' })
  }
  if (event.principal !== undefined && !bounded(event.principal, 256)) {
    throw Object.assign(new AuthenticationAuditError('Authentication audit event is invalid.'), { code: 'AUDIT_INPUT_INVALID' })
  }
  return event
}

export class PostgresAuthenticationAudit {
  constructor({ pool, pepper }) {
    if (!pool?.query || !Buffer.isBuffer(pepper) || pepper.length < 32) throw new AuthenticationAuditError('Invalid authentication audit configuration.')
    this.pool = pool
    this.pepper = pepper
  }

  async record(event) {
    const valid = validate(event)
    const principalDigest = valid.principal
      ? createHmac('sha256', this.pepper).update(`auth-audit:${valid.principal}`).digest('base64url')
      : null
    try {
      await pgQuery(this.pool, `
        INSERT INTO ok_console.authentication_audit
          (correlation_id, authentication_method, outcome, cause, principal_digest, operational_reason)
        VALUES ($1, $2, $3, $4, $5, $6)`, [
        valid.correlationId, valid.method, valid.outcome, valid.cause, principalDigest, valid.reason,
      ])
    } catch (error) {
      throw new AuthenticationAuditError(undefined, error)
    }
  }
}

export const validateAuthenticationAuditEvent = validate
