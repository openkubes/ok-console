import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import sourceUnavailable from '../contracts/presentation/v0alpha1/examples/error-source-unavailable.json'

vi.mock('./data/consoleData', async importOriginal => ({ ...await importOriginal<typeof import('./data/consoleData')>(), consoleDataMode: 'bff' }))
const auth: ConsoleAuthClient = {
  mode: 'oidc', restoreSession: vi.fn(async () => ({ method: 'oidc' as const, identity: 'Freshness Viewer', source: 'test', assurance: 'Federated', expiresIn: '1h' })),
  startOidc: vi.fn(), authenticateLocal: vi.fn(), logout: vi.fn(),
}
beforeEach(() => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'] }) })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
const historyNote = /Earlier answer, based on data observed at/
function textOf(scope: ParentNode) {
  const walker = document.createTreeWalker(scope as Node, NodeFilter.SHOW_TEXT)
  const parts: string[] = []
  while (walker.nextNode()) parts.push(walker.currentNode.textContent ?? '')
  return parts.join(' ')
}
function noCurrency(scope: ParentNode = document.body) {
  // The required history note explicitly denies currency; it is the sole permitted occurrence.
  expect(textOf(scope)).not.toMatch(/\bcurrent(ly)?\b/i)
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
  readiness?: 'Unknown'; outcome?: 'Unknown'; missing?: boolean; foreign?: boolean; immutable?: boolean; fixture?: boolean; empty?: boolean; mixed?: boolean; failedEvidence?: boolean; missingEvidence?: boolean; sourceStale?: boolean
} = {}) {
  window.history.replaceState(null, '', `#/${view === 'detail' ? 'clusters' : view === 'drawer' ? 'evidence' : view}`)
  const e = structuredClone(evidence)
  e.meta.freshness = options.evidence ?? verdict
  e.data.classification = options.immutable ? 'Immutable' : 'Current'
  if (options.immutable) e.data.observedAt = new Date(Date.parse(e.meta.observedAt) - 15 * 60 * 60_000).toISOString()
  e.data.outcome = options.outcome ?? 'Ready'
  const c = structuredClone(clusters)
  c.meta.freshness = options.clusters ?? verdict
  c.data.items = [c.data.items[0]]
  c.data.items[0].readiness = options.readiness ?? 'Ready'
  c.data.items[0].evidenceId = e.data.id
  e.data.clusterId = options.foreign ? 'cluster-foreign' : c.data.items[0].id
  const o = structuredClone(overview)
  o.meta.freshness = options.overview ?? verdict
  if (options.sourceStale) Object.assign(o.meta, { warnings: [{ code: 'PARTIAL_DATA', message: 'Some optional source data is unavailable.' }, { code: 'SOURCE_STALE', message: 'A producer item is older than the freshness window.' }] })
  o.data.recentPlacements = []
  const d = structuredClone(detail)
  d.meta.freshness = options.detail ?? verdict
  Object.assign(d.data, c.data.items[0])
  const adapter = new BffConsoleAdapter('/api/console/v0', vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url)
    if (options.missingEvidence && path.includes('/evidence/')) return new Response(JSON.stringify({ ...sourceUnavailable, error: { code: 'NOT_FOUND', message: 'Evidence reference is unavailable.', retryable: false } }), { status: 404 })
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
  screen.getByRole('heading', { name: view === 'overview' ? 'Hello Freshness' : view === 'agents' ? 'AI Agents' : view === 'clusters' || view === 'detail' ? 'Clusters' : view === 'workloads' ? 'Workloads' : 'Evidence & Audit' })
  if (view === 'detail') {
    fireEvent.click(screen.getByRole('button', { name: `Open ${c.data.items[0].name}` }))
    await act(async () => {})
    screen.getByText(d.data.lifecycle[0].label)
  }
  if (view === 'drawer') fireEvent.click(screen.getByRole('button', { name: new RegExp(e.data.title) }))
  return { ...result, snapshot, getSnapshot, cluster: c.data.items[0] }
}

describe('whole-document framing, including DiagnosticWidget', { timeout: 30_000 }, () => {
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
    for (const option of ['missing', 'foreign', 'readiness', 'outcome', 'failedEvidence', 'missingEvidence'] as const) {
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
    noCurrency(document.querySelector(view === 'overview' ? '.cluster-card' : 'main')!)
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
  it(`clusters: ${verdict} list aggregate retains Current own Evidence and banner`, async () => {
    await mount('clusters', 'Current', { clusters: verdict })
    fresh(document.querySelector('.table-row')!)
    expect(document.querySelector('.table-row .status')).toHaveTextContent(/^Ready$/)
    expect(document.querySelector('.data-warning strong')).toHaveTextContent(verdict === 'Stale' ? 'Some observations are stale' : 'Observation unavailable - readiness Unknown')
    widget(); noCurrency(document.querySelector('.diagnostic-widget')!)
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
async function navigate(event = 'hashchange') {
  // Automatic navigation refreshes are due only after the last successful request.
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  await advance(30_001)
  visibility.mockReturnValue('visible')
  act(() => { (event === 'visibilitychange' ? document : window).dispatchEvent(new Event(event)) })
  await act(async () => {})
}

it('polls at 30 seconds while visible; failures immediately retain only Last observed; recovery restores currency', async () => {
  await timers()
  const { getSnapshot, snapshot } = await mount()
  widget(); fresh()
  getSnapshot.mockRejectedValueOnce(new Error('offline'))
  await advance(30_000)
  expect(getSnapshot).toHaveBeenCalledTimes(2)
  noCurrency()
  expect(screen.getAllByText(historyNote)[0]).toBeVisible()
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
  await navigate()
  getSnapshot.mockImplementation(() => new Promise<PlatformSnapshot>(() => {}))
  await advance(60_001)
  await act(async () => { resolve(snapshot) })
  noCurrency()
})
it('hash navigation and visibility return refresh; hidden tabs do not poll', async () => {
  await timers()
  const { getSnapshot } = await mount()
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  await advance(30_001)
  expect(getSnapshot).toHaveBeenCalledTimes(1)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  fireEvent(document, new Event('visibilitychange'))
  await act(async () => {})
  expect(getSnapshot).toHaveBeenCalledTimes(2)
  await navigate(); await act(async () => {})
  expect(getSnapshot).toHaveBeenCalledTimes(3)
})
for (const late of ['success', 'failure'] as const) {
  it(`automatic events cannot overlap an in-flight ${late} completion`, async () => {
    const { getSnapshot, snapshot } = await mount()
    let resolve!: (snapshot: PlatformSnapshot) => void
    let reject!: (error: Error) => void
    getSnapshot.mockImplementationOnce(() => new Promise((done, fail) => { resolve = done; reject = fail }))
    await navigate()
    await navigate(); await act(async () => {})
    await act(async () => { if (late === 'success') resolve({ ...snapshot, freshness: 'Stale' }); else reject(new Error('older failure')) })
    await act(async () => {})
    expect(getSnapshot).toHaveBeenCalledTimes(2)
    noCurrency(document.querySelector('.snapshot')!)
  })
}
it('a later failed refresh demotes an earlier successful completion', async () => {
  const { getSnapshot, snapshot } = await mount()
  let resolve!: (snapshot: PlatformSnapshot) => void
  getSnapshot.mockImplementationOnce(() => new Promise(done => { resolve = done })).mockRejectedValueOnce(new Error('newer failure'))
  await navigate()
  await act(async () => { resolve(snapshot) })
  await navigate()
  noCurrency()
})
it('detail cap only clears for Evidence in a snapshot requested after detail arrived', async () => {
  const { getSnapshot, snapshot, cluster } = await mount('clusters')
  let resolve!: (snapshot: PlatformSnapshot) => void
  getSnapshot.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  await navigate()
  vi.spyOn(consoleData, 'getCluster').mockResolvedValue({ ...snapshot.clusters[0], freshness: 'Stale' })
  fireEvent.click(screen.getByRole('button', { name: `Open ${cluster.name}` }))
  await act(async () => {})
  await act(async () => { resolve(snapshot) })
  noCurrency(document.querySelector('.evidence-card')!)
  vi.mocked(consoleData.getCluster).mockResolvedValue({ ...snapshot.clusters[0], freshness: 'Current' })
  // A fresh snapshot and re-requested detail recover together.
  await navigate('visibilitychange')
  fresh(document.querySelector('.evidence-card')!)
})
it('failed refetch demotes an already-open drawer and retains widget answers as history', async () => {
  const { getSnapshot } = await mount('drawer')
  widget(); fresh()
  getSnapshot.mockRejectedValueOnce(new Error('offline'))
  await navigate(); await act(async () => {})
  noCurrency()
  expect(screen.getAllByText(historyNote)[0]).toBeVisible()
})
it('Overview deduplicates affected clusters and placements by id', async () => {
  const { getSnapshot, snapshot } = await mount('overview', 'Stale', { mixed: true })
  const duplicated = { ...snapshot, clusters: [...snapshot.clusters, ...snapshot.clusters], claims: [...snapshot.claims, ...snapshot.claims] }
  getSnapshot.mockResolvedValueOnce(duplicated)
  await navigate(); await act(async () => {})
  expect(document.querySelector('.snapshot')).toHaveTextContent('1 item stale, 1 unavailable')
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
  await navigate('visibilitychange')
  expect(document.querySelector('.evidence-card')).toHaveTextContent('Observation unavailable')
  vi.mocked(consoleData.getCluster).mockResolvedValue({ ...snapshot.clusters[0], freshness: 'Current' })
  getSnapshot.mockResolvedValueOnce(snapshot)
  await navigate('visibilitychange')
  fresh(document.querySelector('.evidence-card')!)
  getSnapshot.mockResolvedValueOnce(staleEvidence)
  await navigate('visibilitychange')
  expect(document.querySelector('.evidence-card')).toHaveTextContent('Last observed')
  expect(document.querySelector('.evidence-card')).not.toHaveTextContent('Observation unavailable')
})

it('ceiling timeout demotes between poll ticks after a navigation refresh', async () => {
  await timers()
  const { getSnapshot } = await mount()
  await navigate(); await act(async () => {})
  widget(); fresh()
  getSnapshot.mockImplementation(() => new Promise<PlatformSnapshot>(() => {}))
  await advance(59_999); fresh()
  await advance(1); noCurrency()
})

it('R3 detail refresh follows each snapshot generation, changes Ready to Failed, and recovers without reopening', async () => {
  await timers()
  const { snapshot, getSnapshot } = await mount('detail')
  const failed = { ...snapshot, clusters: snapshot.clusters.map(c => ({ ...c, readiness: 'Failed' as const })), evidence: snapshot.evidence.map(e => ({ ...e, outcome: 'Failed' as const })) }
  const failedDetail = { ...snapshot.clusters[0], readiness: 'Failed' as const, lifecycle: [{ label: 'Producer lifecycle', state: 'Failed' as const, detail: 'Hosting workload Failed' }] }
  getSnapshot.mockResolvedValue(failed)
  vi.mocked(consoleData.getCluster).mockResolvedValue(failedDetail)
  await advance(30_000)
  expect(document.querySelector('.title-actions .status')).toHaveTextContent('Failed')
  expect(document.querySelector('.lifecycle .status')).toHaveTextContent('Failed')
  expect(document.querySelector('.evidence-card')).toHaveTextContent('Failed')
  fresh(document.querySelector('main')!)
  vi.mocked(consoleData.getCluster).mockRejectedValueOnce(new Error('detail offline'))
  await advance(30_000)
  noCurrency(document.querySelector('main')!)
  expect(document.querySelector('.evidence-card')).toHaveTextContent('Last observed: Failed')
  getSnapshot.mockResolvedValue(snapshot)
  vi.mocked(consoleData.getCluster).mockResolvedValue({ ...snapshot.clusters[0], lifecycle: [{ label: 'Recovered lifecycle', state: 'Ready', detail: 'Recovered' }] })
  await advance(30_000)
  fresh(document.querySelector('main')!)
  expect(document.querySelector('.title-actions .status')).toHaveTextContent('Ready')
})
it.each(['unchanged', 'Failed'])('R3 widget retains %s earlier answers without currency across fresh generations', async state => {
  await timers()
  const { snapshot, getSnapshot } = await mount()
  widget()
  fireEvent.click(screen.getByRole('button', { name: 'ok-shared status' }))
  const old = [...document.querySelectorAll('.diagnostic-message.assistant')].slice(1)
  getSnapshot.mockResolvedValue({ ...snapshot, clusters: snapshot.clusters.map(c => ({ ...c, readiness: state === 'Failed' ? 'Failed' : c.readiness })) })
  await advance(30_000)
  for (const answer of old) {
    expect(answer).toHaveTextContent('Earlier answer, based on data observed at')
    noCurrency(answer)
  }
  fireEvent.click(screen.getByRole('button', { name: 'Platform status' }))
  expect(document.querySelector('.diagnostic-message.assistant:last-child')).toHaveTextContent(/\bcurrent\b/i)
})
it('R3 polling stops at four minutes idle, focus does not restart it, and input resumes immediately', async () => {
  await timers()
  const { getSnapshot } = await mount()
  await advance(240_000)
  const stopped = getSnapshot.mock.calls.length
  await advance(120_000)
  expect(getSnapshot).toHaveBeenCalledTimes(stopped)
  fireEvent(window, new Event('focus')); await act(async () => {})
  expect(getSnapshot).toHaveBeenCalledTimes(stopped)
  await advance(60_000)
  expect(getSnapshot).toHaveBeenCalledTimes(stopped)
  fireEvent.keyDown(window, { key: 'Shift' }); await act(async () => {})
  expect(getSnapshot).toHaveBeenCalledTimes(stopped + 1)
  await advance(30_000)
  expect(getSnapshot).toHaveBeenCalledTimes(stopped + 2)
})
it('R2 automatic trigger bursts never queue a follow-up while a refresh is in flight', async () => {
  const { getSnapshot, snapshot } = await mount()
  let resolve!: (value: PlatformSnapshot) => void
  getSnapshot.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  await navigate(); await navigate(); await navigate()
  expect(getSnapshot).toHaveBeenCalledTimes(2)
  await act(async () => { resolve(snapshot) })
  expect(getSnapshot).toHaveBeenCalledTimes(2)
})
it('R3 Retry clears the error, renders loading, and double-click cannot overlap', async () => {
  window.history.replaceState(null, '', '#/overview')
  let resolve!: (value: PlatformSnapshot) => void
  const getSnapshot = vi.spyOn(consoleData, 'getSnapshot').mockRejectedValueOnce(new Error('offline')).mockImplementation(() => new Promise(done => { resolve = done }))
  render(<App auth={auth}/>); await act(async () => {})
  const retry = screen.getByRole('button', { name: 'Retry safely' })
  fireEvent.click(retry); fireEvent.click(retry)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByText('Loading contract-aligned platform view…')).toBeVisible()
  expect(getSnapshot).toHaveBeenCalledTimes(2)
  await act(async () => { resolve({ ...structuredClone((await import('./data/fixtures')).platformFixture), source: 'bff' }) })
})
it('R3 session-ended response clears data and stops polling', async () => {
  await timers()
  const { getSnapshot } = await mount('detail')
  getSnapshot.mockRejectedValueOnce(new (await import('./data/bffAdapter')).ConsoleDataError('ended', 'UNAUTHENTICATED', false))
  await advance(30_000)
  expect(screen.getByText('Your session ended. Sign in again.')).toBeVisible()
  expect(screen.queryByText('Lifecycle posture')).toBeNull()
  const calls = getSnapshot.mock.calls.length
  await advance(120_000)
  expect(getSnapshot).toHaveBeenCalledTimes(calls)
})
it('R3 ceiling suppresses every numeric metric and note', async () => {
  await timers()
  const { getSnapshot } = await mount()
  getSnapshot.mockImplementation(() => new Promise(() => {}))
  await advance(60_000)
  for (const card of document.querySelectorAll('.metric')) {
    expect(card.querySelector('strong')).toHaveTextContent(/^Unavailable$/)
    expect(card.querySelector('small')).toHaveTextContent(/^Unavailable$/)
  }
})
it.each(['focus', 'online', 'visibilitychange'])('R3 %s demotes on a wall-clock gap even while monotonic time is frozen', async event => {
  const { getSnapshot } = await mount()
  getSnapshot.mockImplementation(() => new Promise(() => {}))
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3600_000)
  fireEvent(event === 'visibilitychange' ? document : window, new Event(event))
  noCurrency(document.querySelector('.snapshot')!)
  vi.mocked(Date.now).mockReturnValue(0)
  fireEvent(window, new Event('focus'))
  noCurrency(document.querySelector('.snapshot')!)
})
it('R3 mutable Overview remains Current with immutable receipts present', async () => {
  const { snapshot, getSnapshot } = await mount()
  getSnapshot.mockResolvedValueOnce({ ...snapshot, evidence: [...snapshot.evidence, { ...snapshot.evidence[0], id: 'receipt', immutable: true, freshness: 'Stale' }] })
  await navigate(); await act(async () => {})
  fresh(document.querySelector('.snapshot')!)
  expect(screen.getByText(/Immutable Evidence receipts are retained separately/)).toBeVisible()
})
it('R3 detail has its own ceiling even when a newer snapshot has succeeded', async () => {
  await timers()
  await mount('detail')
  vi.mocked(consoleData.getCluster).mockImplementation(() => new Promise(() => {}))
  await advance(60_000)
  noCurrency(document.querySelector('main')!)
  expect(document.querySelector('.title-actions .status')).toHaveTextContent('Unknown')
  expect(document.querySelector('.evidence-card')).toHaveTextContent('Last observed: Ready')
})
it('R3 new Shell READINESS uses the effective detail; printed lines remain a transcript', async () => {
  await timers()
  const { snapshot, getSnapshot } = await mount('detail')
  fireEvent.click(screen.getByRole('button', { name: 'Open Shell' }))
  const input = screen.getByRole('textbox', { name: 'Command or question' })
  const run = () => {
    fireEvent.change(input, { target: { value: 'evidence' } })
    fireEvent.submit(input.closest('form')!)
  }
  run()
  const original = document.querySelector('.terminal-output')?.textContent
  const failed = { ...snapshot, clusters: snapshot.clusters.map(c => ({ ...c, readiness: 'Failed' as const })), evidence: snapshot.evidence.map(e => ({ ...e, outcome: 'Failed' as const })) }
  getSnapshot.mockResolvedValue(failed)
  vi.mocked(consoleData.getCluster).mockResolvedValue(failed.clusters[0])
  await advance(30_000)
  run()
  expect(document.querySelector('.terminal-output')).toHaveTextContent('READINESS Failed (Current observation)')
  expect(original).toContain('Current observation')
  expect(document.querySelector('.terminal-output')).toHaveTextContent('Earlier output, based on data observed at')
  expect(document.querySelector('.terminal-output')).toHaveTextContent('READINESS Ready (last observation)')
})
it.each([
  { readiness: 'Unknown' as const },
  { clusters: 'Stale' as const },
  {},
])('R4 immutable basis preserves item verdict in header, metrics and widget: %j', async options => {
  await mount('overview', 'Current', { immutable: true, ...options })
  widget()
  noCurrency(document.querySelector('.snapshot')!)
  noCurrency(document.querySelector('.diagnostic-widget')!)
  expect(document.querySelector('.metrics-grid')).not.toHaveTextContent(/\d/)
  expect(document.querySelector('.snapshot')).toHaveTextContent(options.readiness ? '1 unavailable' : '1 item historical')
}, 30_000)
it('R4 dry-run 401 ends the session and stops polling', async () => {
  await timers()
  window.history.replaceState(null, '', '#/create')
  const { getSnapshot } = await mount()
  act(() => { window.location.hash = '#/create'; window.dispatchEvent(new HashChangeEvent('hashchange')) })
  await act(async () => {})
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })))
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Generate contract' }))
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: /dry.run/i }))
    await act(async () => {})
    expect(screen.getByText('Your session ended. Sign in again.')).toBeVisible()
    const count = getSnapshot.mock.calls.length
    await advance(120_000)
    expect(getSnapshot).toHaveBeenCalledTimes(count)
  } finally { vi.unstubAllGlobals() }
}, 30_000)
it('R4 Shell qualifies explain and conditions; older currency becomes history at ceiling', async () => {
  await timers()
  const { getSnapshot } = await mount('detail')
  fireEvent.click(screen.getByRole('button', { name: 'Open Shell' }))
  fireEvent.click(screen.getByRole('button', { name: 'ok evidence explain' }))
  expect(document.querySelector('.terminal-output')).toHaveTextContent('readiness Ready (Current observation)')
  getSnapshot.mockImplementation(() => new Promise(() => {}))
  vi.mocked(consoleData.getCluster).mockImplementation(() => new Promise(() => {}))
  await advance(60_000)
  noCurrency(document.querySelector('.terminal-output')!)
  expect(document.querySelector('.terminal-output')).toHaveTextContent('Earlier output')
  fireEvent.click(screen.getByRole('button', { name: 'ok evidence explain' }))
  fireEvent.click(screen.getByRole('button', { name: 'kubectl get clusterconditions -o wide' }))
  expect(document.querySelector('.terminal-output')).toHaveTextContent('readiness Unknown (last observed Ready)')
  expect(document.querySelector('.terminal-output')).toHaveTextContent('lifecycle snapshot (Unknown (last observed Ready))')
}, 30_000)
it('R4 a new widget answer on unavailable data is timestamped without calling it earlier', async () => {
  await mount('overview', 'Unknown')
  widget()
  const answer = document.querySelector('.diagnostic-message.assistant:last-child')!
  expect(answer).toHaveTextContent('Answer based on data observed at')
  expect(answer).not.toHaveTextContent('Earlier answer')
  expect(answer).not.toHaveTextContent('last observed observation')
}, 30_000)

it('U5 item-only SOURCE_STALE response explains stale observations in the banner', async () => {
  await mount('overview', 'Current', { overview: 'Stale', clusters: 'Stale', sourceStale: true })
  const warning = document.querySelector('.data-warning')!
  expect(warning).toHaveTextContent('Some observations are stale')
  expect(warning).toHaveTextContent('Some optional source data is unavailable.')
  expect(warning).toHaveTextContent('A producer item is older than the freshness window.')
  noCurrency(document.querySelector('.snapshot')!)
})

it('integration non-observation chips never reuse the live observation dot', async () => {
  await mount('overview', 'Current', { fixture: true })
  expect(document.querySelector('.environment .live-dot')).toBeNull()
  act(() => { window.location.hash = '#/register'; window.dispatchEvent(new HashChangeEvent('hashchange')) })
  await act(async () => {})
  fireEvent.change(screen.getByRole('combobox', { name: 'External management engine' }), { target: { value: 'NVIDIA Kubernetes Engine (NVKE)' } })
  fireEvent.click(screen.getByRole('button', { name: 'Run safe discovery' }))
  expect(screen.getByText('Simulated fixture')).toBeVisible()
  expect(document.querySelector('.fixture-label .live-dot')).toBeNull()
  expect(screen.getByText('NVKE-managed Kubernetes cluster · simulated')).toBeVisible()
  expect(screen.getByText('Unverified demo metadata')).toBeVisible()
})

it.each(['Stale', 'Unknown'] as const)('R2 B1 %s list banner retains Current Ready row and filter chips', async freshness => {
  await mount('clusters', 'Current', { clusters: freshness })
  fresh(document.querySelector('.table-row')!)
  expect(document.querySelector('.table-row .status')).toHaveTextContent(/^Ready$/)
  expect(document.querySelector('.data-warning strong')).toHaveTextContent(freshness === 'Stale' ? 'Some observations are stale' : 'Observation unavailable - readiness Unknown')
  expect(screen.getByRole('button', { name: 'Ready · 1' })).toBeVisible()
  expect(screen.getByRole('button', { name: 'Attention · 0' })).toBeVisible()
})
it('R2 B1 current Ready row is counted by the chip', async () => {
  await mount('clusters')
  expect(document.querySelector('.table-row .status')).toHaveTextContent(/^Ready$/)
  expect(screen.getByRole('button', { name: 'Ready · 1' })).toBeVisible()
})

it.each(['Current', 'Stale', 'Unknown', 'missing', 'foreign', 'collision', 'immutable', 'Unknown outcome', 'Stale Unknown placement', 'Stale snapshot', 'Unknown snapshot'] as const)('R2 B2 replicas use only the placement own presented Evidence: %s', async basis => {
  const { snapshot, getSnapshot } = await mount('workloads')
  const cluster = snapshot.clusters[0]
  const own = { ...snapshot.evidence[0], id: 'placement-evidence', cluster: cluster.id, revision: 'deployment:v2;replicas:2/2', freshness: basis === 'Stale Unknown placement' ? 'Stale' as const : basis === 'Stale' || basis === 'Unknown' ? basis : 'Current' as const, outcome: basis === 'Unknown outcome' ? 'Unknown' as const : 'Ready' as const, immutable: basis === 'immutable' }
  const foreign = { ...own, cluster: 'foreign-cluster', revision: 'deployment:v9;replicas:9/9', freshness: 'Current' as const }
  const next: PlatformSnapshot = { ...snapshot, freshness: basis === 'Stale snapshot' ? 'Stale' : basis === 'Unknown snapshot' ? 'Unknown' : snapshot.freshness, claims: [{ id: 'deployment', name: 'Replica test', kind: 'Observed Deployment', owner: 'test', intent: '', targetCluster: cluster.name, readiness: basis === 'Stale Unknown placement' ? 'Unknown' : 'Ready', requiredCapabilities: [], decision: '', evidenceId: own.id }], evidence: basis === 'missing' ? [] : basis === 'foreign' ? [foreign] : basis === 'collision' ? [foreign, own] : [own] }
  getSnapshot.mockResolvedValue(next)
  await navigate()
  const line = document.querySelector('.claim-card .decision')!
  if (basis === 'Current' || basis === 'collision') {
    expect(line).toHaveTextContent('Available / desired replicas2/2')
  } else if (basis === 'Stale' || basis === 'Stale Unknown placement' || basis === 'Stale snapshot') {
    expect(line).toHaveTextContent('Last observed2/2')
    expect(line).not.toHaveTextContent('Available / desired replicas')
  } else {
    expect(line).toHaveTextContent('Observation unavailable - readiness Unknown')
    expect(line.querySelector('strong')).toHaveTextContent(/^Unknown$/)
    expect(line).not.toHaveTextContent(/2\/2|9\/9|Available \/ desired replicas/)
  }
  expect(line).not.toHaveTextContent('9/9')
})

it('R2 RT1 new shell commands use refreshed lifecycle and revision; earlier output remains historical', async () => {
  const { snapshot, getSnapshot } = await mount('detail')
  fireEvent.click(screen.getByRole('button', { name: 'Open Shell' }))
  const input = screen.getByRole('textbox', { name: 'Command or question' })
  const run = (value: string) => {
    fireEvent.change(input, { target: { value } })
    fireEvent.submit(input.closest('form')!)
  }
  run('evidence')
  run('kubectl get clusterconditions -o wide')
  const previous = [...document.querySelectorAll('.terminal-entry.terminal-output, .terminal-entry.terminal-ai')]
  const cluster = { ...snapshot.clusters[0], readiness: 'Failed' as const, revision: 'producer-revision-r2', lifecycle: [{ label: 'Nodes', state: 'Failed' as const, detail: 'New producer node failure' }] }
  getSnapshot.mockResolvedValue({ ...snapshot, clusters: [cluster], evidence: snapshot.evidence.map(e => ({ ...e, outcome: 'Failed' as const })) })
  vi.mocked(consoleData.getCluster).mockResolvedValue(cluster)
  await advance(30_000)
  run('evidence')
  expect(document.querySelector('.terminal-entry:last-child')).toHaveTextContent('REVISION producer-revision-r2')
  expect(document.querySelector('.terminal-entry:last-child')).toHaveTextContent('READINESS Failed (Current observation)')
  run('kubectl get clusterconditions -o wide')
  expect(document.querySelector('.terminal-entry:last-child')).toHaveTextContent(/Nodes\s+Failed\s+New producer node failure/)
  run('why')
  expect(document.querySelector('.terminal-ai')).toHaveTextContent('Nodes: Failed — New producer node failure')
  expect(previous.length).toBeGreaterThan(0)
  for (const entry of previous) {
    expect(entry).toHaveTextContent('Earlier output, based on data observed at')
    noCurrency(entry)
    expect(entry).not.toHaveTextContent('producer-revision-r2')
  }
})

it('R2 S2 failed refresh retains aged data and shows a bounded reason, correlation id and working retry', async () => {
  const { getSnapshot } = await mount()
  const { ConsoleDataError } = await import('./data/bffAdapter')
  getSnapshot.mockRejectedValueOnce(new ConsoleDataError('Producer refresh unavailable. ' + 'x'.repeat(500), 'SOURCE_UNAVAILABLE', true, 'r2-correlation'))
  await advance(30_000)
  const alert = screen.getByRole('alert')
  expect(alert).toHaveTextContent('Observation refresh failed')
  expect(alert).toHaveTextContent('Producer refresh unavailable.')
  expect(alert).toHaveTextContent('Correlation ID r2-correlation')
  expect(alert.textContent!.length).toBeLessThan(400)
  expect(screen.getByRole('heading', { name: 'Hello Freshness' })).toBeVisible()
  noCurrency(document.querySelector('.snapshot')!)
  fireEvent.click(screen.getByRole('button', { name: 'Retry safely' }))
  await act(async () => {})
  expect(getSnapshot).toHaveBeenCalledTimes(3)
  expect(screen.queryByRole('alert')).toBeNull()
  fresh(document.querySelector('.snapshot')!)
})

it('R2 N1 fixture Overview header has one Fixture snapshot label', async () => {
  await mount('overview', 'Current', { fixture: true })
  expect(document.querySelector('.snapshot')!.textContent!.match(/Fixture snapshot/g)).toHaveLength(1)
})
