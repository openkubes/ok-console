import { randomUUID } from 'node:crypto'
import { sha256Digest } from './canonical.mjs'
import { verifyInvestigation } from './verify.mjs'

export const MAX_STORED_INVESTIGATIONS = 100
export const INVESTIGATION_ID = /^inv-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// Latest collection time recorded in a pack. It is fixture data, never an observation made by this Console.
export const fixtureObservedAt = (pack) => pack.evidence.map((item) => item.collectedAt).sort().at(-1)

// Fixture investigations: a start evaluates a loaded synthetic pack locally and deterministically. There is
// no cluster client, no model client and no persistence; results live in a bounded in-memory map.
export const createInvestigationService = ({ packs, now = () => new Date(), newId = () => `inv-${randomUUID()}`, maxStored = MAX_STORED_INVESTIGATIONS }) => {
  const results = new Map()

  const listScenarios = () => [...packs.values()].map(({ pack, packDigest }) => ({
    id: pack.scenario.id,
    title: pack.scenario.title,
    description: pack.scenario.description,
    fixture: pack.scenario.fixture,
    synthetic: true,
    target: structuredClone(pack.target),
    packDigest,
    fixtureObservedAt: fixtureObservedAt(pack),
  }))

  const start = ({ scenarioId, correlationId }) => {
    const entry = packs.get(scenarioId)
    if (!entry) return null
    const { pack, packDigest } = entry
    const startedAt = now().toISOString()
    const verified = verifyInvestigation(pack)
    const investigationId = newId()
    const deterministic = {
      scenario: { id: pack.scenario.id, title: pack.scenario.title, description: pack.scenario.description, fixture: pack.scenario.fixture, synthetic: true },
      target: structuredClone(pack.target),
      // Three different times are kept apart: source.observedAt is the fixture's recorded collection time,
      // startedAt/completedAt are this Console's evaluation time, and freshness is Unknown because nothing
      // was observed live.
      source: { kind: 'fixture', liveClusterAccess: false, packDigest, observedAt: fixtureObservedAt(pack), freshness: 'Unknown' },
      analysis: { kind: 'recorded', producer: pack.analysis.producer, liveModel: false },
      evidence: verified.evidence,
      hypotheses: verified.hypotheses,
      verification: verified.verification,
      recommendations: verified.recommendations,
      outcome: verified.outcome,
    }
    const result = {
      investigationId,
      correlationId,
      startedAt,
      completedAt: now().toISOString(),
      ...deterministic,
      evidence: deterministic.evidence.map((item) => ({ ...item, href: `/api/console/v0/investigations/${investigationId}/evidence/${item.id}` })),
      // Same pack, same result: everything except ids and timestamps is covered by this digest.
      reproducibility: { resultDigest: sha256Digest(deterministic) },
    }
    results.set(investigationId, { result, pack })
    while (results.size > maxStored) results.delete(results.keys().next().value)
    return structuredClone(result)
  }

  const get = (investigationId) => {
    const stored = INVESTIGATION_ID.test(investigationId) ? results.get(investigationId) : undefined
    return stored ? structuredClone(stored.result) : null
  }

  const evidence = (investigationId, evidenceId) => {
    const stored = INVESTIGATION_ID.test(investigationId) ? results.get(investigationId) : undefined
    const item = stored?.pack.evidence.find((candidate) => candidate.id === evidenceId)
    if (!item) return null
    const verdict = stored.result.evidence.find((candidate) => candidate.id === evidenceId)
    return structuredClone({
      investigationId,
      id: item.id,
      type: item.type,
      source: item.source,
      uri: item.uri,
      collectedAt: item.collectedAt,
      digest: item.digest,
      integrity: verdict.integrity,
      clusterBinding: verdict.clusterBinding,
      synthetic: true,
      data: item.data,
    })
  }

  return { listScenarios, start, get, evidence }
}
