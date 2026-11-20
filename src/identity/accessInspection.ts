import { conservativeVerdict } from '../observationPresentation'
import type { Freshness } from '../domain/presentationContract'

// internal view model, not a contract; may change
export type SubjectRef = { kind: 'User' | 'Group'; issuer: string; subject: string; displayName?: string }
export type NamespaceTarget = { clusterId: string; namespace: string; namespaceUid: string }
// Project references the ADR-045 Enterprise Workspace, not a separate domain.
export type ProjectRef = { tenantId: string; projectId: string }
export type AccessEvidenceSummary = {
  kind: string; observedAt?: string; freshness?: Freshness
  binding?: { roleRef: string }; reasons?: { code: string }[]
}
export type AccessTargetInput = {
  source: 'fixture' | 'bff'; proposed?: boolean; clusterReachable?: boolean
  evidence?: AccessEvidenceSummary
}
export type AccessInspectionRow = AccessTargetInput & {
  id: string; subject: SubjectRef; project: ProjectRef; target: NamespaceTarget
}
export type AccessTargetState = 'Proposed' | 'Not verified' | 'Unreachable' | 'Unknown' | 'Verified' | 'Stale'

/** Only the exact Console BFF source counts as observed; anything else is treated as fixture. */
export const isObservedSource = (input: Pick<AccessTargetInput, 'source'>) => input.source === 'bff'

/** First match wins; fixture provenance can never establish verified access. */
export function accessTargetState(input: AccessTargetInput): AccessTargetState {
  if (input.proposed && !input.evidence) return 'Proposed'
  if (!isObservedSource(input)) return 'Not verified'
  if (input.clusterReachable === false) return 'Unreachable'
  if (input.clusterReachable !== true) return 'Unknown'
  if (!input.evidence || input.evidence.kind !== 'target-cluster') return 'Not verified'
  const verdict = conservativeVerdict(input.evidence.freshness)
  if (verdict === 'Stale') return 'Stale'
  if (verdict !== 'Current') return 'Unknown'
  // ADR-Platform-046 §8: Verified needs the observed binding and no unresolved reason.
  if (!input.evidence.binding?.roleRef || (input.evidence.reasons?.length ?? 0) > 0) return 'Not verified'
  return 'Verified'
}
