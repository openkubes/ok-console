import { randomUUID } from 'node:crypto'
import {
  CONTRACT_VERSION,
  ConsoleBffError,
  errorResponse,
  findForbiddenFieldPaths,
  responseMeta,
  successResponse,
} from './contract.mjs'
import {
  clusterDetailProjection,
  clusterListProjection,
  evidenceProjection,
  overviewProjection,
  sessionProjection,
} from './presentation.mjs'
import { handleSessionHttp } from './security/httpSession.mjs'

const ROUTE_PREFIX = '/api/console/v0'
const DEFAULT_IDENTITY = {
  id: 'user-arash',
  displayName: 'Arash Kaffamanesh',
  identitySource: 'OIDC',
  assurance: 'Federated',
  permissions: ['platform.read', 'clusters.read', 'evidence.read'],
}

const permissionFor = (pathname) => {
  if (pathname.includes('/evidence/')) return 'evidence.read'
  if (pathname.includes('/clusters')) return 'clusters.read'
  return 'platform.read'
}

export const prototypeAuthorizer = async ({ permission }) => ({
  allowed: DEFAULT_IDENTITY.permissions.includes(permission),
  identity: DEFAULT_IDENTITY,
})

const sendJson = (response, status, payload, correlationId) => {
  const forbidden = findForbiddenFieldPaths(payload)
  if (forbidden.length) {
    const safePayload = errorResponse(
      'INTERNAL_ERROR',
      'The Console BFF blocked an unsafe presentation response.',
      false,
      correlationId,
    )
    response.writeHead(500, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Correlation-ID': correlationId,
    })
    response.end(JSON.stringify(safePayload))
    return
  }

  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Correlation-ID': correlationId,
  })
  response.end(JSON.stringify(payload))
}

const failureResponse = (failure) => {
  switch (failure) {
    case 'forbidden':
      throw new ConsoleBffError(403, 'FORBIDDEN', 'This identity cannot read the requested Console projection.')
    case 'unavailable':
      throw new ConsoleBffError(503, 'SOURCE_UNAVAILABLE', 'Cluster observations are temporarily unavailable.', true, { retryAfterSeconds: 15 })
    case 'incompatible':
      throw new ConsoleBffError(502, 'CONTRACT_INCOMPATIBLE', 'The observed platform response is not compatible with this Console contract.')
    case 'stale':
    case 'degraded':
    case null:
      return
    default:
      throw new ConsoleBffError(400, 'VALIDATION_FAILED', 'Unknown failure-injection mode.', false, {
        details: [{ field: 'failure', reason: 'Use forbidden, unavailable, stale, degraded, or incompatible.' }],
      })
  }
}

const routeResponse = ({ pathname, snapshot, identity, now, correlationId, failure }) => {
  const warnings = [...(snapshot.sourceHealth?.warnings ?? [])]
  let freshness = snapshot.sourceHealth?.freshness ?? 'Current'

  if (failure === 'stale') {
    freshness = 'Stale'
    warnings.push({ code: 'SOURCE_STALE', message: 'The local failure injector marked this observation stale.' })
  }
  if (failure === 'degraded') {
    warnings.push({ code: 'PARTIAL_DATA', message: 'The local failure injector omitted non-essential source data.' })
  }

  const meta = responseMeta({
    correlationId,
    observedAt: snapshot.observedAt,
    freshness,
    sourceRevision: snapshot.sourceRevision,
    warnings,
  })

  if (pathname === `${ROUTE_PREFIX}/session`) {
    const expiresAt = new Date(now().getTime() + 60 * 60 * 1000).toISOString()
    return successResponse('SessionContext', sessionProjection(snapshot, identity, expiresAt), meta)
  }
  if (pathname === `${ROUTE_PREFIX}/overview`) {
    const data = overviewProjection(snapshot)
    if (failure === 'degraded') data.recentPlacements = data.recentPlacements.slice(0, 1)
    return successResponse('PlatformOverview', data, meta)
  }
  if (pathname === `${ROUTE_PREFIX}/clusters`) {
    return successResponse('ClusterList', clusterListProjection(snapshot), meta)
  }

  const clusterMatch = pathname.match(/^\/api\/console\/v0\/clusters\/([^/]+)$/)
  if (clusterMatch) {
    const id = decodeURIComponent(clusterMatch[1])
    const cluster = snapshot.clusters.find((item) => item.id === id)
    if (!cluster) throw new ConsoleBffError(404, 'NOT_FOUND', 'The requested cluster projection was not found.')
    return successResponse('ClusterDetail', clusterDetailProjection(cluster), meta)
  }

  const evidenceMatch = pathname.match(/^\/api\/console\/v0\/evidence\/([^/]+)$/)
  if (evidenceMatch) {
    const id = decodeURIComponent(evidenceMatch[1])
    const evidence = snapshot.evidence.find((item) => item.id === id)
    if (!evidence) throw new ConsoleBffError(404, 'NOT_FOUND', 'The requested evidence reference was not found.')
    const evidenceMeta = responseMeta({
      ...meta,
      observedAt: evidence.observedAt,
      warnings: [...warnings, { code: 'REDACTED', message: 'Private evidence payload is not included in the presentation response.' }],
    })
    return successResponse('EvidenceReference', evidenceProjection(evidence), evidenceMeta)
  }

  throw new ConsoleBffError(404, 'NOT_FOUND', 'No read-only Console resource exists at this path.')
}

export const createConsoleBffHandler = ({
  source,
  authorizer = prototypeAuthorizer,
  enableFailureInjection = false,
  now = () => new Date(),
  correlationId = () => `corr-${randomUUID()}`,
  requestObserver = () => {},
  sessionStore = null,
  expectedOrigin,
}) => async (request, response) => {
  const requestCorrelationId = correlationId()
  try {
    const url = new URL(request.url ?? '/', 'http://console.local')
    requestObserver({ method: request.method ?? 'UNKNOWN', pathname: url.pathname, correlationId: requestCorrelationId })
    if (handleSessionHttp({
      request,
      response,
      pathname: url.pathname,
      correlationId: requestCorrelationId,
      sessionStore,
      expectedOrigin,
    })) return

    if (request.method !== 'GET') {
      throw new ConsoleBffError(405, 'FORBIDDEN', 'The Console BFF exposes read-only GET resources only.')
    }

    const accept = request.headers.accept
    if (accept?.includes('profile=') && !accept.includes(CONTRACT_VERSION)) {
      throw new ConsoleBffError(406, 'CONTRACT_INCOMPATIBLE', 'The requested Presentation Contract profile is not supported.')
    }

    if (!url.pathname.startsWith(`${ROUTE_PREFIX}/`)) {
      throw new ConsoleBffError(404, 'NOT_FOUND', 'No read-only Console resource exists at this path.')
    }

    const authorization = await authorizer({
      request,
      pathname: url.pathname,
      permission: permissionFor(url.pathname),
    })
    if (!authorization.allowed) {
      throw new ConsoleBffError(403, 'FORBIDDEN', 'This identity cannot read the requested Console projection.')
    }

    const failure = enableFailureInjection ? url.searchParams.get('failure') : null
    failureResponse(failure)

    const snapshot = await source.readSnapshot()
    const payload = routeResponse({
      pathname: url.pathname,
      snapshot,
      identity: authorization.identity,
      now,
      correlationId: requestCorrelationId,
      failure,
    })
    sendJson(response, 200, payload, requestCorrelationId)
  } catch (error) {
    if (error instanceof ConsoleBffError) {
      sendJson(
        response,
        error.status,
        errorResponse(error.code, error.message, error.retryable, requestCorrelationId, error.extra),
        requestCorrelationId,
      )
      return
    }

    sendJson(
      response,
      503,
      errorResponse('SOURCE_UNAVAILABLE', 'The observed platform source is unavailable.', true, requestCorrelationId, { retryAfterSeconds: 15 }),
      requestCorrelationId,
    )
  }
}
