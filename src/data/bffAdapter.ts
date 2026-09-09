import type {
  ClusterDetailData,
  ClusterListResponse,
  ConsoleErrorCode,
  ConsoleErrorResponse,
  EvidenceReferenceResponse,
  PlatformOverviewResponse,
} from '../domain/presentationContract'
import {
  PRESENTATION_CONTRACT_VERSION,
  validateConsoleResponse,
} from '../domain/presentationContract'
import type { Cluster, ConsoleDataPort, EvidenceRef, PlatformSnapshot } from '../domain/contracts'

type FetchLike = typeof fetch

export class ConsoleDataError extends Error {
  constructor(
    message: string,
    readonly code: ConsoleErrorCode | 'NETWORK_ERROR',
    readonly retryable: boolean,
    readonly correlationId?: string,
  ) {
    super(message)
    this.name = 'ConsoleDataError'
  }
}

const clusterFromSummary = (cluster: ClusterListResponse['data']['items'][number]): Cluster => ({
  id: cluster.id,
  name: cluster.name,
  role: cluster.role,
  provider: cluster.provider,
  profile: cluster.profile,
  version: cluster.kubernetesVersion,
  region: cluster.region,
  readiness: cluster.readiness,
  compatibility: cluster.compatibility,
  contractVersion: cluster.contractVersion,
  revision: cluster.revision,
  evidenceId: cluster.evidenceId,
  capabilities: [],
  capabilityCount: cluster.capabilityCount,
  lifecycle: [],
})

const clusterFromDetail = (cluster: ClusterDetailData): Cluster => ({
  ...clusterFromSummary(cluster),
  capabilities: cluster.capabilities.map((capability) => capability.id),
  capabilityDetails: cluster.capabilities,
  lifecycle: cluster.lifecycle,
})

const evidenceFromContract = (response: EvidenceReferenceResponse): EvidenceRef => ({
  id: response.data.id,
  title: response.data.title,
  type: response.data.type,
  outcome: response.data.outcome,
  cluster: response.data.clusterId,
  contract: response.data.contract,
  revision: response.data.revision,
  observedAt: response.data.observedAt,
  source: response.data.source,
  summary: response.data.summary,
  immutable: response.data.classification === 'Immutable',
})

const isErrorResponse = (value: unknown): value is ConsoleErrorResponse =>
  typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'Error'

const isRecordWithKind = (value: unknown): value is { kind: string } =>
  typeof value === 'object' && value !== null && 'kind' in value && typeof value.kind === 'string'

export class BffConsoleAdapter implements ConsoleDataPort {
  constructor(
    private readonly baseUrl = '/api/console/v0',
    private readonly fetcher: FetchLike = (...args) => fetch(...args),
  ) {}

  private async request<T>(path: string, expectedKind: string): Promise<T> {
    let response: Response
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        headers: { Accept: `application/json; profile="${PRESENTATION_CONTRACT_VERSION}"` },
        credentials: 'same-origin',
      })
    } catch {
      throw new ConsoleDataError('The Console BFF is unavailable.', 'NETWORK_ERROR', true)
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new ConsoleDataError('The Console BFF returned an unreadable response.', 'CONTRACT_INCOMPATIBLE', false)
    }

    const validation = validateConsoleResponse(payload)
    if (!validation.valid) {
      throw new ConsoleDataError(
        'The Console BFF response is incompatible with Presentation Contract v0.',
        'CONTRACT_INCOMPATIBLE',
        false,
      )
    }

    if (isErrorResponse(payload)) {
      throw new ConsoleDataError(
        payload.error.message,
        payload.error.code,
        payload.error.retryable,
        payload.meta.correlationId,
      )
    }

    if (!isRecordWithKind(payload) || payload.kind !== expectedKind) {
      throw new ConsoleDataError(
        `The Console BFF returned ${isRecordWithKind(payload) ? payload.kind : 'an unknown kind'} where ${expectedKind} was required.`,
        'CONTRACT_INCOMPATIBLE',
        false,
      )
    }

    if (!response.ok) {
      throw new ConsoleDataError('The Console BFF request failed.', 'INTERNAL_ERROR', response.status >= 500)
    }

    return payload as T
  }

  async getSnapshot(): Promise<PlatformSnapshot> {
    const [overview, clusters] = await Promise.all([
      this.request<PlatformOverviewResponse>('/overview', 'PlatformOverview'),
      this.request<ClusterListResponse>('/clusters', 'ClusterList'),
    ])
    const evidenceIds = new Set([
      ...clusters.data.items.map((cluster) => cluster.evidenceId),
      ...overview.data.recentPlacements.map((placement) => placement.evidenceId),
    ])
    const evidenceResults = await Promise.allSettled(
      [...evidenceIds].map((id) => this.getEvidence(id)),
    )
    const evidence = evidenceResults
      .filter((result): result is PromiseFulfilledResult<EvidenceRef | undefined> => result.status === 'fulfilled')
      .map((result) => result.value)
    const unavailableEvidence = evidenceResults.filter((result) => result.status === 'rejected').length
    const evidenceFailures = evidenceResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason instanceof ConsoleDataError ? result.reason.code : 'INTERNAL_ERROR')

    return {
      generatedAt: overview.meta.observedAt,
      presentationVersion: PRESENTATION_CONTRACT_VERSION,
      source: 'bff',
      freshness: overview.meta.freshness,
      warnings: [
        ...(overview.meta.warnings?.map((warning) => warning.message) ?? []),
        ...(unavailableEvidence > 0 ? [`${unavailableEvidence} evidence reference${unavailableEvidence === 1 ? '' : 's'} could not be loaded (${[...new Set(evidenceFailures)].join(', ')}).`] : []),
      ],
      overview: overview.data,
      clusters: clusters.data.items.map(clusterFromSummary),
      capabilities: [],
      claims: overview.data.recentPlacements.map((placement) => ({
        id: placement.id,
        name: placement.name,
        kind: 'WorkloadClaim',
        owner: 'Platform team',
        intent: 'Read-only placement projection',
        targetCluster: placement.targetCluster,
        readiness: placement.readiness,
        requiredCapabilities: [],
        decision: `Observed placement on ${placement.targetCluster}`,
        evidenceId: placement.evidenceId,
      })),
      agents: [],
      agentDeployments: [],
      evidence: evidence.filter((item): item is EvidenceRef => item !== undefined),
    }
  }

  async getCluster(id: string): Promise<Cluster | undefined> {
    try {
      const response = await this.request<{
        kind: 'ClusterDetail'
        data: ClusterDetailData
      }>(`/clusters/${encodeURIComponent(id)}`, 'ClusterDetail')
      return clusterFromDetail(response.data)
    } catch (error) {
      if (error instanceof ConsoleDataError && error.code === 'NOT_FOUND') return undefined
      throw error
    }
  }

  async getEvidence(id: string): Promise<EvidenceRef | undefined> {
    try {
      const response = await this.request<EvidenceReferenceResponse>(`/evidence/${encodeURIComponent(id)}`, 'EvidenceReference')
      return evidenceFromContract(response)
    } catch (error) {
      if (error instanceof ConsoleDataError && error.code === 'NOT_FOUND') return undefined
      throw error
    }
  }
}
