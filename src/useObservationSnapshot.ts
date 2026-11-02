import { useEffect, useState } from 'react'
import { consoleData, consoleDataMode } from './data/consoleData'
import { ConsoleDataError } from './data/bffAdapter'
import type { PlatformSnapshot } from './domain/contracts'
import { conservativeVerdict } from './observationPresentation'

export const BROWSER_OBSERVATION_CEILING_MS = 60_000
const SNAPSHOT_POLL_MS = 30_000

export function useObservationSnapshot(enabled: boolean, attempt: number) {
  const [result, setResult] = useState<{ data: PlatformSnapshot; startedAt: number }>()
  const [error, setError] = useState<ConsoleDataError>()
  const [failed, setFailed] = useState(false)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let active = true
    let generation = 0
    let applied = 0
    if (!enabled) {
      setResult(undefined)
      setError(undefined)
      return
    }
    const refresh = () => {
      const request = ++generation
      const startedAt = performance.now()
      consoleData.getSnapshot().then(data => {
        if (!active || request < applied) return
        applied = request
        setResult({ data, startedAt })
        setFailed(false)
        setError(undefined)
      }).catch((cause: unknown) => {
        if (!active || request < applied) return
        applied = request
        setFailed(true)
        setError(cause instanceof ConsoleDataError ? cause : new ConsoleDataError('Platform data could not be loaded.', 'INTERNAL_ERROR', true))
      })
    }
    refresh()
    if (consoleDataMode !== 'bff') return () => { active = false }
    const visibleRefresh = () => { if (document.visibilityState === 'visible') { setTick(value => value + 1); refresh() } }
    const poll = window.setInterval(visibleRefresh, SNAPSHOT_POLL_MS)
    window.addEventListener('hashchange', visibleRefresh)
    document.addEventListener('visibilitychange', visibleRefresh)
    return () => {
      active = false
      window.clearInterval(poll)
      window.removeEventListener('hashchange', visibleRefresh)
      document.removeEventListener('visibilitychange', visibleRefresh)
    }
  }, [enabled, attempt])
  useEffect(() => {
    if (!result || consoleDataMode !== 'bff') return
    const timer = window.setTimeout(() => setTick(value => value + 1), Math.max(0, BROWSER_OBSERVATION_CEILING_MS - (performance.now() - result.startedAt)))
    return () => window.clearTimeout(timer)
  }, [result])
  // Tick triggers a render when the ceiling or visibility boundary is crossed.
  void tick
  const aged = consoleDataMode === 'bff' && (failed || !!result && performance.now() - result.startedAt >= BROWSER_OBSERVATION_CEILING_MS)
  const data = result?.data
  return { data: data && aged ? {
    ...data,
    freshness: conservativeVerdict(data.freshness, 'Stale'),
    clusterListFreshness: conservativeVerdict(data.clusterListFreshness, 'Stale'),
    clusters: data.clusters.map(item => ({ ...item, freshness: conservativeVerdict(item.freshness, 'Stale') })),
    evidence: data.evidence.map(item => ({ ...item, freshness: conservativeVerdict(item.freshness, 'Stale') })),
  } : data, startedAt: result?.startedAt ?? -Infinity, error, aged }
}
