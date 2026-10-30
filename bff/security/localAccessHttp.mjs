import { currentLifecycle, boundedCorrelation, boundedMs, startErrorCode } from '../diagnostics.mjs'
import { LocalAccessError } from './localAccess.mjs'

const PATH = '/api/console/v0/auth/local'
const MAX_BODY_BYTES = 16 * 1_024
const STEPS = new Set(['THROTTLE_CHECK', 'THROTTLE_FAILURE', 'THROTTLE_RESET', 'KDF', 'SESSION_STORE', 'AUDIT'])

const headers = (correlationId, extra = {}) => ({
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Content-Type': 'application/json; charset=utf-8',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Correlation-ID': correlationId,
  ...extra,
})

const send = (response, status, code, correlationId, extra = {}) => {
  response.writeHead(status, headers(correlationId, extra))
  response.end(JSON.stringify({
    apiVersion: 'auth.console.openkubes.io/v0alpha1', kind: 'SecurityError',
    error: { code, message: 'Exceptional local access could not be completed.' },
    meta: { correlationId },
  }))
}

const readJson = async (request) => {
  const declared = Number(request.headers['content-length'])
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new LocalAccessError('INVALID_REQUEST')
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_BODY_BYTES) throw new LocalAccessError('INVALID_REQUEST')
    chunks.push(bytes)
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error()
    return value
  } catch {
    throw new LocalAccessError('INVALID_REQUEST')
  }
}

export const createLocalAccessHttpHandler = ({ verifier, expectedOrigin }) => async ({ request, response, pathname, correlationId }) => {
  if (pathname !== PATH) return false
  if (request.method !== 'POST') {
    send(response, 405, 'METHOD_NOT_ALLOWED', correlationId, { Allow: 'POST' })
    return true
  }
  if (request.headers.origin !== expectedOrigin) {
    send(response, 403, 'ORIGIN_REJECTED', correlationId)
    return true
  }
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    send(response, 415, 'CONTENT_TYPE_REJECTED', correlationId)
    return true
  }
  const started = performance.now()
  try {
    const body = await readJson(request)
    const issued = await verifier({
      username: body.username, password: body.password, reason: body.reason, correlationId,
    })
    response.writeHead(200, headers(correlationId, { 'Set-Cookie': [issued.cookie, issued.csrfCookie] }))
    response.end(JSON.stringify(issued.session))
  } catch (error) {
    const unavailable = error instanceof LocalAccessError && error.code === 'LOCAL_ACCESS_UNAVAILABLE'
    if (unavailable) {
      const log = (cause, failure) => console.error(JSON.stringify({ stage: currentLifecycle()?.stages.at(-1)?.stage ?? 'REQUEST_RECEIVED', correlationId: boundedCorrelation(correlationId), event: 'LOCAL_ACCESS_FAILED', cause, errorCode: startErrorCode(failure), elapsedMs: boundedMs(performance.now() - started) }))
      log(STEPS.has(error.step) ? error.step : 'OTHER', error.cause)
      if (Object.hasOwn(error, 'compensationError')) log('LOCAL_ACCESS_COMPENSATION', error.compensationError)
    }
    send(response, unavailable ? 503 : 401, unavailable ? 'LOCAL_ACCESS_UNAVAILABLE' : 'LOCAL_ACCESS_REJECTED', correlationId)
  }
  return true
}
