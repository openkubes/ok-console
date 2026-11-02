import type {
  ClusterDetailData,
  ClusterListResponse,
  ConsoleErrorCode,
  ConsoleErrorResponse,
  EvidenceReferenceResponse,
  PlatformOverviewResponse,
  ClusterDetailResponse,
} from '../domain/presentationContract'
import {
  PRESENTATION_CONTRACT_VERSION,
  validateConsoleResponse,
} from '../domain/presentationContract'
import type { Cluster, ConsoleDataPort, EvidenceRef, PlatformSnapshot } from '../domain/contracts'
import { curatedAgents } from './agentCatalog'

export const BFF_REQUEST_TIMEOUT_MS = 15_000

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
  freshness: response.meta.freshness,
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

  private async request<T>(path: string, expectedKind: string, controller = new AbortController()): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let abortListener: (() => void) | undefined
    let payload: unknown
    let response!: Response
    try {
      payload = await Promise.race([
        new Promise<never>((_, reject) => {
          abortListener = () => reject(controller.signal.reason instanceof ConsoleDataError ? controller.signal.reason : new ConsoleDataError('The Console BFF request was interrupted.', 'NETWORK_ERROR', true))
          if (controller.signal.aborted) abortListener()
          else controller.signal.addEventListener('abort', abortListener, { once: true })
        }),
        (async () => {
          response = await this.fetcher(`${this.baseUrl}${path}`, {
            headers: { Accept: `application/json; profile="${PRESENTATION_CONTRACT_VERSION}"` },
            credentials: 'same-origin', signal: controller.signal,
          })
          // Authentication is an HTTP boundary, even for an empty or malformed body.
          if (response.status === 401) throw new ConsoleDataError('Your session ended. Sign in again.', 'UNAUTHENTICATED', false)
          try { return await response.json() as unknown }
          catch { throw new ConsoleDataError('The Console BFF returned an unreadable response.', 'CONTRACT_INCOMPATIBLE', false) }
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new ConsoleDataError('The Console BFF request timed out.', 'NETWORK_ERROR', true))
            controller.abort(new ConsoleDataError('The Console BFF request timed out.', 'NETWORK_ERROR', true))
          }, BFF_REQUEST_TIMEOUT_MS)
        }),
      ])
    } catch (error) {
      if (error instanceof ConsoleDataError) {
        if (error.code === 'UNAUTHENTICATED') controller.abort(error)
        throw error
      }
      throw new ConsoleDataError('The Console BFF is unavailable.', 'NETWORK_ERROR', true)
    } finally { clearTimeout(timer); if (abortListener) controller.signal.removeEventListener('abort', abortListener) }

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

  async getSnapshot(controller = new AbortController()): Promise<PlatformSnapshot> {
    const results = await Promise.allSettled([
      this.request<PlatformOverviewResponse>('/overview', 'PlatformOverview', controller),
      this.request<ClusterListResponse>('/clusters', 'ClusterList', controller),
    ])
    const denied = results.find(result => result.status === 'rejected' && result.reason instanceof ConsoleDataError && result.reason.code === 'UNAUTHENTICATED')
    if (denied?.status === 'rejected') throw denied.reason
    const [overview, clusters] = results.map(result => {
      if (result.status === 'rejected') throw result.reason
      return result.value
    }) as [PlatformOverviewResponse, ClusterListResponse]
    const evidenceIds = new Set([
      ...clusters.data.items.map((cluster) => cluster.evidenceId),
      ...overview.data.recentPlacements.map((placement) => placement.evidenceId),
    ])
    const evidenceResults = await Promise.allSettled(
      [...evidenceIds].map(async (id) => {
        try { return await this.getEvidence(id, controller) }
        catch (error) {
          if (error instanceof ConsoleDataError && error.code === 'UNAUTHENTICATED') controller.abort(error)
          throw error
        }
      }),
    )
    for (const result of evidenceResults) {
      if (result.status === 'rejected' && result.reason instanceof ConsoleDataError &&
          (result.reason.code === 'UNAUTHENTICATED' || controller.signal.aborted)) throw result.reason
    }
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
      clusterListFreshness: clusters.meta.freshness,
      warnings: [
        ...(overview.meta.warnings?.map((warning) => warning.message) ?? []),
        ...(unavailableEvidence > 0 ? [`${unavailableEvidence} evidence reference${unavailableEvidence === 1 ? '' : 's'} could not be loaded (${[...new Set(evidenceFailures)].join(', ')}).`] : []),
      ],
      overview: overview.data,
      clusters: clusters.data.items.map(cluster => ({ ...clusterFromSummary(cluster), freshness: clusters.meta.freshness })),
      capabilities: [],
      claims: overview.data.recentPlacements.map((placement) => ({
        id: placement.id,
        name: placement.name,
        kind: placement.id.startsWith('observed-deployment-') ? 'Observed Deployment' : 'WorkloadClaim',
        owner: placement.id.startsWith('observed-deployment-') ? 'Hosting cluster' : 'Platform team',
        intent: placement.id.startsWith('observed-deployment-') ? 'Kubernetes Deployment observed through the hosting-cluster API.' : 'Read-only placement projection',
        targetCluster: placement.targetCluster,
        readiness: placement.readiness,
        requiredCapabilities: [],
        decision: `Observed placement on ${placement.targetCluster}`,
        evidenceId: placement.evidenceId,
      })),
      agents: curatedAgents.map(agent => ({ ...agent, deployments: 0 })),
      agentDeployments: [],
      evidence: evidence.filter((item): item is EvidenceRef => item !== undefined),
    }
  }

  async getCluster(id: string, controller = new AbortController()): Promise<Cluster | undefined> {
    try {
      const response = await this.request<ClusterDetailResponse>(`/clusters/${encodeURIComponent(id)}`, 'ClusterDetail', controller)
      return { ...clusterFromDetail(response.data), freshness: response.meta.freshness }
    } catch (error) {
      if (error instanceof ConsoleDataError && error.code === 'NOT_FOUND') return undefined
      throw error
    }
  }

  async getEvidence(id: string, controller = new AbortController()): Promise<EvidenceRef | undefined> {
    try {
      const response = await this.request<EvidenceReferenceResponse>(`/evidence/${encodeURIComponent(id)}`, 'EvidenceReference', controller)
      return evidenceFromContract(response)
    } catch (error) {
      if (error instanceof ConsoleDataError && error.code === 'NOT_FOUND') return undefined
      throw error
    }
  }
}
