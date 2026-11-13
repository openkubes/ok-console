import type { Cluster, EvidenceRef, PlatformSnapshot, WorkloadClaim } from './domain/contracts'
import type { Freshness } from './domain/presentationContract'

/** Unknown outranks stale; only explicit producer verdicts can grant currency. */
export function conservativeVerdict(...verdicts: (Freshness | undefined)[]): Freshness {
  if (verdicts.some(value => value !== 'Current' && value !== 'Stale')) return 'Unknown'
  return verdicts.includes('Stale') ? 'Stale' : 'Current'
}

export function observationPresentation({ freshness, state, hasEvidence = true, immutable = false, fixture = false, observedAt }: {
  freshness?: Freshness; state?: string; hasEvidence?: boolean; immutable?: boolean; fixture?: boolean; observedAt?: string
}) {
  const verdict = conservativeVerdict(freshness, state === undefined || state === 'Unknown' || !hasEvidence ? 'Unknown' : 'Current')
  if (fixture) return { current: false, stale: false, verdict, label: 'Fixture snapshot' }
  if (verdict === 'Unknown') return { current: false, stale: false, verdict, label: 'Observation unavailable - readiness Unknown' }
  if (immutable) return { current: false, stale: verdict === 'Stale', verdict, label: `Immutable receipt${observedAt ? ` · ${new Date(observedAt).toLocaleString()}` : ''}` }
  if (verdict === 'Stale') return { current: false, stale: true, verdict, label: 'Last observed' }
  return { current: true, stale: false, verdict, label: 'Current observation' }
}

export function evidencePresentation(item: EvidenceRef, fixture = false) {
  return observationPresentation({ freshness: item.freshness, state: item.outcome, immutable: item.immutable, observedAt: item.observedAt, fixture })
}

export function clusterPresentation(cluster: Cluster, data: PlatformSnapshot) {
  const evidence = data.evidence.find(item => item.id === cluster.evidenceId && (item.cluster === cluster.id || item.cluster === cluster.name))
  // The detail route covers unloaded capability and placement Evidence. Only
  // already-loaded observations can further constrain its verdict.
  const observations = data.evidence.filter(item => item.cluster === cluster.id || item.cluster === cluster.name)
  return observationPresentation({
    // cluster.freshness retains the detail-route verdict and browser ageing cap.
    freshness: conservativeVerdict(cluster.freshness, evidence?.freshness, ...observations.map(item => item.freshness)),
    state: observations.some(item => item?.outcome === 'Unknown') ? 'Unknown' : cluster.readiness,
    hasEvidence: Boolean(evidence), immutable: evidence?.immutable, observedAt: evidence?.observedAt,
    fixture: data.source !== 'bff',
  })
}

export function placementPresentation(claim: WorkloadClaim, data: PlatformSnapshot) {
  const cluster = data.clusters.find(item => item.name === claim.targetCluster || item.id === claim.targetCluster)
  const evidence = data.evidence.find(item => item.id === claim.evidenceId && (item.cluster === claim.targetCluster || item.cluster === cluster?.id || item.cluster === cluster?.name))
  return observationPresentation({
    freshness: conservativeVerdict(data.freshness, evidence?.freshness),
    state: evidence?.outcome === 'Unknown' ? 'Unknown' : claim.readiness,
    hasEvidence: Boolean(evidence), immutable: evidence?.immutable, observedAt: evidence?.observedAt,
    fixture: data.source !== 'bff',
  })
}

export function overviewPresentation(data: PlatformSnapshot) {
  const items = [
    ...[...new Map(data.clusters.map(item => [item.id, item])).values()].map(item => clusterPresentation(item, data)),
    ...[...new Map(data.claims.map(item => [item.id, item])).values()].map(item => placementPresentation(item, data)),
  ]
  const unavailable = items.filter(item => item.verdict === 'Unknown').length
  const stale = items.filter(item => item.verdict === 'Stale').length
  const historical = items.filter(item => item.verdict === 'Current' && !item.current).length
  const evidence = data.evidence.filter(item => !item.immutable).map(item => evidencePresentation(item))
  const metrics = data.overview && [data.overview.capabilities, data.overview.workloadClaims, data.overview.openFindings]
  const metricsVerdict = metrics?.some(metric => Object.values(metric).some(value => value === null)) ? 'Unknown' : 'Current'
  const verdict = conservativeVerdict(data.freshness, data.clusterListFreshness, metricsVerdict, historical ? 'Stale' : 'Current', ...items.map(item => item.verdict), ...evidence.map(item => item.verdict))
  const presentation = observationPresentation({ freshness: verdict, state: 'Ready', fixture: data.source !== 'bff' })
  if (data.source !== 'bff') return presentation
  if (unavailable || stale || historical) return { ...presentation, current: false, label: [stale && `${stale} item${stale === 1 ? '' : 's'} stale`, historical && `${historical} item${historical === 1 ? '' : 's'} historical`, unavailable && `${unavailable} unavailable`].filter(Boolean).join(', ') + '. Readiness is suppressed for affected items.' }
  if (metricsVerdict === 'Unknown') return { ...presentation, current: false, label: 'Metrics unavailable' }
  return presentation
}

/** Producer prose describes its observation; retain it as history when currency is suppressed. */
export function observedText(text: string, current: boolean) {
  return current ? text : text.replace(/\bcurrent observation\b/gi, 'last observation').replace(/\bcurrently\b/gi, 'previously').replace(/\bcurrent\b/gi, 'last observed')
}

export function capabilityPresentation(capability: { readiness: string; evidenceId: string }, cluster: Cluster, data: PlatformSnapshot) {
  const parent = clusterPresentation(cluster, data)
  const evidence = data.evidence.find(item => item.id === capability.evidenceId && (item.cluster === cluster.id || item.cluster === cluster.name))
  return observationPresentation({
    freshness: conservativeVerdict(parent.verdict, evidence?.freshness, parent.current ? 'Current' : 'Stale'),
    state: evidence?.outcome === 'Unknown' ? 'Unknown' : capability.readiness,
    hasEvidence: Boolean(evidence), fixture: data.source !== 'bff',
  })
}
