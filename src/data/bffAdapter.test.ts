import { describe, expect, it, vi } from 'vitest'
import platformOverview from '../../contracts/presentation/v0alpha1/examples/platform-overview.json'
import clusterList from '../../contracts/presentation/v0alpha1/examples/cluster-list.json'
import clusterDetail from '../../contracts/presentation/v0alpha1/examples/cluster-detail.json'
import evidenceReference from '../../contracts/presentation/v0alpha1/examples/evidence-reference.json'
import sourceUnavailable from '../../contracts/presentation/v0alpha1/examples/error-source-unavailable.json'
import { clusterPresentation } from '../observationPresentation'
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
      if (url.includes('/clusters/')) {
        const summary = clusterList.data.items.find(item => url.endsWith(`/${item.id}`))!
        return jsonResponse({ ...clusterDetail, data: { ...clusterDetail.data, ...summary, capabilities: [] } })
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch
    const adapter = new BffConsoleAdapter('/api/console/v0', fetcher)

    const snapshot = await adapter.getSnapshot()

    expect(snapshot.source).toBe('bff')
    expect(snapshot.agentDeployments).toEqual([])
    expect(snapshot.evidence.map(item => item.id)).toEqual([evidenceReference.data.id, evidenceReference.data.id, evidenceReference.data.id])
    expect(snapshot.agents.every(agent => agent.deployments === 0)).toBe(true)
    expect(snapshot.clusterListFreshness).toBe(clusterList.meta.freshness)
    // This example Evidence belongs to ok-ai, not the listed ok-mgmt.
    expect(snapshot.clusters[0].freshness).toBe('Unknown')
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
      if (url.includes('/clusters/')) throw new Error('detail unavailable')
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

it.each(['Current', 'Stale', 'Unknown'] as const)('U3 %s overview never fabricates Kagent runtime evidence', async freshness => {
  const overview = structuredClone(platformOverview)
  overview.meta.freshness = freshness
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/overview')) return jsonResponse(overview)
    if (url.endsWith('/clusters')) return jsonResponse(clusterList)
    return jsonResponse(evidenceReference)
  }) as typeof fetch
  const snapshot = await new BffConsoleAdapter('/api/console/v0', fetcher).getSnapshot()
  expect(snapshot.agentDeployments).toEqual([])
  expect(snapshot.agents.every(agent => agent.deployments === 0)).toBe(true)
  expect(snapshot.evidence.every(item => item.id === evidenceReference.data.id)).toBe(true)
  expect(snapshot.evidence.some(item => /kagent|cluster.inspector/i.test(item.title))).toBe(false)
})

// List freshness is an aggregate; the matching detail route and own Evidence grant row currency.
it.each(['mixed', 'envelope', 'missing', 'foreign'] as const)('per-cluster adapter: %s', async scenario => {
  const list = structuredClone(clusterList)
  list.meta.freshness = 'Stale'
  list.data.items = ['fresh', 'stale'].map(name => ({ ...list.data.items[0], id: `cluster-${name}`, name, evidenceId: `ev-${name}`, readiness: 'Ready', capabilityCount: 0 }))
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/overview')) return jsonResponse(platformOverview)
    if (url.endsWith('/clusters')) return jsonResponse(list)
    if (url.includes('/clusters/')) {
      const summary = list.data.items.find(item => url.endsWith(`/${item.id}`))!
      return jsonResponse({ ...clusterDetail, meta: { ...clusterDetail.meta, freshness: scenario === 'envelope' || summary.name === 'stale' ? 'Stale' : 'Current' }, data: { ...clusterDetail.data, ...summary, capabilities: [] } })
    }
    if (scenario === 'missing' && url.endsWith('/ev-fresh')) throw new Error('unavailable')
    const name = url.endsWith('/ev-fresh') ? 'fresh' : 'stale'
    const response = structuredClone(evidenceReference)
    Object.assign(response.data, { id: `ev-${name}`, clusterId: scenario === 'foreign' ? 'foreign' : `cluster-${name}` })
    response.meta.freshness = scenario === 'envelope' || name === 'stale' ? 'Stale' : 'Current'
    return jsonResponse(response)
  }) as typeof fetch
  const data = await new BffConsoleAdapter('/api/console/v0', fetcher).getSnapshot()
  expect(data.clusterListFreshness).toBe('Stale')
  expect(data.clusters.map(item => item.freshness)).toEqual(scenario === 'mixed' ? ['Current', 'Stale'] : scenario === 'envelope' ? ['Stale', 'Stale'] : scenario === 'missing' ? ['Unknown', 'Stale'] : ['Unknown', 'Unknown'])
})

it.each(['Current', 'Stale', 'Unknown', 'missing', 'foreign', 'detail-unavailable', 'detail-foreign', 'detail-conflicting', 'detail-name', 'detail-reference', 'detail-count', '401'] as const)('per-cluster adapter loads capability references: %s', async scenario => {
  const list = structuredClone(clusterList)
  list.meta.freshness = 'Stale'
  list.data.items = [{ ...list.data.items[0], readiness: 'Ready', capabilityCount: 1 }]
  const cluster = list.data.items[0]
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/overview')) return jsonResponse(platformOverview)
    if (url.endsWith('/clusters')) return jsonResponse(list)
    if (url.includes('/clusters/')) {
      if (scenario === 'detail-unavailable') throw new Error('unavailable')
      return jsonResponse({ ...clusterDetail, meta: { ...clusterDetail.meta, freshness: 'Stale' }, data: {
        ...clusterDetail.data, ...cluster, id: scenario === 'detail-foreign' ? 'foreign' : cluster.id, name: scenario === 'detail-name' ? 'foreign' : cluster.name, evidenceId: scenario === 'detail-reference' ? 'foreign' : cluster.evidenceId, revision: scenario === 'detail-conflicting' ? 'different-revision' : cluster.revision,
        capabilities: scenario === 'detail-count' ? [] : [{ ...clusterDetail.data.capabilities[0], evidenceId: 'ev-capability' }],
      } })
    }
    const cap = url.endsWith('/ev-capability')
    if (cap && scenario === 'missing') throw new Error('unavailable')
    if (cap && scenario === '401') return new Response('not json', { status: 401 })
    return jsonResponse({ ...evidenceReference, meta: { ...evidenceReference.meta, freshness: cap && (scenario === 'Stale' || scenario === 'Unknown') ? scenario : 'Current' }, data: {
      ...evidenceReference.data, id: cap ? 'ev-capability' : cluster.evidenceId,
      clusterId: cap && scenario === 'foreign' ? 'foreign' : cluster.id,
    } })
  }) as typeof fetch
  const adapter = new BffConsoleAdapter('/api/console/v0', fetcher)
  const controller = new AbortController()
  const selected = adapter.getCluster(cluster.id, controller).catch(() => undefined)
  const pending = adapter.getSnapshot(controller)
  if (scenario === '401') { await expect(pending).rejects.toMatchObject({ code: 'UNAUTHENTICATED' }); return }
  const data = await pending
  await selected
  expect(clusterPresentation(data.clusters[0], data)).toMatchObject({
    current: false, verdict: scenario.startsWith('detail-') || scenario === 'Unknown' ? 'Unknown' : 'Stale',
  })
  if (!scenario.startsWith('detail-')) expect(fetcher).toHaveBeenCalledWith('/api/console/v0/evidence/ev-capability', expect.anything())
})

// Zero capabilities is the hosting-cluster case from the real-BFF regressions.
it.each(['Current', 'Stale', 'Unknown', 'absent', 'failed', 'wrong-kind', 'count', 'id', 'name', 'revision', 'reference', 'missing-verdict', 'null-verdict'] as const)('zero-capability detail verdict: %s', async scenario => {
  const list = structuredClone(clusterList)
  list.meta.freshness = 'Stale'
  list.data.items = ['affected', 'sibling'].map(name => ({ ...list.data.items[0], id: `cluster-${name}`, name, evidenceId: `ev-${name}`, capabilityCount: 0, readiness: 'Ready' }))
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/overview')) return jsonResponse({ ...platformOverview, data: { ...platformOverview.data, recentPlacements: [] } })
    if (url.endsWith('/clusters')) return jsonResponse(list)
    const affected = url.endsWith('affected')
    const summary = list.data.items[affected ? 0 : 1]
    if (url.includes('/clusters/')) {
      if (affected && scenario === 'failed') throw new TypeError('unavailable')
      if (affected && scenario === 'absent') return jsonResponse({ ...sourceUnavailable, error: { ...sourceUnavailable.error, code: 'NOT_FOUND' } }, 404)
      if (affected && scenario === 'wrong-kind') return jsonResponse(evidenceReference)
      const detail = { ...structuredClone(clusterDetail), data: { ...structuredClone(clusterDetail.data), ...summary, capabilities: [] as typeof clusterDetail.data.capabilities } }
      detail.meta.freshness = affected && ['Stale', 'Unknown'].includes(scenario) ? scenario : 'Current'
      if (affected) {
        if (scenario === 'count') detail.data.capabilities.push(clusterDetail.data.capabilities[0])
        if (scenario === 'id') detail.data.id = 'foreign'
        if (scenario === 'name') detail.data.name = 'foreign'
        if (scenario === 'revision') detail.data.revision = 'different'
        if (scenario === 'reference') detail.data.evidenceId = 'foreign'
        if (scenario === 'missing-verdict') Reflect.deleteProperty(detail.meta, 'freshness')
        if (scenario === 'null-verdict') Object.assign(detail.meta, { freshness: null })
      }
      return jsonResponse(detail)
    }
    return jsonResponse({ ...evidenceReference, meta: { ...evidenceReference.meta, freshness: 'Current' }, data: { ...evidenceReference.data, id: summary.evidenceId, clusterId: summary.id } })
  }) as typeof fetch
  const data = await new BffConsoleAdapter('/api/console/v0', fetcher).getSnapshot()
  const verdict = scenario === 'Current' || scenario === 'Stale' ? scenario : 'Unknown'
  expect(data.clusters.map(cluster => clusterPresentation(cluster, data).verdict)).toEqual([verdict, 'Current'])
  expect(data.clusters.map(cluster => cluster.freshness)).toEqual([verdict, 'Current'])
  expect(fetcher).toHaveBeenCalledWith('/api/console/v0/clusters/cluster-affected', expect.anything())
  const code = scenario === 'absent' ? 'NOT_FOUND' : scenario === 'failed' ? 'NETWORK_ERROR' : 'CONTRACT_INCOMPATIBLE'
  if (!['Current', 'Stale', 'Unknown'].includes(scenario)) expect(data.warnings).toContain(`1 cluster detail could not be loaded (${code}).`)
  if (['Current', 'Stale', 'Unknown'].includes(scenario)) expect(data.warnings?.filter(item => item.includes('cluster detail'))).toEqual([])
})

it.each(['http', 'contract'] as const)('detail %s UNAUTHENTICATED aborts hanging siblings and queued requests', async mode => {
  const controller = new AbortController()
  const list = structuredClone(clusterList)
  list.data.items = Array.from({ length: 12 }, (_, i) => ({ ...list.data.items[0], id: `cluster-${i}`, evidenceId: `ev-${i}`, capabilityCount: 0 }))
  const started: string[] = []
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/overview')) return jsonResponse(platformOverview)
    if (url.endsWith('/clusters')) return jsonResponse(list)
    started.push(url)
    if (url.endsWith('/clusters/cluster-0')) return mode === 'http' ? new Response('not json', { status: 401 }) : jsonResponse({ ...sourceUnavailable, error: { code: 'UNAUTHENTICATED', message: 'Sign in again.', retryable: false } }, 403)
    return new Promise<Response>(() => {})
  }) as typeof fetch
  await expect(new BffConsoleAdapter('/api/console/v0', fetcher).getSnapshot(controller)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
  expect(controller.signal.aborted).toBe(true)
  expect(started.length).toBeLessThanOrEqual(4)
})

it('bounds detail and capability Evidence concurrency and reuses detail only within a refresh', async () => {
  const list = structuredClone(clusterList)
  list.data.items = Array.from({ length: 9 }, (_, i) => ({ ...list.data.items[0], id: `cluster-${i}`, name: `cluster-${i}`, evidenceId: `ev-${i}`, capabilityCount: 2 }))
  const overview = { ...platformOverview, data: { ...platformOverview.data, recentPlacements: [] } }
  let active = 0
  let peak = 0
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/overview')) return jsonResponse(overview)
    if (url.endsWith('/clusters')) return jsonResponse(list)
    active++; peak = Math.max(active, peak)
    await new Promise(resolve => setTimeout(resolve, 1))
    active--
    if (url.includes('/clusters/')) {
      const summary = list.data.items.find(item => url.endsWith(`/${item.id}`))!
      return jsonResponse({ ...clusterDetail, meta: { ...clusterDetail.meta, freshness: 'Current' }, data: { ...clusterDetail.data, ...summary, capabilities: [0, 1].map(i => ({ ...clusterDetail.data.capabilities[0], id: `cap-${i}`, evidenceId: `${summary.evidenceId}-cap-${i}` })) } })
    }
    const id = url.split('/').at(-1)!
    const summary = list.data.items.find(item => id.startsWith(item.evidenceId))!
    return jsonResponse({ ...evidenceReference, meta: { ...evidenceReference.meta, freshness: 'Current' }, data: { ...evidenceReference.data, id, clusterId: summary.id } })
  }) as typeof fetch
  const adapter = new BffConsoleAdapter('/api/console/v0', fetcher)
  const scope = new AbortController()
  const [data, selected] = await Promise.all([adapter.getSnapshot(scope), adapter.getCluster('cluster-8', scope)])
  expect(data.clusters.every(item => clusterPresentation(item, data).current)).toBe(true)
  expect(selected?.id).toBe('cluster-8')
  expect(peak).toBe(4)
  expect(data.evidence).toHaveLength(11)
  expect(vi.mocked(fetcher).mock.calls.filter(([url]) => String(url).endsWith('/clusters/cluster-8'))).toHaveLength(1)
  const next = await adapter.getSnapshot(new AbortController())
  expect(next.evidence).toHaveLength(9)
  expect(next.clusters.every(item => clusterPresentation(item, next).current)).toBe(true)
  expect(vi.mocked(fetcher).mock.calls.filter(([url]) => String(url).endsWith('/clusters/cluster-8'))).toHaveLength(2)
})

it('contract detail denial aborts the refresh before releasing its request slot', async () => {
  const controller = new AbortController()
  const fetcher = vi.fn(async () => jsonResponse({ ...sourceUnavailable, error: { code: 'UNAUTHENTICATED', message: 'Sign in again.', retryable: false } }, 403)) as typeof fetch
  await expect(new BffConsoleAdapter('/api/console/v0', fetcher).getCluster('cluster-test', controller)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
  expect(controller.signal.aborted).toBe(true)
  expect(controller.signal.reason).toMatchObject({ code: 'UNAUTHENTICATED' })
})
