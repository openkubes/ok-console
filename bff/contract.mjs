export const CONTRACT_VERSION = 'console.openkubes.io/v0alpha1'

const FORBIDDEN_KEYS = new Set([
  'access_token',
  'accesstoken',
  'bearer_token',
  'bearertoken',
  'client_secret',
  'clientsecret',
  'kubeconfig',
  'password',
  'private_key',
  'privatekey',
  'refresh_token',
  'refreshtoken',
  'secret',
  'token',
])

const normalizeKey = (key) => key.toLowerCase().replaceAll('-', '_')

export const findForbiddenFieldPaths = (value, path = '$') => {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findForbiddenFieldPaths(item, `${path}[${index}]`))
  }
  if (typeof value !== 'object' || value === null) return []

  return Object.entries(value).flatMap(([key, nested]) => {
    const nextPath = `${path}.${key}`
    return FORBIDDEN_KEYS.has(normalizeKey(key))
      ? [nextPath]
      : findForbiddenFieldPaths(nested, nextPath)
  })
}

export const responseMeta = ({ correlationId, observedAt, freshness = 'Current', sourceRevision, warnings }) => ({
  contractVersion: CONTRACT_VERSION,
  correlationId,
  observedAt,
  freshness,
  ...(sourceRevision ? { sourceRevision } : {}),
  ...(warnings?.length ? { warnings } : {}),
})

export const successResponse = (kind, data, meta) => ({
  apiVersion: CONTRACT_VERSION,
  kind,
  data,
  meta,
})

export const errorResponse = (code, message, retryable, correlationId, extra = {}) => ({
  apiVersion: CONTRACT_VERSION,
  kind: 'Error',
  error: {
    code,
    message,
    retryable,
    ...(extra.retryAfterSeconds ? { retryAfterSeconds: extra.retryAfterSeconds } : {}),
    ...(extra.details?.length ? { details: extra.details } : {}),
  },
  meta: { contractVersion: CONTRACT_VERSION, correlationId },
})

export class ConsoleBffError extends Error {
  constructor(status, code, message, retryable = false, extra = {}) {
    super(message)
    this.name = 'ConsoleBffError'
    this.status = status
    this.code = code
    this.retryable = retryable
    this.extra = extra
  }
}
