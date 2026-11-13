import { describe, expect, it } from 'vitest'
import { clusterPresentation, capabilityPresentation, observedText, conservativeVerdict, observationPresentation, overviewPresentation, placementPresentation } from './observationPresentation'
import { platformFixture } from './data/fixtures'

describe('observationPresentation', () => {
  it.each([undefined, 'Unknown', 'Stale'] as const)('cannot upgrade %s from the response', freshness => {
    expect(observationPresentation({ freshness, state: 'Ready' }).current).toBe(false)
  })
  it('requires effective state and item evidence; Unknown outranks stale', () => {
    for (const freshness of ['Current', 'Stale'] as const) {
      expect(observationPresentation({ freshness, state: 'Unknown' }).verdict).toBe('Unknown')
      expect(observationPresentation({ freshness, state: 'Ready', hasEvidence: false }).verdict).toBe('Unknown')
      expect(observationPresentation({ freshness }).verdict).toBe('Unknown')
    }
    expect(observationPresentation({ freshness: 'Current', state: 'Ready' }).current).toBe(true)
    expect(conservativeVerdict('Stale', 'Unknown', 'Current')).toBe('Unknown')
  })
  it('keeps available immutable receipts dated and historical, unavailable receipts Unknown', () => {
    expect(observationPresentation({ freshness: 'Current', state: 'Ready', immutable: true, observedAt: '2026-01-01T00:00:00Z' })).toMatchObject({ current: false, label: expect.stringMatching(/Immutable receipt.*2026/) })
    expect(observationPresentation({ freshness: 'Unknown', state: 'Ready', immutable: true }).verdict).toBe('Unknown')
  })
  it('fixture bypass cannot grant currency', () => {
    expect(observationPresentation({ freshness: 'Current', state: 'Ready', fixture: true })).toMatchObject({ current: false, label: 'Fixture snapshot' })
  })
  it('placement rejects absent and foreign Evidence independently of readiness', () => {
    const data = structuredClone(platformFixture)
    data.source = 'bff'; data.freshness = 'Current'
    const claim = data.claims[0]
    const evidence = data.evidence.find(item => item.id === claim.evidenceId)!
    Object.assign(evidence, { freshness: 'Current', immutable: false, outcome: 'Ready', cluster: claim.targetCluster })
    expect(placementPresentation(claim, data).current).toBe(true)
    evidence.cluster = 'foreign'
    expect(placementPresentation(claim, data).verdict).toBe('Unknown')
    data.evidence = []
    expect(placementPresentation(claim, data).verdict).toBe('Unknown')
  })
  it('capability requires its own Evidence and respects a historical or degraded parent', () => {
    const data = structuredClone(platformFixture)
    const cluster = data.clusters[0]
    const evidence = data.evidence.find(item => item.id === cluster.evidenceId)!
    Object.assign(data, { source: 'bff', freshness: 'Current', clusterListFreshness: 'Current' })
    Object.assign(cluster, { readiness: 'Ready', freshness: 'Current' })
    Object.assign(evidence, { freshness: 'Current', immutable: false, outcome: 'Ready' })
    const capability = { readiness: 'Ready', evidenceId: evidence.id }
    expect(capabilityPresentation(capability, cluster, data).current).toBe(true)
    expect(capabilityPresentation({ ...capability, evidenceId: 'absent' }, cluster, data).verdict).toBe('Unknown')
    evidence.immutable = true
    expect(capabilityPresentation(capability, cluster, data).current).toBe(false)
    evidence.immutable = false; cluster.freshness = 'Stale'
    expect(capabilityPresentation(capability, cluster, data).current).toBe(false)
  })
  it('null metrics independently suppress Overview currency without counting metrics', () => {
    const data = structuredClone(platformFixture)
    Object.assign(data, { source: 'bff', freshness: 'Current', clusterListFreshness: 'Current', clusters: [], claims: [], evidence: [], overview: {
      clusters: { total: 0, ready: 0, pending: 0, failed: 0, unknown: 0 }, capabilities: { total: null, ready: null, pending: null, failed: null, unknown: null },
      workloadClaims: { total: 0, ready: 0, pending: 0, failed: 0, unknown: 0 }, openFindings: { total: 0, critical: 0 }, managementPlane: null, recentPlacements: [],
    } })
    expect(overviewPresentation(data)).toMatchObject({ current: false, label: 'Metrics unavailable' })
  })
})

it('immutable Evidence is excluded from the mutable header aggregate', () => {
  const data = structuredClone(platformFixture)
  Object.assign(data, { source: 'bff', freshness: 'Current', clusterListFreshness: 'Current', clusters: [], claims: [] })
  data.evidence = [{ ...data.evidence[0], freshness: 'Current', outcome: 'Ready', immutable: true }]
  expect(overviewPresentation(data)).toMatchObject({ current: true, label: 'Current observation' })
  data.evidence[0].immutable = false
  expect(overviewPresentation(data).current).toBe(true)
})
it.each([true, false])('R4 receipt-backed cluster and claim retain Unknown and Stale verdicts (immutable=%s)', immutable => {
  const data = structuredClone(platformFixture)
  Object.assign(data, { source: 'bff', freshness: 'Current', clusterListFreshness: 'Current' })
  data.clusters = [{ ...data.clusters[0], readiness: 'Ready', freshness: 'Current' }]
  const cluster = data.clusters[0]
  data.claims = []
  data.evidence = [{ ...data.evidence[0], id: cluster.evidenceId, cluster: cluster.id, outcome: 'Ready', freshness: 'Current', immutable, observedAt: '2026-11-01T09:00:00Z' }]
  expect(overviewPresentation(data).current).toBe(!immutable)
  cluster.readiness = 'Unknown'
  expect(overviewPresentation(data)).toMatchObject({ current: false, verdict: 'Unknown', label: '1 unavailable. Readiness is suppressed for affected items.' })
  cluster.readiness = 'Ready'; cluster.freshness = 'Stale'
  expect(overviewPresentation(data)).toMatchObject({ current: false, verdict: 'Stale', label: '1 item stale. Readiness is suppressed for affected items.' })
  cluster.freshness = 'Current'
  data.claims = [{ ...platformFixture.claims[0], targetCluster: cluster.id, evidenceId: cluster.evidenceId, readiness: 'Unknown' }]
  expect(overviewPresentation(data)).toMatchObject({ current: false, verdict: 'Unknown', label: expect.stringContaining('1 unavailable') })
})

it('R4 historical wording avoids last observed observation', () => {
  expect(observedText('Current observation; currently Ready', false)).toBe('last observation; previously Ready')
})

it.each(['Current', 'Stale', 'Unknown', 'missing', 'foreign', 'outcome'] as const)('per-cluster capability Evidence %s caps its parent independently of the list', verdict => {
  const data = structuredClone(platformFixture)
  Object.assign(data, { source: 'bff', freshness: 'Stale', clusterListFreshness: 'Stale' })
  const cluster = { ...data.clusters[0], freshness: 'Current' as const, readiness: 'Ready' as const,
    capabilityDetails: [{ id: 'cap-own', name: 'Own capability', readiness: 'Ready' as const, evidenceId: 'ev-cap-own' }] }
  const primary = { ...data.evidence[0], id: cluster.evidenceId, cluster: cluster.id, freshness: 'Current' as const, outcome: 'Ready' as const, immutable: false }
  const cap = { ...primary, id: 'ev-cap-own', freshness: verdict === 'Stale' || verdict === 'Unknown' ? verdict : 'Current' as const,
    cluster: verdict === 'foreign' ? 'another-cluster' : cluster.name, outcome: verdict === 'outcome' ? 'Unknown' as const : 'Ready' as const }
  data.evidence = verdict === 'missing' ? [primary] : [primary, cap]
  expect(clusterPresentation(cluster, data)).toMatchObject({ current: verdict === 'Current', verdict: verdict === 'Current' || verdict === 'Stale' ? verdict : 'Unknown' })
  if (verdict === 'Current') {
    expect(clusterPresentation({ ...cluster, freshness: 'Stale' }, data).verdict).toBe('Stale')
    expect(clusterPresentation({ ...cluster, freshness: 'Unknown' }, data).verdict).toBe('Unknown')
  }
})
it('per-cluster absent primary Evidence and no reference remain Unknown', () => {
  const data = structuredClone(platformFixture)
  data.source = 'bff'; data.evidence = []
  const cluster = { ...data.clusters[0], freshness: 'Current' as const }
  expect(clusterPresentation(cluster, data).verdict).toBe('Unknown')
  expect(clusterPresentation({ ...cluster, evidenceId: '' }, data).verdict).toBe('Unknown')
})
