import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useObservationSnapshot } from './useObservationSnapshot'
import { consoleData } from './data/consoleData'
import { ConsoleDataError } from './data/bffAdapter'
import { platformFixture } from './data/fixtures'
import type { PlatformSnapshot } from './domain/contracts'

vi.mock('./data/consoleData', async original => ({ ...await original<typeof import('./data/consoleData')>(), consoleDataMode: 'bff' }))
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
const snapshot = () => ({ ...structuredClone(platformFixture), source: 'bff' as const, freshness: 'Current' as const, clusterListFreshness: 'Current' as const })
it.each(['success', '401'] as const)('R3 old session %s cannot populate or sign out a new session', async completion => {
  let resolve!: (data: PlatformSnapshot) => void
  let reject!: (error: Error) => void
  vi.spyOn(consoleData, 'getSnapshot').mockImplementationOnce(() => new Promise((done, fail) => { resolve = done; reject = fail })).mockResolvedValue(snapshot())
  const ended = vi.fn()
  const { result, rerender } = renderHook(({ enabled }) => useObservationSnapshot(enabled, 0, undefined, ended), { initialProps: { enabled: true } })
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
  renderHook(() => useObservationSnapshot(true, 0))
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
  const { result } = renderHook(() => useObservationSnapshot(true, 0, cluster))
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
  const { result } = renderHook(() => useObservationSnapshot(true, 0, cluster))
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
  const { result } = renderHook(() => useObservationSnapshot(true, 0, cluster))
  await act(async () => {})
  expect(result.current.detail?.freshness).toBe('Unknown')
})
