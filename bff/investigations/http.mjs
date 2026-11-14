import { ConsoleBffError, responseMeta, successResponse } from '../contract.mjs'

export const INVESTIGATIONS_PATH = '/api/console/v0/investigations'
const SCENARIOS_PATH = `${INVESTIGATIONS_PATH}/scenarios`
const RESULT_PATH = /^\/api\/console\/v0\/investigations\/(inv-[0-9a-f-]{36})$/
const EVIDENCE_PATH = /^\/api\/console\/v0\/investigations\/(inv-[0-9a-f-]{36})\/evidence\/([a-z0-9][a-z0-9-]{0,62})$/
const MAX_START_BODY_BYTES = 4 * 1024

export const isInvestigationPath = (pathname) => pathname === INVESTIGATIONS_PATH || pathname.startsWith(`${INVESTIGATIONS_PATH}/`)

const FIXTURE_WARNING = Object.freeze({ code: 'SYNTHETIC_FIXTURE', message: 'Synthetic fixture investigation with recorded analysis. No cluster or model was contacted; observedAt is the fixture time, not a live observation.' })

const readStartRequest = async (request) => {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    throw new ConsoleBffError(415, 'VALIDATION_FAILED', 'An investigation start request must be application/json.')
  }
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_START_BODY_BYTES) throw new ConsoleBffError(413, 'VALIDATION_FAILED', 'The investigation start request is too large.')
    chunks.push(chunk)
  }
  let input
  try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new ConsoleBffError(400, 'VALIDATION_FAILED', 'The investigation start request must be valid JSON.') }
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => key !== 'scenarioId') || typeof input.scenarioId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.scenarioId)) {
    throw new ConsoleBffError(400, 'VALIDATION_FAILED', 'The investigation start request accepts exactly one field: scenarioId.')
  }
  return input
}

// Investigation routes. Reads need evidence.read; a start needs clusters.read like the dry-run, plus a
// same-origin request when the BFF runs with sessions. A start only evaluates a loaded synthetic pack.
export const handleInvestigationHttp = async ({ request, pathname, correlationId, service, authorizer, expectedOrigin, send, markAuthorized }) => {
  // observedAt is the fixture's recorded collection time, never the response time; freshness is Unknown
  // because a fixture is not a live observation (presentation contract values Current | Stale | Unknown).
  const meta = (observedAt) => responseMeta({ correlationId, observedAt, freshness: 'Unknown', warnings: [FIXTURE_WARNING] })
  const authorize = async (permission) => {
    const authorization = await authorizer({ request, pathname, permission })
    markAuthorized()
    if (!authorization.allowed) throw new ConsoleBffError(403, 'FORBIDDEN', 'This identity cannot use fixture investigations.')
  }

  if (pathname === INVESTIGATIONS_PATH) {
    if (request.method !== 'POST') throw new ConsoleBffError(405, 'FORBIDDEN', 'Investigations are started with POST.')
    if (expectedOrigin && request.headers.origin !== expectedOrigin) throw new ConsoleBffError(403, 'FORBIDDEN', 'An investigation start must come from the Console origin.')
    await authorize('clusters.read')
    const { scenarioId } = await readStartRequest(request)
    const result = service.start({ scenarioId, correlationId })
    if (!result) throw new ConsoleBffError(404, 'NOT_FOUND', 'No synthetic investigation scenario exists with this id.')
    send(201, successResponse('InvestigationResult', result, meta(result.source.observedAt)))
    return
  }

  if (request.method !== 'GET') throw new ConsoleBffError(405, 'FORBIDDEN', 'This investigation resource is read-only.')
  await authorize('evidence.read')

  if (pathname === SCENARIOS_PATH) {
    const scenarios = service.listScenarios()
    send(200, successResponse('InvestigationScenarioList', { scenarios }, meta(scenarios.map((scenario) => scenario.fixtureObservedAt).sort().at(-1))))
    return
  }
  const resultMatch = RESULT_PATH.exec(pathname)
  if (resultMatch) {
    const result = service.get(resultMatch[1])
    if (!result) throw new ConsoleBffError(404, 'NOT_FOUND', 'The requested investigation was not found.')
    send(200, successResponse('InvestigationResult', result, meta(result.source.observedAt)))
    return
  }
  const evidenceMatch = EVIDENCE_PATH.exec(pathname)
  if (evidenceMatch) {
    const evidence = service.evidence(evidenceMatch[1], evidenceMatch[2])
    if (!evidence) throw new ConsoleBffError(404, 'NOT_FOUND', 'The requested investigation evidence was not found.')
    send(200, successResponse('InvestigationEvidence', evidence, meta(evidence.collectedAt)))
    return
  }
  throw new ConsoleBffError(404, 'NOT_FOUND', 'No investigation resource exists at this path.')
}
