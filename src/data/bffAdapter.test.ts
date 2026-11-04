import { describe, expect, it, vi } from 'vitest'
import platformOverview from '../../contracts/presentation/v0alpha1/examples/platform-overview.json'
import clusterList from '../../contracts/presentation/v0alpha1/examples/cluster-list.json'
import clusterDetail from '../../contracts/presentation/v0alpha1/examples/cluster-detail.json'
import evidenceReference from '../../contracts/presentation/v0alpha1/examples/evidence-reference.json'
import sourceUnavailable from '../../contracts/presentation/v0alpha1/examples/error-source-unavailable.json'
import { BffConsoleAdapter } from './bffAdapter'

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

describe('BffConsoleAdapter', () => {
  it.each(['Current', 'Stale', 'Unknown'] as const)('maps Evidence freshness %s into the browser model', async freshness => {
    const response = structuredClone(evidenceReference)
    response.meta.freshness = freshness
    const fetcher = vi.fn(async () => jsonResponse(response)) as typeof fetch
    expect(await new BffConsoleAdapter('/api/console/v0', fetcher).getEvidence(response.data.id))
      .toMatchObject({ outcome: response.data.outcome, freshness })
  })

  it('labels hosting deployment placements as observations and loads their evidence', async () => {
    const overview = structuredClone(platformOverview)
    overview.data.recentPlacements = [{
      id: 'observed-deployment-openkubes-console-ok-console', name: 'openkubes-console/ok-console',
      targetCluster: 'ok-shared', readiness: 'Ready', evidenceId: 'ev-observed-console',
    }]
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/overview')) return jsonResponse(overview)
      if (url.endsWith('/clusters')) return jsonResponse(clusterList)
      return jsonResponse(evidenceReference)
    }) as typeof fetch
    const snapshot = await new BffConsoleAdapter('/api/console/v0', fetcher).getSnapshot()
    expect(snapshot.claims[0]).toMatchObject({ kind: 'Observed Deployment', targetCluster: 'ok-shared' })
    expect(fetcher).toHaveBeenCalledWith('/api/console/v0/evidence/ev-observed-console', expect.anything())
  })

  it('maps the stable read-only responses behind ConsoleDataPort', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/overview')) return jsonResponse(platformOverview)
      if (url.endsWith('/clusters')) return jsonResponse(clusterList)
      if (url.includes('/evidence/')) return jsonResponse(evidenceReference)
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch
    const adapter = new BffConsoleAdapter('/api/console/v0', fetcher)

    const snapshot = await adapter.getSnapshot()

    expect(snapshot.source).toBe('bff')
    expect(snapshot.agentDeployments).toEqual([])
    expect(snapshot.evidence.map(item => item.id)).toEqual([evidenceReference.data.id, evidenceReference.data.id, evidenceReference.data.id])
    expect(snapshot.agents.every(agent => agent.deployments === 0)).toBe(true)
    expect(snapshot.clusterListFreshness).toBe(clusterList.meta.freshness)
    expect(snapshot.clusters[0].freshness).toBe(clusterList.meta.freshness)
    expect(snapshot.overview?.clusters.total).toBe(4)
    expect(snapshot.clusters.map((cluster) => cluster.name)).toEqual(['ok-mgmt', 'edge-07'])
    expect(snapshot.clusters[0]).toMatchObject({ role: 'Management plane', version: 'v1.32.6', capabilityCount: 4 })
    expect(snapshot.evidence.length).toBeGreaterThan(0)
    expect(fetcher).toHaveBeenCalledWith(
      '/api/console/v0/overview',
      expect.objectContaining({ credentials: 'same-origin' }),
    )
  })

  it('loads cluster detail without exposing the transport model to views', async () => {
    const fetcher = vi.fn(async () => jsonResponse(clusterDetail)) as typeof fetch
    const adapter = new BffConsoleAdapter('/api/console/v0', fetcher)

    const cluster = await adapter.getCluster('cluster-ok-ai')

    expect(cluster).toMatchObject({
      freshness: clusterDetail.meta.freshness,
      name: 'ok-ai',
      version: 'v1.32.6',
      capabilities: ['cap-observability'],
    })
    expect(cluster?.lifecycle[0].label).toBe('Control plane')
  })

  it('preserves safe server error semantics for the UI', async () => {
    const fetcher = vi.fn(async () => jsonResponse(sourceUnavailable, 503)) as typeof fetch
    const adapter = new BffConsoleAdapter('/api/console/v0', fetcher)

    await expect(adapter.getSnapshot()).rejects.toMatchObject({
      code: 'SOURCE_UNAVAILABLE',
      retryable: true,
      correlationId: 'corr-error-0001',
    })
  })

  it('fails closed before mapping an incompatible response', async () => {
    const incompatible = structuredClone(platformOverview) as Record<string, unknown>
    incompatible.apiVersion = 'console.openkubes.io/v9'
    const fetcher = vi.fn(async () => jsonResponse(incompatible)) as typeof fetch
    const adapter = new BffConsoleAdapter('/api/console/v0', fetcher)

    await expect(adapter.getSnapshot()).rejects.toMatchObject({
      code: 'CONTRACT_INCOMPATIBLE',
      retryable: false,
    })
  })

  it('rejects a valid contract kind returned from the wrong endpoint', async () => {
    const fetcher = vi.fn(async () => jsonResponse(clusterList)) as typeof fetch
    const adapter = new BffConsoleAdapter('/api/console/v0', fetcher)

    await expect(adapter.getSnapshot()).rejects.toMatchObject({
      code: 'CONTRACT_INCOMPATIBLE',
      retryable: false,
    })
  })

  it('keeps partial evidence failure degraded instead of losing the fleet', async () => {
    let evidenceCalls = 0
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/overview')) return jsonResponse(platformOverview)
      if (url.endsWith('/clusters')) return jsonResponse(clusterList)
      evidenceCalls += 1
      if (evidenceCalls === 1) throw new Error('evidence source unavailable')
      return jsonResponse(evidenceReference)
    }) as typeof fetch
    const adapter = new BffConsoleAdapter('/api/console/v0', fetcher)

    const snapshot = await adapter.getSnapshot()

    expect(snapshot.clusters).toHaveLength(2)
    expect(snapshot.warnings).toContain('1 evidence reference could not be loaded (NETWORK_ERROR).')
  })
})

it.each(['/overview', '/clusters', '/clusters/cluster-ok-ai', '/evidence/ev-test'])('R3 treats malformed HTTP 401 at %s as session-ended before JSON validation', async endpoint => {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input).replace('/api/console/v0', '')
    if (path === endpoint || endpoint.startsWith('/evidence/') && path.startsWith('/evidence/')) return new Response('not json', { status: 401 })
    if (path === '/overview') return jsonResponse(platformOverview)
    if (path === '/clusters') return jsonResponse(clusterList)
    return jsonResponse(evidenceReference)
  }) as typeof fetch
  const adapter = new BffConsoleAdapter('/api/console/v0', fetcher)
  const request = endpoint.startsWith('/clusters/') ? adapter.getCluster('cluster-ok-ai') : adapter.getSnapshot()
  await expect(request).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
})
it.each(['headers', 'body'])('R3 15s timeout covers %s and aborts sibling requests', async phase => {
  vi.useFakeTimers()
  try {
    const signals: AbortSignal[] = []
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init!.signal!)
      if (phase === 'headers') return new Promise<Response>(() => {})
      return { status: 200, json: () => new Promise(() => {}) } as Response
    }) as typeof fetch
    const request = new BffConsoleAdapter('/api/console/v0', fetcher).getSnapshot()
    const check = expect(request).rejects.toMatchObject({ code: 'NETWORK_ERROR', message: expect.stringMatching(/timed out/) })
    await vi.advanceTimersByTimeAsync(14_999)
    expect(signals.every(signal => !signal.aborted)).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(signals.length).toBe(2)
    expect(signals.every(signal => signal.aborted)).toBe(true)
    await check
  } finally { vi.useRealTimers() }
})
it('R3 Evidence 401 is not swallowed by allSettled behind a hanging sibling', async () => {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/overview')) return jsonResponse(platformOverview)
    if (url.endsWith('/clusters')) return jsonResponse(clusterList)
    if (url.endsWith(clusterList.data.items[0].evidenceId)) return new Response(null, { status: 401 })
    return new Promise<Response>(() => {})
  }) as typeof fetch
  await expect(new BffConsoleAdapter('/api/console/v0', fetcher).getSnapshot()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
})
it.each(['/overview', '/clusters', '/clusters/test', '/evidence/test'])('R4 401 at %s aborts its shared request scope', async path => {
  const controller = new AbortController()
  const fetcher = vi.fn(async () => new Response('malformed', { status: 401 })) as typeof fetch
  const adapter = new BffConsoleAdapter('/api/console/v0', fetcher)
  const result = path === '/overview' || path === '/clusters' ? adapter.getSnapshot(controller) : path.startsWith('/clusters/') ? adapter.getCluster('test', controller) : adapter.getEvidence('test', controller)
  await expect(result).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
  expect(controller.signal.aborted).toBe(true)
  expect(controller.signal.reason).toMatchObject({ code: 'UNAUTHENTICATED' })
})
it('R4 overview failure followed by clusters 401 preserves authentication failure', async () => {
  let denied!: (response: Response) => void
  const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/overview') ? jsonResponse(sourceUnavailable, 503) : new Promise<Response>(done => { denied = done })) as typeof fetch
  const controller = new AbortController()
  const pending = new BffConsoleAdapter('/api/console/v0', fetcher).getSnapshot(controller)
  const assertion = expect(pending).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
  await new Promise(done => setTimeout(done, 0))
  denied(new Response('', { status: 401 }))
  await assertion
  expect(controller.signal.aborted).toBe(true)
})
