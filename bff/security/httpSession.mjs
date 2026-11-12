import { currentLifecycle, boundedCorrelation, boundedMs, startErrorCode } from '../diagnostics.mjs'
import { SECURITY_CONTRACT_VERSION } from './authorization.mjs'
import {
  clearCsrfCookie,
  clearSessionCookie,
  consoleSessionProjection,
  validateCsrf,
} from './session.mjs'

const SESSION_PATH = '/api/console/v0/auth/session'
const ROTATE_PATH = `${SESSION_PATH}/rotate`

const securityError = (code, message, correlationId) => ({
  apiVersion: SECURITY_CONTRACT_VERSION,
  kind: 'SecurityError',
  error: { code, message },
  meta: { correlationId },
})

const responseHeaders = (correlationId, extra = {}) => ({
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Correlation-ID': correlationId,
  ...extra,
})

const sendJson = (response, status, payload, correlationId, extraHeaders) => {
  response.writeHead(status, responseHeaders(correlationId, extraHeaders))
  response.end(JSON.stringify(payload))
}

const clearCookies = [clearSessionCookie(), clearCsrfCookie()]

const rejectUnauthenticated = (response, correlationId) => sendJson(
  response,
  401,
  securityError('UNAUTHENTICATED', 'A valid Console session is required.', correlationId),
  correlationId,
  { 'Set-Cookie': clearCookies },
)

const csrfRequest = (request, context, expectedOrigin) => ({
  method: request.method ?? 'UNKNOWN',
  origin: request.headers.origin,
  expectedOrigin,
  token: request.headers['x-csrf-token'],
  context,
})

export const handleSessionHttp = async ({
  request,
  response,
  pathname,
  correlationId,
  sessionStore,
  expectedOrigin,
  audit = async () => {},
}) => {
  if (pathname !== SESSION_PATH && pathname !== ROTATE_PATH) return false

  if (!sessionStore) {
    sendJson(
      response,
      503,
      securityError('SESSION_UNAVAILABLE', 'The Console session service is not configured.', correlationId),
      correlationId,
    )
    return true
  }

  const started = performance.now()
  const run = async (cause, operation) => {
    try { return await operation() } catch (error) {
      const step = (cause === 'SESSION_ROTATE' && error?.step === 'SESSION_ROTATE_COMMIT') || (cause === 'SESSION_REVOKE' && error?.step === 'SESSION_REVOKE_COMMIT') ? error.step : cause
      console.error(JSON.stringify({ stage: currentLifecycle()?.stages.at(-1)?.stage ?? 'REQUEST_RECEIVED', correlationId: boundedCorrelation(correlationId), event: 'SESSION_FAILED', cause: step, errorCode: startErrorCode(error), elapsedMs: boundedMs(performance.now() - started) }))
      currentLifecycle()?.recordFailure(error)
      throw error
    }
  }
  const cookieHeader = request.headers.cookie

  if (pathname === SESSION_PATH && request.method === 'GET') {
    const context = await run('SESSION_STORE', () => sessionStore.resolve(cookieHeader))
    if (!context) {
      await run('AUDIT', () => audit({ method: 'OIDC', outcome: 'Denied', cause: 'SESSION_INVALID', correlationId, reason: 'Session restore rejected' })).catch(() => {})
      rejectUnauthenticated(response, correlationId)
      return true
    }
    try { await run('AUDIT', () => audit({ method: context.subject?.method ?? 'OIDC', outcome: 'Restored', cause: 'VERIFIED', correlationId, reason: 'Session restored' })) } catch {
      sendJson(response, 503, securityError('SESSION_UNAVAILABLE', 'The Console session service is not configured.', correlationId), correlationId)
      return true
    }
    sendJson(response, 200, consoleSessionProjection(context), correlationId)
    return true
  }

  if (pathname === ROTATE_PATH && request.method === 'POST') {
    const context = await run('SESSION_STORE', () => sessionStore.resolve(cookieHeader, { touch: false }))
    if (!context) {
      await run('AUDIT', () => audit({ method: 'OIDC', outcome: 'Denied', cause: 'SESSION_INVALID', correlationId, reason: 'Session rotation rejected' })).catch(() => {})
      rejectUnauthenticated(response, correlationId)
      return true
    }
    if (!validateCsrf(csrfRequest(request, context, expectedOrigin))) {
      await run('AUDIT', () => audit({ method: context.subject?.method ?? 'OIDC', outcome: 'Denied', cause: 'CSRF_REJECTED', correlationId, reason: 'Session rotation CSRF validation failed' })).catch(() => {})
      sendJson(response, 403, securityError('CSRF_REJECTED', 'The session rotation request was rejected.', correlationId), correlationId)
      return true
    }
    const rotated = await run('SESSION_ROTATE', () => sessionStore.rotate(cookieHeader))
    if (!rotated) {
      rejectUnauthenticated(response, correlationId)
      return true
    }
    try { await run('AUDIT', () => audit({ method: context.subject?.method ?? 'OIDC', outcome: 'Rotated', cause: 'VERIFIED', correlationId, reason: 'Session rotated' })) } catch {
      await run('SESSION_ROTATE_COMPENSATION', () => sessionStore.revoke?.(rotated.cookie, 'AUDIT_FAILED')).catch(() => {})
      sendJson(response, 503, securityError('SESSION_UNAVAILABLE', 'The Console session service is not configured.', correlationId), correlationId)
      return true
    }
    sendJson(response, 200, rotated.session, correlationId, { 'Set-Cookie': [rotated.cookie, rotated.csrfCookie] })
    return true
  }

  if (pathname === SESSION_PATH && request.method === 'DELETE') {
    const context = await run('SESSION_STORE', () => sessionStore.resolve(cookieHeader, { touch: false }))
    if (!context) {
      await run('AUDIT', () => audit({ method: 'OIDC', outcome: 'Denied', cause: 'SESSION_INVALID', correlationId, reason: 'Session logout rejected' })).catch(() => {})
      rejectUnauthenticated(response, correlationId)
      return true
    }
    if (!validateCsrf(csrfRequest(request, context, expectedOrigin))) {
      await run('AUDIT', () => audit({ method: context.subject?.method ?? 'OIDC', outcome: 'Denied', cause: 'CSRF_REJECTED', correlationId, reason: 'Session logout CSRF validation failed' })).catch(() => {})
      sendJson(response, 403, securityError('CSRF_REJECTED', 'The session logout request was rejected.', correlationId), correlationId)
      return true
    }
    const revoked = await run('SESSION_REVOKE', () => sessionStore.revoke(cookieHeader))
    if (!revoked) {
      rejectUnauthenticated(response, correlationId)
      return true
    }
    try { await run('AUDIT', () => audit({ method: context.subject?.method ?? 'OIDC', outcome: 'Revoked', cause: 'VERIFIED', correlationId, reason: 'Session revoked by logout' })) } catch {
      sendJson(response, 503, securityError('SESSION_UNAVAILABLE', 'The Console session service is not configured.', correlationId), correlationId)
      return true
    }
    response.writeHead(204, responseHeaders(correlationId, { 'Set-Cookie': clearCookies }))
    response.end()
    return true
  }

  sendJson(
    response,
    405,
    securityError('METHOD_NOT_ALLOWED', 'This method is not supported by the Console session endpoint.', correlationId),
    correlationId,
    { Allow: pathname === ROTATE_PATH ? 'POST' : 'GET, DELETE' },
  )
  return true
}
