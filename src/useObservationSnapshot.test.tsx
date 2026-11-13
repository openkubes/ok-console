import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { clusterPresentation } from './observationPresentation'
import { useObservationSnapshot } from './useObservationSnapshot'
import { consoleData } from './data/consoleData'
import { ConsoleDataError } from './data/bffAdapter'
import { platformFixture } from './data/fixtures'
import type { Cluster, PlatformSnapshot } from './domain/contracts'

vi.mock('./data/consoleData', async original => ({ ...await original<typeof import('./data/consoleData')>(), consoleDataMode: 'bff' }))
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
const snapshot = () => ({ ...structuredClone(platformFixture), source: 'bff' as const, freshness: 'Current' as const, clusterListFreshness: 'Current' as const })
it.each(['success', '401'] as const)('R3 old session %s cannot populate or sign out a new session', async completion => {
  let resolve!: (data: PlatformSnapshot) => void
  let reject!: (error: Error) => void
  vi.spyOn(consoleData, 'getSnapshot').mockImplementationOnce(() => new Promise((done, fail) => { resolve = done; reject = fail })).mockResolvedValue(snapshot())
  const ended = vi.fn()
  const { result, rerender } = renderHook(({ enabled }) => useObservationSnapshot(enabled, undefined, ended), { initialProps: { enabled: true } })
  rerender({ enabled: false }); rerender({ enabled: true })
  await act(async () => {})
  const applied = result.current.generation
  await act(async () => { if (completion === 'success') resolve({ ...snapshot(), freshness: 'Unknown' }); else reject(new ConsoleDataError('old', 'UNAUTHENTICATED', false)) })
  expect(ended).not.toHaveBeenCalled()
  expect(result.current.data?.freshness).toBe('Current')
  expect(result.current.generation).toBe(applied)
})
it('R3 idle boundary discards an automatic queued follow-up before the in-flight request finishes', async () => {
  vi.useFakeTimers()
  let resolve!: (data: PlatformSnapshot) => void
  const fetch = vi.spyOn(consoleData, 'getSnapshot').mockResolvedValueOnce(snapshot()).mockImplementationOnce(() => new Promise(done => { resolve = done })).mockResolvedValue(snapshot())
  renderHook(() => useObservationSnapshot(true))
  await act(async () => {})
  await act(async () => { await vi.advanceTimersByTimeAsync(240_000) })
  expect(fetch).toHaveBeenCalledTimes(2)
  await act(async () => { resolve(snapshot()) })
  expect(fetch).toHaveBeenCalledTimes(2)
})
it('R3 snapshot failure demotes detail independently; detail recovery alone cannot upgrade it', async () => {
  vi.useFakeTimers()
  const data = snapshot()
  data.clusters.forEach(c => { c.freshness = 'Current' })
  const cluster = data.clusters[0]
  const fetch = vi.spyOn(consoleData, 'getSnapshot').mockResolvedValue(data)
  vi.spyOn(consoleData, 'getCluster').mockResolvedValue(cluster)
  const { result } = renderHook(() => useObservationSnapshot(true, cluster))
  await act(async () => {})
  fetch.mockRejectedValueOnce(new Error('snapshot unavailable'))
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
  expect(result.current.data?.freshness).toBe('Stale')
  expect(result.current.detail?.freshness).toBe('Stale')
})
it('R3 later-started snapshot wins until the same-generation detail arrives and wins the tie', async () => {
  vi.useFakeTimers()
  const data = snapshot()
  const cluster = { ...data.clusters[0], readiness: 'Ready' as const, freshness: 'Current' as const }
  data.clusters = [cluster]
  const fetch = vi.spyOn(consoleData, 'getSnapshot').mockResolvedValue(data)
  const detailFetch = vi.spyOn(consoleData, 'getCluster').mockResolvedValue(cluster)
  const { result } = renderHook(() => useObservationSnapshot(true, cluster))
  await act(async () => {})
  let resolve!: (value: typeof cluster) => void
  fetch.mockResolvedValue({ ...data, clusters: [{ ...cluster, readiness: 'Failed' }] })
  detailFetch.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
  expect(result.current.detail?.readiness).toBe('Failed')
  await act(async () => { resolve(cluster) })
  expect(result.current.detail?.readiness).toBe('Ready')
})
it.each(['snapshot', 'detail'])('R3 Unknown readiness in the %s independently suppresses the detail', async unknown => {
  const data = snapshot()
  const cluster = { ...data.clusters[0], readiness: 'Ready' as const, freshness: 'Current' as const }
  data.clusters = [{ ...cluster, readiness: unknown === 'snapshot' ? 'Unknown' : 'Ready' }]
  vi.spyOn(consoleData, 'getSnapshot').mockResolvedValue(data)
  vi.spyOn(consoleData, 'getCluster').mockResolvedValue({ ...cluster, readiness: unknown === 'detail' ? 'Unknown' : 'Ready' })
  const { result } = renderHook(() => useObservationSnapshot(true, cluster))
  await act(async () => {})
  expect(result.current.detail?.freshness).toBe('Unknown')
})
it('R4 older snapshot cannot release a newer detail cap while its snapshot is pending', async () => {
  vi.useFakeTimers()
  const data = snapshot()
  const cluster = { ...data.clusters[0], freshness: 'Current' as const, readiness: 'Ready' as const }
  data.clusters = [cluster]
  data.evidence = [{ ...data.evidence[0], id: cluster.evidenceId, cluster: cluster.id, freshness: 'Current', outcome: 'Ready' }]
  vi.spyOn(consoleData, 'getSnapshot').mockResolvedValueOnce(data).mockImplementation(() => new Promise(() => {}))
  vi.spyOn(consoleData, 'getCluster').mockResolvedValueOnce(cluster).mockResolvedValue({ ...cluster, freshness: 'Unknown' })
  const { result } = renderHook(() => useObservationSnapshot(true, cluster))
  await act(async () => {})
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
  expect(result.current.data?.evidence[0].freshness).toBe('Unknown')
})
it('R4 A to B to A rejects the first A detail by selection epoch', async () => {
  const data = snapshot()
  const a = { ...data.clusters[0], freshness: 'Current' as const, readiness: 'Ready' as const }
  const b = { ...a, id: 'B', name: 'B' }
  data.clusters = [a, b]
  data.evidence = [{ ...data.evidence[0], id: a.evidenceId, cluster: a.id, freshness: 'Current', outcome: 'Ready' }]
  vi.spyOn(consoleData, 'getSnapshot').mockResolvedValueOnce(data).mockImplementation(() => new Promise(() => {}))
  let resolve!: (value: Cluster) => void
  vi.spyOn(consoleData, 'getCluster').mockImplementation(() => new Promise(done => { resolve = done }))
  const { result, rerender, unmount } = renderHook(({ selected }) => useObservationSnapshot(true, selected), { initialProps: { selected: a } })
  await act(async () => {})
  rerender({ selected: b }); rerender({ selected: a })
  await act(async () => { resolve({ ...a, readiness: 'Unknown', freshness: 'Unknown' }) })
  expect(result.current.data?.evidence[0].freshness).toBe('Current')
  expect(result.current.detail?.readiness).toBe('Ready')
  unmount()
})
it('R4 poll detects a forward wall jump without an external event', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'] })
  // Delay the independent ceiling tick to exercise the poll check in isolation.
  const schedule = window.setTimeout
  vi.spyOn(window, 'setTimeout').mockImplementation((handler, delay, ...args) => schedule(handler, delay === 60_000 ? 120_000 : delay, ...args))
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
  vi.spyOn(consoleData, 'getSnapshot').mockResolvedValueOnce(snapshot()).mockImplementation(() => new Promise(() => {}))
  const { result } = renderHook(() => useObservationSnapshot(true))
  await act(async () => {})
  now.mockReturnValue(601_000)
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
  expect(result.current.data?.freshness).toBe('Stale')
})
it('R4 repeated automatic events while idle make zero requests; input resumes', async () => {
  vi.useFakeTimers()
  const requests = vi.spyOn(consoleData, 'getSnapshot').mockResolvedValue(snapshot())
  renderHook(() => useObservationSnapshot(true))
  await act(async () => {})
  await act(async () => { await vi.advanceTimersByTimeAsync(240_000) })
  requests.mockClear()
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(600_000)
    })
  }
  expect(requests).toHaveBeenCalledTimes(0)
  await act(async () => { window.dispatchEvent(new Event('pointerdown')) })
  expect(requests).toHaveBeenCalledTimes(1)
})
it('R4 keeps the detail error object throughout retries until success', async () => {
  vi.useFakeTimers()
  const data = snapshot(), cluster = data.clusters[0]
  vi.spyOn(consoleData, 'getSnapshot').mockResolvedValue(data)
  const fetch = vi.spyOn(consoleData, 'getCluster').mockRejectedValue(new ConsoleDataError('detail down', 'NETWORK_ERROR', true))
  const { result } = renderHook(() => useObservationSnapshot(true, cluster))
  await act(async () => {})
  const error = result.current.detailError
  let resolve!: (value: typeof cluster) => void
  fetch.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
  expect(result.current.detailError).toBe(error)
  await act(async () => { resolve(cluster) })
  expect(result.current.detailError).toBeUndefined()
})
it('R5 poll detects wall gaps, and backward clocks cannot upgrade', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'] })
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
  const requests = vi.spyOn(consoleData, 'getSnapshot').mockResolvedValueOnce(snapshot()).mockImplementation(() => new Promise(() => {}))
  const { result } = renderHook(() => useObservationSnapshot(true))
  await act(async () => {})
  now.mockReturnValue(601_000)
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
  expect(result.current.data?.freshness).toBe('Stale')
  now.mockReturnValue(0)
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
  expect(result.current.data?.freshness).toBe('Stale')
  expect(requests).toHaveBeenCalledTimes(2)
})


it.each(['wheel', 'pointerdown'])('R5 scroll cannot resume or reset idle; %s resumes once', async input => {
  vi.useFakeTimers()
  const requests = vi.spyOn(consoleData, 'getSnapshot').mockResolvedValue(snapshot())
  const listeners = vi.spyOn(window, 'addEventListener')
  renderHook(() => useObservationSnapshot(true))
  await act(async () => {})
  await act(async () => { await vi.advanceTimersByTimeAsync(240_000) })
  requests.mockClear()
  await act(async () => {
    window.dispatchEvent(new Event('scroll'))
    // jsdom cannot manufacture a trusted event. Deliver a trusted-like event
    // directly to any registered scroll handler, independent of dispatch trust.
    for (const [type, listener] of listeners.mock.calls) {
      if (type === 'scroll' && typeof listener === 'function') listener.call(window, { type: 'scroll', isTrusted: true } as Event)
    }
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(30_000)
  })
  expect(requests).toHaveBeenCalledTimes(0)
  await act(async () => { window.dispatchEvent(new Event(input)) })
  expect(requests).toHaveBeenCalledTimes(1)
})

it('R5 fresh observations cause no renders between polls; the ceiling still demotes', async () => {
  vi.useFakeTimers()
  const requests = vi.spyOn(consoleData, 'getSnapshot').mockResolvedValue(snapshot())
  let renders = 0
  const { result } = renderHook(() => { renders++; return useObservationSnapshot(true) })
  await act(async () => {})
  for (let poll = 0; poll < 2; poll++) {
    const before = renders
    for (let second = 0; second < 29; second++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
      expect(renders).toBe(before)
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
  }
  requests.mockImplementation(() => new Promise(() => {}))
  await act(async () => { await vi.advanceTimersByTimeAsync(59_999) })
  expect(result.current.data?.freshness).toBe('Current')
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(result.current.data?.freshness).toBe('Stale')
})


it('R6 a forward wall gap demotes within one second with performance frozen', async () => {
  vi.useFakeTimers()
  vi.spyOn(performance, 'now').mockReturnValue(0)
  vi.spyOn(consoleData, 'getSnapshot').mockResolvedValue(snapshot())
  let renders = 0
  const { result } = renderHook(() => { renders++; return useObservationSnapshot(true) })
  await act(async () => {})
  const before = renders
  for (let second = 0; second < 25; second++) {
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(renders).toBe(before)
  }
  vi.setSystemTime(Date.now() + 600_000)
  await act(async () => { await vi.advanceTimersByTimeAsync(999) })
  expect(result.current.data?.freshness).toBe('Current')
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(result.current.data?.freshness).toBe('Stale')
  const demoted = renders
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
  expect(renders).toBe(demoted)
})

it.each(['success', 'failure'] as const)('R2 S1 tab return burst issues one overview request after %s', async completion => {
  vi.useFakeTimers()
  const { BffConsoleAdapter } = await import('./data/bffAdapter')
  const overview = (await import('../contracts/presentation/v0alpha1/examples/platform-overview.json')).default
  const clusters = (await import('../contracts/presentation/v0alpha1/examples/cluster-list.json')).default
  const evidence = (await import('../contracts/presentation/v0alpha1/examples/evidence-reference.json')).default
  const requests = vi.fn(async (url: RequestInfo | URL) => new Response(JSON.stringify(String(url).endsWith('/overview') ? overview : String(url).endsWith('/clusters') ? clusters : evidence)))
  const adapter = new BffConsoleAdapter('/api/console/v0', requests as typeof globalThis.fetch)
  const fetch = vi.spyOn(consoleData, 'getSnapshot').mockImplementation(scope => adapter.getSnapshot(scope))
  renderHook(() => useObservationSnapshot(true))
  await act(async () => {})
  const overviewRequests = () => requests.mock.calls.filter(([url]) => String(url).endsWith('/overview')).length
  expect(overviewRequests()).toBe(1)
  const visible = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  await act(async () => { await vi.advanceTimersByTimeAsync(30_001) })
  visible.mockReturnValue('visible')
  let resolve!: () => void
  let reject!: (cause: Error) => void
  fetch.mockImplementationOnce(async scope => {
    const data = await adapter.getSnapshot(scope)
    return new Promise<PlatformSnapshot>((done, fail) => { resolve = () => done(data); reject = fail })
  })
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('hashchange'))
    window.dispatchEvent(new Event('online'))
  })
  expect(overviewRequests()).toBe(2)
  await act(async () => { if (completion === 'success') resolve(); else reject(new Error('offline')) })
  // Even events delivered after completion belong to the same return burst.
  await act(async () => {
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('online'))
    window.dispatchEvent(new Event('hashchange'))
  })
  expect(overviewRequests()).toBe(2)
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
  expect(overviewRequests()).toBe(2)
})

it.each(['Current', 'Stale', 'Unknown'] as const)('R2 RT1 newer snapshot supplies lifecycle and revision while its %s detail is pending', async detailFreshness => {
  vi.useFakeTimers()
  const data = snapshot()
  const initial = { ...data.clusters[0], readiness: 'Ready' as const, freshness: 'Current' as const, revision: 'old-revision', lifecycle: [{ label: 'Nodes', state: 'Ready' as const, detail: 'Old nodes' }] }
  data.clusters = [initial]
  const fetch = vi.spyOn(consoleData, 'getSnapshot').mockResolvedValue(data)
  const detailFetch = vi.spyOn(consoleData, 'getCluster').mockResolvedValue({ ...initial, freshness: detailFreshness })
  const { result } = renderHook(() => useObservationSnapshot(true, initial))
  await act(async () => {})
  const next = { ...initial, readiness: 'Failed' as const, revision: 'new-revision', lifecycle: [{ label: 'Nodes', state: 'Failed' as const, detail: 'New nodes' }] }
  fetch.mockResolvedValue({ ...data, clusters: [next] })
  let resolve!: (cluster: Cluster) => void
  detailFetch.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
  expect(result.current.detail?.revision).toBe('new-revision')
  expect(result.current.detail?.lifecycle).toEqual(next.lifecycle)
  expect(result.current.detail?.freshness).toBe(detailFreshness)
  await act(async () => { resolve({ ...next, revision: 'new-detail-revision' }) })
  expect(result.current.detail?.revision).toBe('new-detail-revision')
})

it('per-cluster fresh sibling ages at the browser ceiling and recovers on refresh', async () => {
  vi.useFakeTimers()
  const data: PlatformSnapshot = snapshot()
  data.clusterListFreshness = 'Stale'
  data.clusters = ['fresh', 'stale'].map(name => ({ ...data.clusters[0], id: name, name, evidenceId: `ev-${name}`, readiness: 'Ready', freshness: name === 'fresh' ? 'Current' : 'Stale' }))
  data.evidence = data.clusters.map(cluster => ({ ...data.evidence[0], id: cluster.evidenceId, cluster: cluster.id, freshness: cluster.freshness, outcome: 'Ready', immutable: false }))
  let release!: (value: PlatformSnapshot) => void
  vi.spyOn(consoleData, 'getSnapshot').mockResolvedValueOnce(data).mockImplementationOnce(() => new Promise(done => { release = done })).mockResolvedValue(data)
  const { result } = renderHook(() => useObservationSnapshot(true))
  await act(async () => {})
  const current = () => result.current.data!.clusters.map(item => clusterPresentation(item, result.current.data!).verdict)
  expect(current()).toEqual(['Current', 'Stale'])
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
  expect(current()).toEqual(['Stale', 'Stale'])
  // Release the observation started at 30s; it is still below the browser ceiling.
  await act(async () => { release(data) })
  expect(current()).toEqual(['Current', 'Stale'])
})
