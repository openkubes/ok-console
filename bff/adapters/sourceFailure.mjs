import { boundedCorrelation, currentLifecycle, failureDetails, processClock } from '../diagnostics.mjs'
// Closed observations, never an inference from error text or nested causes.
const TRUST_CODES = new Set(`UNSPECIFIED UNABLE_TO_GET_ISSUER_CERT UNABLE_TO_GET_CRL
UNABLE_TO_DECRYPT_CERT_SIGNATURE UNABLE_TO_DECRYPT_CRL_SIGNATURE
UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY CERT_SIGNATURE_FAILURE CRL_SIGNATURE_FAILURE
CERT_NOT_YET_VALID CERT_HAS_EXPIRED CRL_NOT_YET_VALID CRL_HAS_EXPIRED
ERROR_IN_CERT_NOT_BEFORE_FIELD ERROR_IN_CERT_NOT_AFTER_FIELD
ERROR_IN_CRL_LAST_UPDATE_FIELD ERROR_IN_CRL_NEXT_UPDATE_FIELD
DEPTH_ZERO_SELF_SIGNED_CERT SELF_SIGNED_CERT_IN_CHAIN UNABLE_TO_GET_ISSUER_CERT_LOCALLY
UNABLE_TO_VERIFY_LEAF_SIGNATURE CERT_CHAIN_TOO_LONG CERT_REVOKED INVALID_CA
PATH_LENGTH_EXCEEDED INVALID_PURPOSE CERT_UNTRUSTED CERT_REJECTED
HOSTNAME_MISMATCH ERR_TLS_CERT_ALTNAME_INVALID ERR_TLS_CERT_ALTNAME_FORMAT`.split(/\s+/))
const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETDOWN', 'EHOSTDOWN', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT'])
const INCONCLUSIVE_CODES = new Set(['ECONNRESET', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE'])
const PEER_ALERT_NAMES = new Set([
  'UNKNOWN_CA', 'BAD_CERTIFICATE', 'CERTIFICATE_UNKNOWN', 'CERTIFICATE_EXPIRED',
  'CERTIFICATE_REVOKED', 'UNSUPPORTED_CERTIFICATE', 'HANDSHAKE_FAILURE',
  'ACCESS_DENIED', 'DECRYPT_ERROR', 'CERTIFICATE_REQUIRED',
])
const observation = (classification, reason, nodeCode = 'OTHER', httpStatus = 'NONE') =>
  Object.freeze({ class: classification, reason, nodeCode, httpStatus })
const fallback = () => observation('INCONCLUSIVE', 'UNCLASSIFIED')
const failures = new WeakMap()

export const classifySourceFailure = (error) => {
  if (failures.has(error)) return failures.get(error)
  let code
  try {
    // Accessors and inherited codes are not the error's own Node code.
    code = Object.getOwnPropertyDescriptor(error, 'code')?.value
  } catch { return fallback() }
  if (typeof code !== 'string') return fallback()
  if (TRUST_CODES.has(code)) return observation('TRUST_REJECTED', 'CERTIFICATE_VERIFICATION', code)
  if (UNREACHABLE_CODES.has(code)) return observation('SOURCE_UNREACHABLE', 'TRANSPORT_FAILURE', code)
  if (INCONCLUSIVE_CODES.has(code)) return observation('INCONCLUSIVE', 'TRANSPORT_AMBIGUOUS', code)
  const alert = /^ERR_SSL_(?:SSLV3|TLSV1|TLSV13|SSL\/TLS)_ALERT_([A-Z_]+)$/.exec(code)?.[1]
  if (PEER_ALERT_NAMES.has(alert)) return observation('INCONCLUSIVE', 'PEER_TLS_ALERT', alert)
  if (code === 'EPROTO') return observation('INCONCLUSIVE', 'TLS_PROTOCOL_FAILURE', code)
  return fallback()
}

class ObservedStateSourceError extends Error {
  constructor(diagnostic) {
    super('The observed platform source is unavailable.')
    failures.set(this, diagnostic)
  }
}
export const sourceTransportError = (error, responseReceived = false, tlsEstablished = false) => {
  const diagnostic = classifySourceFailure(error)
  if (tlsEstablished && !responseReceived && diagnostic.nodeCode === 'ETIMEDOUT') {
    return new ObservedStateSourceError(observation('INCONCLUSIVE', diagnostic.reason, diagnostic.nodeCode))
  }
  return new ObservedStateSourceError(responseReceived && diagnostic.class === 'SOURCE_UNREACHABLE'
    ? observation('INCONCLUSIVE', 'TRANSPORT_AMBIGUOUS', diagnostic.nodeCode)
    : diagnostic)
}
export const sourceDeadlineError = (responseReceived = false, socketTimeout = false, tlsEstablished = false) => new ObservedStateSourceError(responseReceived
  ? observation('INCONCLUSIVE', 'BODY_DEADLINE_EXCEEDED', socketTimeout ? 'ETIMEDOUT' : 'OTHER')
  : observation(tlsEstablished ? 'INCONCLUSIVE' : 'SOURCE_UNREACHABLE', 'DEADLINE_EXCEEDED'))
export const sourceHttpError = (status) => new ObservedStateSourceError(observation(
  'INCONCLUSIVE',
  status === 401 || status === 403 ? 'IDENTITY_REJECTED' : status >= 500 && status <= 599 ? 'HTTP_SERVER_ERROR' : 'HTTP_NON_SUCCESS',
  'OTHER', status === 401 || status === 403 ? 'IDENTITY_REJECTED' : status >= 500 && status <= 599 ? '5XX' : 'OTHER',
))
export const contractFailure = () => observation('CONTRACT_INCOMPATIBLE', 'CONTRACT_VALIDATION')

const routeClass = (pathname) => {
  if (pathname === '/api/console/v0/overview') return 'OVERVIEW'
  if (pathname === '/api/console/v0/clusters') return 'CLUSTERS'
  if (/^\/api\/console\/v0\/clusters\/[^/]+$/.test(pathname)) return 'CLUSTER_DETAIL'
  if (pathname === '/api/console/v0/evidence') return 'EVIDENCE'
  if (/^\/api\/console\/v0\/evidence\/[^/]+$/.test(pathname)) return 'EVIDENCE_DETAIL'
  return 'OTHER'
}
// Only internal frozen observations reach this serializer. app.mjs generates the
// correlation ID server-side; also enforce its bounded format locally.
export const sourceFailureLogLine = (pathname, diagnostic, correlationId, error) => JSON.stringify({
  time: new Date().toISOString(),
  stage: currentLifecycle()?.stages.at(-1)?.stage ?? 'SOURCE_ATTEMPT_START',
  route: routeClass(pathname),
  correlationId: boundedCorrelation(correlationId),
  class: diagnostic.class,
  reason: diagnostic.reason,
  nodeCode: diagnostic.nodeCode,
  httpStatus: diagnostic.httpStatus,
  ...(failureDetails(error) ?? { failedStage: 'OTHER', elapsedMs: null, phaseMs: {}, wallClockStepMs: null, clockOffsetMs: processClock.clockOffsetMs, clockStepSinceLastObservationMs: null, lastObservationAgeMs: null }),
  stages: (currentLifecycle()?.stages ?? []).map((entry) => ({ ...entry })),
})
