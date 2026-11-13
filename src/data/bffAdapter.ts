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
import { conservativeVerdict } from '../observationPresentation'

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
  private readonly requestScopes = new WeakMap<AbortController, { active: number; waiting: (() => void)[] }>()
  private readonly visibleDetails = new WeakMap<AbortController, Set<string>>()
  private readonly detailRequests = new WeakMap<AbortController, Map<string, Promise<Cluster | undefined>>>()

  constructor(
    private readonly baseUrl = '/api/console/v0',
    private readonly fetcher: FetchLike = (...args) => fetch(...args),
  ) {}

  // Include the selected detail in the same refresh budget as snapshot requests.
  private async request<T>(path: string, expectedKind: string, controller = new AbortController()): Promise<T> {
    let scope = this.requestScopes.get(controller)
    if (!scope) { scope = { active: 0, waiting: [] }; this.requestScopes.set(controller, scope) }
    if (scope.active < 4) scope.active++
    else await new Promise<void>(resolve => scope.waiting.push(resolve))
    try {
      if (controller.signal.aborted) throw controller.signal.reason
      return await this.performRequest<T>(path, expectedKind, controller)
    } finally {
      const next = scope.waiting.shift()
      if (next) next()
      else scope.active--
    }
  }

  private async performRequest<T>(path: string, expectedKind: string, controller = new AbortController()): Promise<T> {
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
      const error = new ConsoleDataError(
        payload.error.message,
        payload.error.code,
        payload.error.retryable,
        payload.meta.correlationId,
      )
      if (error.code === 'UNAUTHENTICATED') controller.abort(error)
      throw error
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
    const settle = <T>(jobs: (() => Promise<T>)[]) => Promise.allSettled(jobs.map(job => job()))
    const evidenceIds = new Set([
      ...clusters.data.items.map((cluster) => cluster.evidenceId),
      ...overview.data.recentPlacements.map((placement) => placement.evidenceId),
    ])
    // Interleave primary Evidence and detail requests so either authentication path
    // can terminate a refresh even while another endpoint is hanging.
    const jobs = clusters.data.items.flatMap(cluster => [
      () => this.cachedCluster(cluster.id, controller),
      () => this.getEvidence(cluster.evidenceId, controller),
    ])
    const placementIds = [...evidenceIds].filter(id => !clusters.data.items.some(cluster => cluster.evidenceId === id))
    const initial = await settle<Cluster | EvidenceRef | undefined>([
      ...jobs, ...placementIds.map(id => () => this.getEvidence(id, controller)),
    ])
    if (controller.signal.aborted) throw controller.signal.reason
    const detailResults = clusters.data.items.map((_, index) => initial[index * 2] as PromiseSettledResult<Cluster | undefined>)
    const detailFailures: string[] = []
    const details = detailResults.map((result, index) => {
      const summary = clusters.data.items[index]
      if (result.status === 'rejected') {
        detailFailures.push(result.reason instanceof ConsoleDataError ? result.reason.code : 'INTERNAL_ERROR')
        return undefined
      }
      const detail = result.value
      if (!detail) { detailFailures.push('NOT_FOUND'); return undefined }
      if (detail.id !== summary.id || detail.name !== summary.name || detail.evidenceId !== summary.evidenceId ||
          detail.revision !== summary.revision || detail.capabilityDetails?.length !== summary.capabilityCount) {
        detailFailures.push('CONTRACT_INCOMPATIBLE')
        return undefined
      }
      return detail
    })
    // These references support the visible detail capability labels, not row freshness.
    const capabilityEvidenceIds = new Set(details.flatMap(detail => detail && this.visibleDetails.get(controller)?.has(detail.id)
      ? detail.capabilityDetails?.map(item => item.evidenceId) ?? [] : []))
    const capabilityResults = await settle([...capabilityEvidenceIds].filter(id => !evidenceIds.has(id)).map(id => () => this.getEvidence(id, controller)))
    if (controller.signal.aborted) throw controller.signal.reason
    const evidenceResults = [
      ...clusters.data.items.map((_, index) => initial[index * 2 + 1]),
      ...initial.slice(clusters.data.items.length * 2), ...capabilityResults,
    ] as PromiseSettledResult<EvidenceRef | undefined>[]
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
        ...(detailFailures.length > 0 ? [`${detailFailures.length} cluster detail${detailFailures.length === 1 ? '' : 's'} could not be loaded (${[...new Set(detailFailures)].sort().join(', ')}).`] : []),
        ...(unavailableEvidence > 0 ? [`${unavailableEvidence} evidence reference${unavailableEvidence === 1 ? '' : 's'} could not be loaded (${[...new Set(evidenceFailures)].join(', ')}).`] : []),
      ],
      overview: overview.data,
      clusters: clusters.data.items.map((cluster, index) => ({
        ...clusterFromSummary(cluster),
        capabilityDetails: details[index]?.capabilityDetails,
        // The BFF detail verdict covers all of this cluster's Evidence, including
        // placements and unreferenced items that the browser never loads.
        freshness: conservativeVerdict(details[index]?.freshness,
          evidence.find(item => item?.id === cluster.evidenceId && (item.cluster === cluster.id || item.cluster === cluster.name))?.freshness,
          ...evidence.filter((item): item is EvidenceRef => Boolean(item && (item.cluster === cluster.id || item.cluster === cluster.name))).map(item => item.freshness)),
      })),
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

  getCluster(id: string, controller = new AbortController()): Promise<Cluster | undefined> {
    let visible = this.visibleDetails.get(controller)
    if (!visible) { visible = new Set(); this.visibleDetails.set(controller, visible) }
    visible.add(id)
    return this.cachedCluster(id, controller)
  }

  private cachedCluster(id: string, controller: AbortController): Promise<Cluster | undefined> {
    let requests = this.detailRequests.get(controller)
    if (!requests) { requests = new Map(); this.detailRequests.set(controller, requests) }
    let request = requests.get(id)
    if (!request) {
      request = this.loadCluster(id, controller)
      requests.set(id, request)
    }
    return request
  }

  private async loadCluster(id: string, controller: AbortController): Promise<Cluster | undefined> {
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
