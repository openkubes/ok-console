import { useEffect, useState } from 'react'
import './wjax.css'
import LocalUsersPrototype from './LocalUsersPrototype'

type Deployment = { name: string; desired: number; ready: number }
type Pod = { name: string; phase: string; ready: boolean; restarts: number }
type Snapshot = { deployments: Deployment[]; pods: Pod[] }
type Observation = { status: 'loading' | 'observed' | 'unavailable'; snapshot?: Snapshot; receivedAt?: string }

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid observation')
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid observation')
  return value
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid observation')
  return value
}
function snapshot(value: unknown): Snapshot {
  const data = record(value)
  if (data.cluster !== 'kind-wjax-demo' || data.namespace !== 'wjax-demo'
    || data.mode !== 'read-only-live' || !Array.isArray(data.deployments) || !Array.isArray(data.pods)) {
    throw new Error('Invalid observation')
  }
  // Project only display fields. Never render arbitrary response properties or errors.
  return {
    deployments: data.deployments.map((value) => {
      const item = record(value)
      return { name: text(item.name), desired: count(item.desired), ready: count(item.ready) }
    }),
    pods: data.pods.map((value) => {
      const item = record(value)
      if (typeof item.ready !== 'boolean') throw new Error('Invalid observation')
      return { name: text(item.name), phase: text(item.phase), ready: item.ready, restarts: count(item.restarts) }
    }),
  }
}

export default function WjaxClusterView() {
  const [attempt, setAttempt] = useState(0)
  const [observation, setObservation] = useState<Observation>({ status: 'loading' })
  useEffect(() => {
    let active = true
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    setObservation((previous) => ({ status: 'loading', receivedAt: previous.receivedAt }))
    async function refresh() {
      try {
        const response = await fetch('/api/wjax-kind/snapshot', {
          method: 'GET', cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal,
        })
        if (!response.ok) throw new Error('Reader unavailable')
        const data = snapshot(await response.json())
        if (active) setObservation({ status: 'observed', snapshot: data, receivedAt: new Date().toISOString() })
      } catch {
        if (active) setObservation((previous) => ({ status: 'unavailable', receivedAt: previous.receivedAt }))
      } finally {
        clearTimeout(timer)
      }
    }
    void refresh()
    return () => { active = false; clearTimeout(timer); controller.abort() }
  }, [attempt])

  const data = observation.snapshot
  return <section className="wjax-view" aria-labelledby="wjax-title">
    <header className="page-title"><div><span className="eyebrow">W-JAX 2026 · Local demo only · Read-only</span><h1 id="wjax-title">Local Kubernetes</h1><p>Cluster <strong>kind-wjax-demo</strong> · Namespace <strong>wjax-demo</strong></p></div><button className="secondary-button" disabled={observation.status === 'loading'} onClick={() => setAttempt((value) => value + 1)}>Refresh observation</button></header>
    <div className="panel">
      <p>This view reads the local Kubernetes Reader. It does not grant approval or execute recovery.</p>
      <a className="text-button" href="http://127.0.0.1:8788/" target="_blank" rel="noopener noreferrer">Open Agentic Operations demo ↗</a>
      <p className="wjax-timestamp">Last successful observation (browser received): {observation.receivedAt ? <time dateTime={observation.receivedAt}>{observation.receivedAt}</time> : 'None yet'}. Refresh explicitly to observe changes.</p>
      {observation.status === 'loading' && <p role="status">Refreshing — no current workload data shown.</p>}
      {observation.status === 'unavailable' && <p role="alert">Reader unavailable or response invalid. No current workload data is shown; any last-success timestamp above is historical. Check the local Reader and refresh.</p>}
      {observation.status === 'observed' && <p role="status">Read-only snapshot received. This is a point-in-time observation, not signed recovery evidence.</p>}
    </div>
    <LocalUsersPrototype/>
    {data && <>
      <div className="panel wjax-table"><table><caption>Deployments</caption><thead><tr><th scope="col">Name</th><th scope="col">Desired replicas</th><th scope="col">Ready replicas</th><th scope="col">Ready / desired</th></tr></thead><tbody>{data.deployments.map((item) => <tr key={item.name}><th scope="row">{item.name}</th><td>{item.desired}</td><td>{item.ready}</td><td>{item.ready}/{item.desired}</td></tr>)}</tbody></table>{data.deployments.length === 0 && <p>No Deployments observed in wjax-demo.</p>}</div>
      <div className="panel wjax-table"><table><caption>Pods</caption><thead><tr><th scope="col">Name</th><th scope="col">Phase</th><th scope="col">Ready</th><th scope="col">Restarts</th></tr></thead><tbody>{data.pods.map((item) => <tr key={item.name}><th scope="row">{item.name}</th><td>{item.phase}</td><td>{item.ready ? 'Yes' : 'No'}</td><td>{item.restarts}</td></tr>)}</tbody></table>{data.pods.length === 0 && <p>No Pods observed in wjax-demo.</p>}</div>
      <p>In this lab, two replicas are expected. A Deployment configured for zero replicas can correctly reconcile to 0/0; this view does not infer a Kubernetes failure or READY_VERIFIED.</p>
    </>}
  </section>
}
