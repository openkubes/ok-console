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
