import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { SECURITY_CONTRACT_VERSION, authorizeSecurityContext } from './authorization.mjs'

export const SESSION_COOKIE = '__Host-ok_console_session'
export const CSRF_COOKIE = '__Host-ok_console_csrf'

export const digestSessionValue = (value) => createHash('sha256').update(value).digest('base64url')
export const opaqueSessionValue = (bytes = randomBytes) => bytes(32).toString('base64url')
export const sessionTimestamp = (milliseconds) => new Date(milliseconds).toISOString()

export const sessionLifetimesFor = (method) => method === 'OIDC'
  ? { idleMs: 15 * 60 * 1_000, absoluteMs: 60 * 60 * 1_000 }
  : { idleMs: 5 * 60 * 1_000, absoluteMs: 15 * 60 * 1_000 }

export const validSessionString = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512
const validStringArray = (value) => Array.isArray(value) && value.length <= 512 && value.every(validSessionString)

export const validateSessionCreationInput = ({ subject, scope, permissions }) => {
  if (!subject
    || !validSessionString(subject.id)
    || !validSessionString(subject.providerId)
    || !validSessionString(subject.subjectId)
    || !validSessionString(subject.displayName)
    || !['OIDC', 'BreakGlass', 'Bootstrap'].includes(subject.method)
    || !validStringArray(subject.assurance)
    || !scope
    || !validSessionString(scope.environmentId)
    || !validStringArray(scope.tenantIds)
    || !validStringArray(permissions)) {
    throw new Error('Session creation input is invalid.')
  }
}

export const sessionCookie = (value, maxAgeSeconds) => [
  `${SESSION_COOKIE}=${value}`,
  'Path=/',
  'Secure',
  'HttpOnly',
  'SameSite=Lax',
  `Max-Age=${maxAgeSeconds}`,
].join('; ')

export const csrfCookie = (value, maxAgeSeconds) => [
  `${CSRF_COOKIE}=${value}`,
  'Path=/',
  'Secure',
  'SameSite=Lax',
  `Max-Age=${maxAgeSeconds}`,
].join('; ')

export const clearSessionCookie = () => sessionCookie('', 0)
export const clearCsrfCookie = () => csrfCookie('', 0)

export const readSessionCookie = (header) => {
  if (typeof header !== 'string') return null
  const matches = header.split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${SESSION_COOKIE}=`))
  if (matches.length !== 1) return null
  const value = matches[0].slice(SESSION_COOKIE.length + 1)
  return /^[A-Za-z0-9_-]{40,128}$/.test(value) ? value : null
}

export const consoleSessionProjection = (context) => ({
  apiVersion: SECURITY_CONTRACT_VERSION,
  kind: 'ConsoleSession',
  data: {
    subject: {
      id: context.subject.id,
      displayName: context.subject.displayName,
      provider: context.subject.providerId,
      method: context.subject.method,
      assurance: [...context.subject.assurance],
    },
    scope: {
      environmentId: context.scope.environmentId,
      tenantIds: [...context.scope.tenantIds],
    },
    permissions: [...context.permissions],
    session: {
      issuedAt: context.session.issuedAt,
      idleExpiresAt: context.session.idleExpiresAt,
      absoluteExpiresAt: context.session.absoluteExpiresAt,
    },
  },
})

export class InMemorySessionStore {
  constructor({ now = () => new Date(), random = randomBytes } = {}) {
    this.now = now
    this.random = random
    this.sessions = new Map()
  }

  create({ subject, scope, permissions }) {
    validateSessionCreationInput({ subject, scope, permissions })
    const method = subject?.method
    const currentTime = this.now().getTime()
    const lifetime = sessionLifetimesFor(method)
    const sessionId = opaqueSessionValue(this.random)
    const csrfToken = opaqueSessionValue(this.random)
    const context = {
      apiVersion: SECURITY_CONTRACT_VERSION,
      kind: 'AuthorizationContext',
      sessionId: `sha256:${digestSessionValue(sessionId)}`,
      subject: structuredClone(subject),
      scope: structuredClone(scope),
      permissions: [...permissions],
      session: {
        issuedAt: sessionTimestamp(currentTime),
        idleExpiresAt: sessionTimestamp(currentTime + lifetime.idleMs),
        absoluteExpiresAt: sessionTimestamp(currentTime + lifetime.absoluteMs),
      },
      csrfDigest: digestSessionValue(csrfToken),
      idleLifetimeMs: lifetime.idleMs,
    }
    this.sessions.set(digestSessionValue(sessionId), context)
    return {
      cookie: sessionCookie(sessionId, Math.floor(lifetime.absoluteMs / 1_000)),
      csrfCookie: csrfCookie(csrfToken, Math.floor(lifetime.absoluteMs / 1_000)),
      csrfToken,
      session: consoleSessionProjection(context),
    }
  }

  resolve(cookieHeader, { touch = true } = {}) {
    const sessionId = readSessionCookie(cookieHeader)
    if (!sessionId) return null
    const key = digestSessionValue(sessionId)
    const context = this.sessions.get(key)
    if (!context) return null
    const currentTime = this.now().getTime()
    if (context.session.revokedAt || currentTime >= Date.parse(context.session.idleExpiresAt) || currentTime >= Date.parse(context.session.absoluteExpiresAt)) {
      this.sessions.delete(key)
      return null
    }
    if (touch) {
      context.session.idleExpiresAt = sessionTimestamp(Math.min(currentTime + context.idleLifetimeMs, Date.parse(context.session.absoluteExpiresAt)))
    }
    return structuredClone(context)
  }

  rotate(cookieHeader) {
    const sessionId = readSessionCookie(cookieHeader)
    if (!sessionId) return null
    const oldKey = digestSessionValue(sessionId)
    const context = this.sessions.get(oldKey)
    if (!context || !this.resolve(cookieHeader, { touch: false })) return null
    const newSessionId = opaqueSessionValue(this.random)
    const csrfToken = opaqueSessionValue(this.random)
    const rotated = structuredClone(context)
    rotated.sessionId = `sha256:${digestSessionValue(newSessionId)}`
    rotated.csrfDigest = digestSessionValue(csrfToken)
    this.sessions.delete(oldKey)
    this.sessions.set(digestSessionValue(newSessionId), rotated)
    const remainingSeconds = Math.max(0, Math.floor((Date.parse(rotated.session.absoluteExpiresAt) - this.now().getTime()) / 1_000))
    return {
      cookie: sessionCookie(newSessionId, remainingSeconds),
      csrfCookie: csrfCookie(csrfToken, remainingSeconds),
      csrfToken,
      session: consoleSessionProjection(rotated),
    }
  }

  revoke(cookieHeader) {
    const sessionId = readSessionCookie(cookieHeader)
    if (!sessionId) return false
    const context = this.sessions.get(digestSessionValue(sessionId))
    if (!context) return false
    context.session.revokedAt = this.now().toISOString()
    return true
  }

  authorize(cookieHeader, request) {
    const context = this.resolve(cookieHeader, { touch: false })
    const result = authorizeSecurityContext(context, request, this.now)
    if (result.allowed) this.resolve(cookieHeader)
    return result
  }
}

export const validateCsrf = ({ method, origin, expectedOrigin, token, context }) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return true
  if (!context
    || !validSessionString(origin)
    || !validSessionString(expectedOrigin)
    || origin !== expectedOrigin
    || typeof token !== 'string') return false
  const actual = Buffer.from(digestSessionValue(token))
  const expected = Buffer.from(context.csrfDigest ?? '')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
