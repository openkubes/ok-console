import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { SECURITY_CONTRACT_VERSION, authorizeSecurityContext } from './authorization.mjs'

export const SESSION_COOKIE = '__Host-ok_console_session'

const digest = (value) => createHash('sha256').update(value).digest('base64url')
const opaqueValue = (bytes = randomBytes) => bytes(32).toString('base64url')
const iso = (milliseconds) => new Date(milliseconds).toISOString()

const lifetimesFor = (method) => method === 'OIDC'
  ? { idleMs: 15 * 60 * 1_000, absoluteMs: 60 * 60 * 1_000 }
  : { idleMs: 5 * 60 * 1_000, absoluteMs: 15 * 60 * 1_000 }

const validString = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512
const validStringArray = (value) => Array.isArray(value) && value.every(validString)

const validateCreationInput = ({ subject, scope, permissions }) => {
  if (!subject
    || !validString(subject.id)
    || !validString(subject.providerId)
    || !validString(subject.subjectId)
    || !validString(subject.displayName)
    || !['OIDC', 'BreakGlass', 'Bootstrap'].includes(subject.method)
    || !validStringArray(subject.assurance)
    || !scope
    || !validString(scope.environmentId)
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

export const clearSessionCookie = () => sessionCookie('', 0)

export const readSessionCookie = (header) => {
  if (typeof header !== 'string') return null
  const matches = header.split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${SESSION_COOKIE}=`))
  if (matches.length !== 1) return null
  const value = matches[0].slice(SESSION_COOKIE.length + 1)
  return /^[A-Za-z0-9_-]{40,128}$/.test(value) ? value : null
}

const publicProjection = (context) => ({
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
    validateCreationInput({ subject, scope, permissions })
    const method = subject?.method
    const currentTime = this.now().getTime()
    const lifetime = lifetimesFor(method)
    const sessionId = opaqueValue(this.random)
    const csrfToken = opaqueValue(this.random)
    const context = {
      apiVersion: SECURITY_CONTRACT_VERSION,
      kind: 'AuthorizationContext',
      sessionId: `sha256:${digest(sessionId)}`,
      subject: structuredClone(subject),
      scope: structuredClone(scope),
      permissions: [...permissions],
      session: {
        issuedAt: iso(currentTime),
        idleExpiresAt: iso(currentTime + lifetime.idleMs),
        absoluteExpiresAt: iso(currentTime + lifetime.absoluteMs),
      },
      csrfDigest: digest(csrfToken),
      idleLifetimeMs: lifetime.idleMs,
    }
    this.sessions.set(digest(sessionId), context)
    return {
      cookie: sessionCookie(sessionId, Math.floor(lifetime.absoluteMs / 1_000)),
      csrfToken,
      session: publicProjection(context),
    }
  }

  resolve(cookieHeader, { touch = true } = {}) {
    const sessionId = readSessionCookie(cookieHeader)
    if (!sessionId) return null
    const key = digest(sessionId)
    const context = this.sessions.get(key)
    if (!context) return null
    const currentTime = this.now().getTime()
    if (context.session.revokedAt || currentTime >= Date.parse(context.session.idleExpiresAt) || currentTime >= Date.parse(context.session.absoluteExpiresAt)) {
      this.sessions.delete(key)
      return null
    }
    if (touch) {
      context.session.idleExpiresAt = iso(Math.min(currentTime + context.idleLifetimeMs, Date.parse(context.session.absoluteExpiresAt)))
    }
    return structuredClone(context)
  }

  rotate(cookieHeader) {
    const sessionId = readSessionCookie(cookieHeader)
    if (!sessionId) return null
    const oldKey = digest(sessionId)
    const context = this.sessions.get(oldKey)
    if (!context || !this.resolve(cookieHeader, { touch: false })) return null
    const newSessionId = opaqueValue(this.random)
    const csrfToken = opaqueValue(this.random)
    const rotated = structuredClone(context)
    rotated.sessionId = `sha256:${digest(newSessionId)}`
    rotated.csrfDigest = digest(csrfToken)
    this.sessions.delete(oldKey)
    this.sessions.set(digest(newSessionId), rotated)
    const remainingSeconds = Math.max(0, Math.floor((Date.parse(rotated.session.absoluteExpiresAt) - this.now().getTime()) / 1_000))
    return { cookie: sessionCookie(newSessionId, remainingSeconds), csrfToken, session: publicProjection(rotated) }
  }

  revoke(cookieHeader) {
    const sessionId = readSessionCookie(cookieHeader)
    if (!sessionId) return false
    const context = this.sessions.get(digest(sessionId))
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
    || !validString(origin)
    || !validString(expectedOrigin)
    || origin !== expectedOrigin
    || typeof token !== 'string') return false
  const actual = Buffer.from(digest(token))
  const expected = Buffer.from(context.csrfDigest ?? '')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
