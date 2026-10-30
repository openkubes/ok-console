import { AsyncLocalStorage } from 'node:async_hooks'
import { performance } from 'node:perf_hooks'

export const STAGES = Object.freeze(['REQUEST_RECEIVED', 'AUTHZ_CHECKED', 'SOURCE_ATTEMPT_START', 'DNS_RESOLVED', 'TCP_CONNECTED', 'TLS_ESTABLISHED', 'HEADERS_RECEIVED', 'BODY_COMPLETE', 'CONTRACT_VALIDATED', 'RESPONSE_SENT'])
export const boundedMs = (value) => Math.max(0, Math.min(600000, Math.round(Number.isFinite(value) ? value : 0)))
const clockStep = (value) => Math.abs(value) <= 2 ? 0 : signed(value)
const observationAge = (value) => Math.max(0, Math.min(86400000, Math.round(Number.isFinite(value) ? value : 0)))
const signed = (value) => Math.max(-86400000, Math.min(86400000, Math.round(Number.isFinite(value) ? value : 0)))
export const boundedCorrelation = (value) => typeof value === 'string' && /^corr-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) ? value : 'OTHER'
const PHASES = new Set(['DNS', 'CONNECT', 'TLS_HANDSHAKE', 'AWAIT_HEADERS', 'BODY', 'VALIDATION', 'OTHER'])
const TIMING_KEYS = new Set(['dns', 'connect', 'tls', 'headers'])
const storage = new AsyncLocalStorage()
export const currentLifecycle = () => storage.getStore()
export const withLifecycle = (lifecycle, callback) => storage.run(lifecycle, callback)
export const createLifecycle = (correlationId, { mono = () => performance.now(), trace = process.env.OK_CONSOLE_TRACE === 'stages', emit = (line) => console.log(line) } = {}) => {
  const start = mono()
  const stages = []
  const failures = new Set()
  const lifecycle = { correlationId, stages, recordFailure(error) { failures.add(error) }, hasFailure(error) { return failures.has(error) }, mark(stage) {
    if (!STAGES.includes(stage) || stages.length >= 16) return
    const entry = { stage, atMs: boundedMs(mono() - start) }
    stages.push(entry)
    if (trace) { try { emit(JSON.stringify({ stage, atMs: entry.atMs, correlationId: boundedCorrelation(correlationId) })) } catch { /* Telemetry only. */ } }
  } }
  lifecycle.mark('REQUEST_RECEIVED')
  return lifecycle
}

// One monitor per process. Observations from overlapping attempts contribute to
// every open window. Start also retains the preceding observation interval separately.
// A +/-2ms deadband suppresses wall/monotonic quantization noise in both step fields.
export const createClockMonitor = ({ wall = () => Date.now(), mono = () => performance.now() } = {}) => {
  let previous
  let offset = null
  const windows = new Set()
  const observe = () => {
    const point = { wall: wall(), mono: mono() }
    let step = 0
    const lastObservationAgeMs = previous ? observationAge(point.mono - previous.mono) : null
    let divergence = 0
    if (previous) {
      divergence = (point.wall - previous.wall) - (point.mono - previous.mono)
      step = Math.round(Number.isFinite(divergence) ? divergence : 0)
      for (const window of windows) if (Math.abs(step) > Math.abs(window.step)) window.step = step
    }
    offset = offset === null ? 0 : offset + (Number.isFinite(divergence) ? divergence : 0)
    previous = point
    return { clockStepSinceLastObservationMs: clockStep(step), lastObservationAgeMs }
  }
  return { get clockOffsetMs() { return offset === null ? null : clockStep(offset) }, get activeWindowCount() { return windows.size }, start() {
    const preceding = observe()
    const window = { step: 0 }
    windows.add(window)
    return { ...preceding, finish() { observe(); windows.delete(window); return clockStep(window.step) } }
  } }
}
export const processClock = createClockMonitor()
export const createAttempt = ({ mono = () => performance.now(), clock = processClock, lifecycle = currentLifecycle() } = {}) => {
  const start = mono()
  const window = clock.start()
  let previous = start
  let failedStage = 'OTHER'
  const phaseMs = {}
  let finished
  lifecycle?.mark('SOURCE_ATTEMPT_START')
  return {
    phase(value) { failedStage = PHASES.has(value) ? value : 'OTHER' },
    complete(key, stage, next) {
      const now = mono()
      if (TIMING_KEYS.has(key)) phaseMs[key] = boundedMs(now - previous)
      previous = now
      lifecycle?.mark(stage)
      failedStage = PHASES.has(next) ? next : 'OTHER'
    },
    finish() {
      if (!finished) finished = { failedStage, elapsedMs: boundedMs(mono() - start), phaseMs: { ...phaseMs }, wallClockStepMs: window.finish(), clockOffsetMs: clock.clockOffsetMs, clockStepSinceLastObservationMs: window.clockStepSinceLastObservationMs, lastObservationAgeMs: window.lastObservationAgeMs }
      return finished
    },
  }
}
const errorDetails = new WeakMap()
export const attachAttempt = (error, attempt) => { errorDetails.set(error, attempt.finish()); return error }
export const failureDetails = (error) => errorDetails.get(error)

// Bounded codes shared by authentication and session diagnostics.
const ERROR_CODES = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', '57P01', '53300', '28P01', 'AUDIT_INPUT_INVALID', 'PG_CONNECT_TIMEOUT', 'PG_CONNECTION_TERMINATED', 'PG_POOL_TIMEOUT', 'PG_QUERY_TIMEOUT', 'PG_STATEMENT_TIMEOUT', 'OAUTH_TIMEOUT', 'OAUTH_INVALID_RESPONSE', 'OAUTH_RESPONSE_BODY_ERROR', 'CORRELATION_MISSING', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'OAUTH_WWW_AUTHENTICATE_CHALLENGE', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'OAUTH_RESPONSE_IS_NOT_CONFORM', 'OAUTH_RESPONSE_IS_NOT_JSON', 'OAUTH_PARSE_ERROR', 'OIDC_ID_TOKEN_MISSING', 'PG_UNIQUE_VIOLATION', 'PG_CHECK_VIOLATION', 'DECRYPT_FAILED'])
export const startErrorCode = (error) => {
  const seen = new Set()
  let code
  while (error && (typeof error === 'object' || typeof error === 'function') && !seen.has(error)) {
    seen.add(error)
    const own = (key) => Object.getOwnPropertyDescriptor(error, key)?.value
    if (own('code') !== undefined) code = own('code')
    const cause = own('cause')
    // oauth4webapi attaches parsed IdP data as a plain cause/context, not an Error.
    // Read only its own body marker to distinguish missing ID tokens from bad state.
    const body = cause && Object.getOwnPropertyDescriptor(cause, 'body')?.value
    const accessToken = body && Object.getOwnPropertyDescriptor(body, 'access_token')?.value
    const tokenType = body && Object.getOwnPropertyDescriptor(body, 'token_type')?.value
    if (code === 'OAUTH_INVALID_RESPONSE' && typeof body === 'object' && !Array.isArray(body) && typeof accessToken === 'string' && accessToken.length > 0 && typeof tokenType === 'string' && tokenType.length > 0 && !Object.hasOwn(body, 'id_token')) code = 'OIDC_ID_TOKEN_MISSING'
    if (!(cause instanceof Error) || seen.has(cause)) break
    error = cause
  }
  if (code === '23505') code = 'PG_UNIQUE_VIOLATION'
  if (code === '23514') code = 'PG_CHECK_VIOLATION'
  return code === undefined ? null : ERROR_CODES.has(code) ? code : 'OTHER'
}
