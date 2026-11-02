import { useEffect, useRef, useState } from 'react'
import { consoleData, consoleDataMode } from './data/consoleData'
import { ConsoleDataError } from './data/bffAdapter'
import type { Cluster, PlatformSnapshot } from './domain/contracts'
import { conservativeVerdict } from './observationPresentation'

export const BROWSER_OBSERVATION_CEILING_MS = 60_000
export const SNAPSHOT_POLL_MS = 30_000
export const USER_INPUT_IDLE_MS = 4 * 60_000

type Observation<T> = { data: T; startedAt: number; wallStart: number; generation: number }
type Cap = { generation: number; verdict: Cluster['freshness']; released?: string[] }
const failure = (cause: unknown) => cause instanceof ConsoleDataError ? cause : new ConsoleDataError('Platform data could not be loaded.', 'INTERNAL_ERROR', true)

export function useObservationSnapshot(enabled: boolean, attempt: number, selected?: Cluster, onSessionEnded?: () => void) {
  const [result, setResult] = useState<Observation<PlatformSnapshot>>()
  const [detail, setDetail] = useState<Observation<Cluster>>()
  const [caps, setCaps] = useState<Record<string, Cap>>({})
  const [error, setError] = useState<ConsoleDataError>()
  const [detailError, setDetailError] = useState<ConsoleDataError>()
  const [failed, setFailed] = useState(false)
  const [detailFailed, setDetailFailed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [tick, setTick] = useState(0)
  const [wallAged, setWallAged] = useState(false)
  const [detailWallAged, setDetailWallAged] = useState(false)
  const selectedRef = useRef(selected)
  const selectionEpoch = useRef({ id: selected?.id, value: 0 })
  if (selectionEpoch.current.id !== selected?.id) selectionEpoch.current = { id: selected?.id, value: selectionEpoch.current.value + 1 }
  selectedRef.current = selected
  const endedRef = useRef(onSessionEnded)
  endedRef.current = onSessionEnded
  const refreshRef = useRef<(kind?: 'auto' | 'user' | 'retry') => void>(() => {})

  useEffect(() => {
    let active = true // This closure is a session epoch; all callbacks check it.
    let generation = 0
    let inFlight = false
    let pending: 'auto' | 'user' | undefined
    let lastInput = performance.now()
    let idle = false
    let lastSuccess = -Infinity
    let lastWallStart = -Infinity
    let lastDetailWallStart = -Infinity
    let controller: AbortController | undefined
    let idleTimer: number | undefined
    let poll = 0
    setResult(undefined); setDetail(undefined); setCaps({})
    setError(undefined); setDetailError(undefined); setFailed(false); setDetailFailed(false)
    setWallAged(false); setDetailWallAged(false); setLoading(false)
    if (!enabled) return
    const endSession = () => {
      if (!active) return
      active = false; pending = undefined
      window.clearInterval(poll); window.clearTimeout(idleTimer)
      controller?.abort()
      setResult(undefined); setDetail(undefined); setCaps({}); setLoading(false)
      endedRef.current?.()
    }
    const handleFailure = (cause: unknown, isDetail: boolean) => {
      if (!active) return
      const err = failure(cause)
      if (err.code === 'UNAUTHENTICATED') { endSession(); return }
      if (isDetail) { setDetailFailed(true); setDetailError(err) }
      else { setFailed(true); setError(err) }
    }
    const refresh = (kind: 'auto' | 'user' | 'retry' = 'user') => {
      if (!active || (kind === 'auto' && idle)) return
      if (inFlight) {
        if (kind !== 'retry') pending = kind === 'user' || pending === 'user' ? 'user' : 'auto'
        return
      }
      inFlight = true
      pending = undefined
      const request = ++generation
      const startedAt = performance.now()
      const wallStart = Date.now()
      const cluster = selectedRef.current
      const selection = selectionEpoch.current.value
      const scope = controller = new AbortController()
      setLoading(true); setError(undefined); setDetailError(undefined)
      const snapshotRequest = consoleData.getSnapshot(scope).then(data => {
        if (!active) return
        lastSuccess = startedAt; lastWallStart = wallStart
        setResult({ data, startedAt, wallStart, generation: request })
        setWallAged(false); setFailed(false); setError(undefined)

      }).catch(cause => handleFailure(cause, false))
      const detailStart = performance.now()
      const detailWallStart = Date.now()
      const detailRequest = cluster && consoleDataMode === 'bff' ? consoleData.getCluster(cluster.id, scope).then(data => {
        if (!active || selection !== selectionEpoch.current.value) return
        const value = data ?? { ...cluster, freshness: 'Unknown' as const }
        lastDetailWallStart = detailWallStart
        setDetail({ data: value, startedAt: detailStart, wallStart: detailWallStart, generation: request })
        setDetailWallAged(false); setDetailFailed(false); setDetailError(undefined)
        const verdict = conservativeVerdict(value.freshness, value.readiness === 'Unknown' ? 'Unknown' : 'Current')
        setCaps(previous => ({ ...previous, [cluster.id]: { generation: request, verdict }, [cluster.name]: { generation: request, verdict } }))
      }).catch(cause => {
        // A 401 ends this epoch even if the user has switched clusters.
        if (failure(cause).code === 'UNAUTHENTICATED' || selection === selectionEpoch.current.value) handleFailure(cause, true)
      }) : Promise.resolve()
      void Promise.allSettled([snapshotRequest, detailRequest]).then(() => {
        if (!active) return
        inFlight = false; setLoading(false)
        const followUp = pending
        pending = undefined
        if (followUp) refresh(followUp)
      })
    }
    refreshRef.current = refresh
    refresh()
    if (consoleDataMode !== 'bff') return () => { active = false; controller?.abort() }
    const checkWall = () => {
      if (Date.now() - lastWallStart >= BROWSER_OBSERVATION_CEILING_MS) setWallAged(true)
      if (Date.now() - lastDetailWallStart >= BROWSER_OBSERVATION_CEILING_MS) setDetailWallAged(true)
      setTick(value => value + 1)
    }
    const visibleRefresh = () => { checkWall(); if (document.visibilityState === 'visible') refresh() }
    const stopIdle = () => {
      idle = true
      if (pending === 'auto') pending = undefined
    }
    const armIdle = () => { window.clearTimeout(idleTimer); idleTimer = window.setTimeout(stopIdle, USER_INPUT_IDLE_MS) }
    armIdle()
    const input = () => {
      if (!active) return
      armIdle()
      lastInput = performance.now()
      const wasIdle = idle
      idle = false
      if (wasIdle && performance.now() - lastSuccess > SNAPSHOT_POLL_MS) refresh()
    }
    poll = window.setInterval(() => {
      if (performance.now() - lastInput >= USER_INPUT_IDLE_MS) {
        idle = true
        if (pending === 'auto') pending = undefined
      }
      if (!idle && document.visibilityState === 'visible') refresh('auto')
    }, SNAPSHOT_POLL_MS)
    const inputs = ['pointerdown', 'pointermove', 'keydown', 'touchstart', 'scroll']
    inputs.forEach(event => window.addEventListener(event, input, { passive: true, capture: true }))
    window.addEventListener('hashchange', visibleRefresh)
    window.addEventListener('focus', visibleRefresh)
    window.addEventListener('online', visibleRefresh)
    document.addEventListener('visibilitychange', visibleRefresh)
    return () => {
      active = false; pending = undefined; controller?.abort(); refreshRef.current = () => {}
      window.clearInterval(poll); window.clearTimeout(idleTimer)
      inputs.forEach(event => window.removeEventListener(event, input, true))
      window.removeEventListener('hashchange', visibleRefresh)
      window.removeEventListener('focus', visibleRefresh)
      window.removeEventListener('online', visibleRefresh)
      document.removeEventListener('visibilitychange', visibleRefresh)
    }
  }, [enabled])
  useEffect(() => { if (attempt) refreshRef.current('retry') }, [attempt])
  useEffect(() => {
    setDetail(undefined); setDetailFailed(false); setDetailError(undefined)
    if (selected && enabled && consoleDataMode === 'bff') refreshRef.current()
    // Only changing the selection starts a refresh; fresh result objects do not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, enabled])
  useEffect(() => {
    if (consoleDataMode !== 'bff') return
    const starts = [result?.startedAt, detail?.startedAt].filter((value): value is number => value !== undefined && performance.now() - value < BROWSER_OBSERVATION_CEILING_MS)
    if (!starts.length) return
    const timer = window.setTimeout(() => setTick(value => value + 1), Math.max(0, Math.min(...starts) + BROWSER_OBSERVATION_CEILING_MS - performance.now()))
    return () => window.clearTimeout(timer)
  }, [result, detail, tick])
  useEffect(() => {
    if (!result) return
    setCaps(previous => {
      let next = previous
      for (const [key, cap] of Object.entries(previous)) {
        if (result.generation < cap.generation) continue
        const released = result.data.evidence.filter(item => item.cluster === key && item.freshness === 'Current' && !cap.released?.includes(item.id)).map(item => item.id)
        if (!released.length) continue
        if (next === previous) next = { ...previous }
        next[key] = { ...cap, released: [...(cap.released ?? []), ...released] }
      }
      return next
    })
  }, [result, caps])
  const aged = consoleDataMode === 'bff' && (failed || wallAged || !!result && performance.now() - result.startedAt >= BROWSER_OBSERVATION_CEILING_MS)
  const detailAged = consoleDataMode === 'bff' && (detailFailed || detailWallAged || !!detail && performance.now() - detail.startedAt >= BROWSER_OBSERVATION_CEILING_MS)
  const rawData = result?.data
  const data = rawData && {
    ...rawData,
    freshness: aged ? conservativeVerdict(rawData.freshness, 'Stale') : rawData.freshness,
    clusterListFreshness: aged ? conservativeVerdict(rawData.clusterListFreshness, 'Stale') : rawData.clusterListFreshness,
    clusters: rawData.clusters.map(item => aged ? { ...item, freshness: conservativeVerdict(item.freshness, 'Stale') } : item),
    evidence: rawData.evidence.map(item => {
      const cap = caps[item.cluster]
      const released = cap && (cap.released?.includes(item.id) || result.generation >= cap.generation && item.freshness === 'Current')
      return { ...item, freshness: conservativeVerdict(item.freshness, aged ? 'Stale' : 'Current', cap && !released ? cap.verdict : 'Current') }
    }),
  }
  const summary = data?.clusters.find(item => item.id === selected?.id)
  const loadedDetail = detail?.data.id === selected?.id ? detail : undefined
  const basis = loadedDetail?.data ?? selected
  const effectiveDetail = basis && data && {
    ...basis,
    readiness: loadedDetail && result && loadedDetail.startedAt >= result.startedAt ? basis.readiness : summary?.readiness ?? basis.readiness,
    freshness: conservativeVerdict(basis.freshness, summary?.freshness, basis.readiness === 'Unknown' || summary?.readiness === 'Unknown' ? 'Unknown' : 'Current', detailAged ? 'Stale' : 'Current'),
  }
  return { data, originalEvidence: rawData?.evidence, detail: effectiveDetail, detailError, startedAt: result?.startedAt ?? -Infinity, generation: result?.generation ?? 0, error, aged, loading, retry: () => refreshRef.current('retry') }
}
