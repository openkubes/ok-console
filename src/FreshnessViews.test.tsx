import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { consoleData } from './data/consoleData'
import { BffConsoleAdapter } from './data/bffAdapter'
import type { Freshness } from './domain/presentationContract'
import type { ConsoleAuthClient } from './auth/authClient'
import type { PlatformSnapshot } from './domain/contracts'
import overview from '../contracts/presentation/v0alpha1/examples/platform-overview.json'
import clusters from '../contracts/presentation/v0alpha1/examples/cluster-list.json'
import detail from '../contracts/presentation/v0alpha1/examples/cluster-detail.json'
import evidence from '../contracts/presentation/v0alpha1/examples/evidence-reference.json'

vi.mock('./data/consoleData', async importOriginal => ({ ...await importOriginal<typeof import('./data/consoleData')>(), consoleDataMode: 'bff' }))
const auth: ConsoleAuthClient = {
  mode: 'oidc', restoreSession: vi.fn(async () => ({ method: 'oidc' as const, identity: 'Freshness Viewer', source: 'test', assurance: 'Federated', expiresIn: '1h' })),
  startOidc: vi.fn(), authenticateLocal: vi.fn(), logout: vi.fn(),
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
const historyNote = 'Earlier answers were cleared because the data they used is no longer current.'
function textOf(scope: ParentNode) {
  const walker = document.createTreeWalker(scope as Node, NodeFilter.SHOW_TEXT)
  const parts: string[] = []
  while (walker.nextNode()) parts.push(walker.currentNode.textContent ?? '')
  return parts.join(' ')
}
function noCurrency(scope: ParentNode = document.body) {
  // The required history note explicitly denies currency; it is the sole permitted occurrence.
  expect(textOf(scope).replaceAll(historyNote, '')).not.toMatch(/\bcurrent(ly)?\b/i)
  expect(scope.querySelectorAll('.live-dot')).toHaveLength(0)
}
function fresh(scope: ParentNode = document.body) {
  expect(textOf(scope)).toMatch(/\bcurrent(ly)?\b/i)
  expect(scope.querySelector('.live-dot')).not.toBeNull()
}
function widget() {
  fireEvent.click(screen.getByRole('button', { name: /Ask OK AI/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Platform status' }))
}

async function mount(view = 'overview', verdict: Freshness = 'Current', options: {
  overview?: Freshness; clusters?: Freshness; detail?: Freshness; evidence?: Freshness;
  readiness?: 'Unknown'; outcome?: 'Unknown'; missing?: boolean; foreign?: boolean; immutable?: boolean; fixture?: boolean; empty?: boolean; mixed?: boolean; failedEvidence?: boolean
} = {}) {
  window.history.replaceState(null, '', `#/${view === 'detail' ? 'clusters' : view === 'drawer' ? 'evidence' : view}`)
  const e = structuredClone(evidence)
  e.meta.freshness = options.evidence ?? verdict
  e.data.classification = options.immutable ? 'Immutable' : 'Current'
  e.data.outcome = options.outcome ?? 'Ready'
  const c = structuredClone(clusters)
  c.meta.freshness = options.clusters ?? verdict
  c.data.items = [c.data.items[0]]
  c.data.items[0].readiness = options.readiness ?? 'Ready'
  c.data.items[0].evidenceId = e.data.id
  e.data.clusterId = options.foreign ? 'cluster-foreign' : c.data.items[0].id
  const o = structuredClone(overview)
  o.meta.freshness = options.overview ?? verdict
  o.data.recentPlacements = []
  const d = structuredClone(detail)
  d.meta.freshness = options.detail ?? verdict
  Object.assign(d.data, c.data.items[0])
  const adapter = new BffConsoleAdapter('/api/console/v0', vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url)
    if (options.failedEvidence && path.includes('/evidence/')) throw new TypeError('test Evidence connection failed')
    const body = path.endsWith('/overview') ? o : path.endsWith('/clusters') ? c : path.includes('/evidence/') ? e : d
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch)
  const snapshot = await adapter.getSnapshot()
  if (options.missing) snapshot.evidence = []
  if (options.fixture) snapshot.source = 'fixture'
  if (options.empty) { snapshot.clusters = []; snapshot.evidence = [] }
  if (options.mixed) {
    snapshot.claims = [{ id: 'placement', name: 'Affected placement', kind: 'Observed Deployment', owner: 'test', intent: '', targetCluster: c.data.items[0].name, readiness: 'Ready', requiredCapabilities: [], decision: '', evidenceId: 'placement-evidence' }]
    snapshot.evidence.push({ ...snapshot.evidence[0], id: 'placement-evidence', title: 'Placement Unknown', freshness: 'Unknown' })
  }
  const getSnapshot = vi.spyOn(consoleData, 'getSnapshot').mockResolvedValue(snapshot)
  vi.spyOn(consoleData, 'getCluster').mockImplementation(id => adapter.getCluster(id))
  const result = render(<App auth={auth}/>)
  await act(async () => {})
  screen.getByRole('heading', { name: view === 'overview' ? 'Hello Freshness' : view === 'agents' ? 'AI Agents' : view === 'clusters' || view === 'detail' ? 'Clusters' : 'Evidence & Audit' })
  if (view === 'detail') {
    fireEvent.click(screen.getByRole('button', { name: `Open ${c.data.items[0].name}` }))
    await act(async () => {})
    screen.getByText(d.data.lifecycle[0].label)
  }
  if (view === 'drawer') fireEvent.click(screen.getByRole('button', { name: new RegExp(e.data.title) }))
  return { ...result, snapshot, getSnapshot, cluster: c.data.items[0] }
}

describe('whole-document framing, including DiagnosticWidget', () => {
  for (const view of ['overview', 'clusters', 'detail', 'evidence', 'drawer', 'agents']) {
    it(`${view}: genuinely fresh positive control`, async () => {
      await mount(view)
      widget()
      if (view !== 'agents') fresh()
      expect(screen.getByText(/Observation freshness is current/)).toBeVisible()
    })
    for (const verdict of ['Stale', 'Unknown'] as const) {
      it(`${view}: ${verdict} never claims currency`, async () => {
        await mount(view, verdict)
        widget()
        noCurrency()
        expect(document.querySelectorAll('main .status-ready')).toHaveLength(0)
      })
    }
  }
  for (const view of ['overview', 'clusters', 'detail']) {
    for (const option of ['missing', 'foreign', 'readiness', 'outcome', 'failedEvidence'] as const) {
      it(`${view}: independent ${option} input suppresses affected item`, async () => {
        await mount(view, 'Current', { [option]: option === 'readiness' || option === 'outcome' ? 'Unknown' : true })
        widget()
        noCurrency()
      })
    }
  }
})

for (const view of ['overview', 'clusters', 'detail', 'evidence', 'drawer']) {
  it(`${view}: fixture observations have no Current wording or live dots`, async () => { await mount(view, 'Current', { fixture: true }); widget(); noCurrency() })
}
for (const view of ['overview', 'clusters', 'detail']) {
  it(`${view}: immutable basis is a dated historical receipt`, async () => {
    await mount(view, 'Current', { immutable: true })
    widget()
    noCurrency()
    expect(document.querySelector('main')).toHaveTextContent(/Immutable receipt.*2026/)
  })
}
for (const verdict of ['Stale', 'Unknown'] as const) {
  it(`detail: ${verdict} response caps earlier Current Evidence in main and drawer`, async () => {
    await mount('detail', 'Current', { detail: verdict })
    widget()
    noCurrency()
    fireEvent.click(document.querySelector('.evidence-card')!)
    noCurrency()
    for (const tab of ['Lifecycle', 'Capabilities']) {
      fireEvent.click(screen.getByRole('tab', { name: tab }))
      expect(document.querySelector('main .status-ready')).toBeNull()
    }
  })
  it(`clusters: own ${verdict} response overrides Current Evidence`, async () => {
    await mount('clusters', 'Current', { clusters: verdict })
    widget(); noCurrency()
  })
  it(`clusters: ${verdict} Evidence overrides Current response`, async () => {
    await mount('clusters', 'Current', { evidence: verdict })
    widget(); noCurrency()
  })
}
it('Overview: all clusters Ready, placement Unknown; fresh sibling stays Current', async () => {
  await mount('overview', 'Current', { mixed: true })
  widget()
  expect(document.querySelector('.snapshot')).toHaveTextContent('1 unavailable')
  noCurrency(document.querySelector('.snapshot')!)
  noCurrency(document.querySelector('.activity-row')!)
  noCurrency(document.querySelector('.diagnostic-widget')!)
  fresh(document.querySelector('.cluster-card')!)
})
it('Overview: valid Current empty fleet', async () => {
  await mount('overview', 'Current', { empty: true })
  expect(screen.getByText('No clusters observed')).toBeVisible()
  expect(document.querySelector('.snapshot')).toHaveTextContent('Current observation')
  expect(document.querySelector('.snapshot')).not.toHaveTextContent('Unknown')
})
for (const option of ['readiness', 'outcome'] as const) {
  it(`widget: independent Unknown ${option} qualifies a named Evidence outcome`, async () => {
    const { cluster } = await mount('clusters', 'Current', { [option]: 'Unknown' })
    widget()
    fireEvent.change(screen.getByLabelText('Ask OK AI Diagnostic'), { target: { value: cluster.name } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    noCurrency(document.querySelector('.diagnostic-widget')!)
    expect(document.querySelector('.diagnostic-messages')).toHaveTextContent('last observed outcome:')
  })
}

async function timers() { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'] }) }
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
function navigate() { act(() => { window.dispatchEvent(new HashChangeEvent('hashchange')) }) }

it('polls at 30 seconds while visible; failures immediately retain only Last observed; recovery restores currency', async () => {
  await timers()
  const { getSnapshot, snapshot } = await mount()
  widget(); fresh()
  getSnapshot.mockRejectedValueOnce(new Error('offline'))
  await advance(30_000)
  expect(getSnapshot).toHaveBeenCalledTimes(2)
  noCurrency()
  expect(screen.getByText(historyNote)).toBeVisible()
  expect(screen.queryByText(/Observation freshness is current/)).toBeNull()
  await advance(30_000)
  fresh()
  expect(getSnapshot).toHaveLastResolvedWith(snapshot)
})
it('60 second monotonic ceiling demotes even with all refetches hanging and wall clock moving backwards', async () => {
  await timers()
  const { getSnapshot } = await mount()
  widget(); fresh()
  getSnapshot.mockImplementation(() => new Promise<PlatformSnapshot>(() => {}))
  vi.spyOn(Date, 'now').mockReturnValue(0)
  await advance(59_999); fresh()
  await advance(1); noCurrency()
})
it('ceiling starts at initiation, including a slow successful fetch', async () => {
  await timers()
  const { getSnapshot, snapshot } = await mount()
  let resolve!: (snapshot: PlatformSnapshot) => void
  getSnapshot.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  navigate()
  getSnapshot.mockImplementation(() => new Promise<PlatformSnapshot>(() => {}))
  await advance(60_001)
  await act(async () => { resolve(snapshot) })
  noCurrency()
})
it('hash navigation and visibility return refresh; hidden tabs do not poll', async () => {
  await timers()
  const { getSnapshot } = await mount()
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  await advance(30_000)
  expect(getSnapshot).toHaveBeenCalledTimes(1)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  fireEvent(document, new Event('visibilitychange'))
  await act(async () => {})
  expect(getSnapshot).toHaveBeenCalledTimes(2)
  navigate(); await act(async () => {})
  expect(getSnapshot).toHaveBeenCalledTimes(3)
})
for (const late of ['success', 'failure'] as const) {
  it(`discards an older ${late} completion after a newer success`, async () => {
    const { getSnapshot, snapshot } = await mount()
    let resolve!: (snapshot: PlatformSnapshot) => void
    let reject!: (error: Error) => void
    getSnapshot.mockImplementationOnce(() => new Promise((done, fail) => { resolve = done; reject = fail }))
    navigate()
    navigate(); await act(async () => {})
    await act(async () => { if (late === 'success') resolve({ ...snapshot, freshness: 'Stale' }); else reject(new Error('older failure')) })
    fresh(document.querySelector('.snapshot')!)
  })
}
it('older success cannot overwrite a newer failed refresh', async () => {
  const { getSnapshot, snapshot } = await mount()
  let resolve!: (snapshot: PlatformSnapshot) => void
  getSnapshot.mockImplementationOnce(() => new Promise(done => { resolve = done })).mockRejectedValueOnce(new Error('newer failure'))
  navigate(); navigate(); await act(async () => {})
  await act(async () => { resolve(snapshot) })
  noCurrency()
})
it('detail cap only clears for Evidence in a snapshot requested after detail arrived', async () => {
  const { getSnapshot, snapshot, cluster } = await mount('clusters')
  let resolve!: (snapshot: PlatformSnapshot) => void
  getSnapshot.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  navigate()
  vi.spyOn(consoleData, 'getCluster').mockResolvedValue({ ...snapshot.clusters[0], freshness: 'Stale' })
  fireEvent.click(screen.getByRole('button', { name: `Open ${cluster.name}` }))
  await act(async () => {})
  await act(async () => { resolve(snapshot) })
  noCurrency(document.querySelector('.evidence-card')!)
  // Visibility fetch starts after the detail response and clears the Evidence cap.
  fireEvent(document, new Event('visibilitychange'))
  await waitFor(() => fresh(document.querySelector('.evidence-card')!))
})
it('failed refetch demotes an already-open drawer and clears widget history', async () => {
  const { getSnapshot } = await mount('drawer')
  widget(); fresh()
  getSnapshot.mockRejectedValueOnce(new Error('offline'))
  navigate(); await act(async () => {})
  noCurrency()
  expect(screen.getByText(historyNote)).toBeVisible()
})
it('Overview deduplicates affected clusters and placements by id', async () => {
  const { getSnapshot, snapshot } = await mount('overview', 'Stale', { mixed: true })
  const duplicated = { ...snapshot, clusters: [...snapshot.clusters, ...snapshot.clusters], claims: [...snapshot.claims, ...snapshot.claims] }
  getSnapshot.mockResolvedValueOnce(duplicated)
  navigate(); await act(async () => {})
  expect(document.querySelector('.snapshot')).toHaveTextContent('1 items stale, 1 unavailable')
})

for (const verdict of ['Stale', 'Unknown'] as const) {
  it(`Overview: own ${verdict} response suppresses the header and widget while cluster response stays fresh`, async () => {
    await mount('overview', 'Current', { overview: verdict })
    widget()
    noCurrency(document.querySelector('.snapshot')!)
    noCurrency(document.querySelector('.diagnostic-widget')!)
    fresh(document.querySelector('.cluster-card')!)
  })
}
for (const view of ['overview', 'clusters', 'detail', 'evidence', 'drawer']) {
  it(`${view}: an already-rendered observation ages at the browser ceiling`, async () => {
    await timers()
    const { getSnapshot } = await mount(view)
    widget(); fresh()
    getSnapshot.mockImplementation(() => new Promise<PlatformSnapshot>(() => {}))
    await advance(60_000)
    noCurrency()
    expect(document.querySelectorAll('main .status-ready')).toHaveLength(0)
  })
}
it('Unknown Detail cap survives a newer Stale snapshot; only later Current Evidence releases it permanently', async () => {
  const { getSnapshot, snapshot, cluster } = await mount('clusters')
  vi.spyOn(consoleData, 'getCluster').mockResolvedValue({ ...snapshot.clusters[0], freshness: 'Unknown' })
  fireEvent.click(screen.getByRole('button', { name: `Open ${cluster.name}` }))
  await act(async () => {})
  const staleEvidence = { ...snapshot, evidence: snapshot.evidence.map(item => ({ ...item, freshness: 'Stale' as const })) }
  getSnapshot.mockResolvedValueOnce(staleEvidence)
  fireEvent(document, new Event('visibilitychange')); await act(async () => {})
  expect(document.querySelector('.evidence-card')).toHaveTextContent('Observation unavailable')
  getSnapshot.mockResolvedValueOnce(snapshot)
  fireEvent(document, new Event('visibilitychange')); await act(async () => {})
  fresh(document.querySelector('.evidence-card')!)
  getSnapshot.mockResolvedValueOnce(staleEvidence)
  fireEvent(document, new Event('visibilitychange')); await act(async () => {})
  expect(document.querySelector('.evidence-card')).toHaveTextContent('Last observed')
  expect(document.querySelector('.evidence-card')).not.toHaveTextContent('Observation unavailable')
})

it('ceiling timeout demotes between poll ticks after a navigation refresh', async () => {
  await timers()
  const { getSnapshot } = await mount()
  await advance(1_000)
  navigate(); await act(async () => {})
  widget(); fresh()
  getSnapshot.mockImplementation(() => new Promise<PlatformSnapshot>(() => {}))
  await advance(59_999); fresh()
  await advance(1); noCurrency()
})
