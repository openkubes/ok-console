import type { Freshness } from './domain/presentationContract'

/** Only a producer verdict can grant currency. Browser time never promotes it. */
export function observationPresentation({
  freshness, state, hasEvidence = true, immutable = false, fixture = false,
}: {
  freshness?: Freshness
  state?: string
  hasEvidence?: boolean
  immutable?: boolean
  fixture?: boolean
}) {
  if (immutable) return { current: false, stale: freshness === 'Stale', label: 'Immutable receipt' }
  if (freshness === 'Stale') return { current: false, stale: true, label: 'Last observed' }
  if ((!fixture && freshness !== 'Current') || state === undefined || state === 'Unknown' || !hasEvidence) {
    return { current: false, stale: false, label: 'Observation unavailable - readiness Unknown' }
  }
  return { current: true, stale: false, label: 'Current observation' }
}
