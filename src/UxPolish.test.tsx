import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import App from './App'
import DiagnosticWidget from './DiagnosticWidget'
import { consoleData } from './data/consoleData'
import { platformFixture } from './data/fixtures'
import type { ConsoleAuthClient } from './auth/authClient'

const auth: ConsoleAuthClient = {
  mode: 'oidc', restoreSession: async () => ({ method: 'oidc', identity: 'UX Viewer', source: 'test', assurance: 'Federated', expiresIn: '1h' }),
  startOidc: vi.fn(), authenticateLocal: vi.fn(), logout: vi.fn(),
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function mount(page = 'overview', source: 'fixture' | 'bff' = 'fixture', current = false, freshness?: 'Current' | 'Stale' | 'Unknown', immutable = false) {
  window.history.replaceState(null, '', `#/${page}`)
  const data = structuredClone(platformFixture)
  data.source = source
  if (freshness) data.freshness = freshness
  if (source === 'bff') data.clusters.forEach(cluster => cluster.lifecycle.forEach(step => { step.state = 'Ready' }))
  if (current) {
    data.freshness = 'Current'; data.clusterListFreshness = 'Current'; data.claims = []
    data.clusters.forEach(c => { c.freshness = 'Current'; c.readiness = 'Ready' })
    data.evidence.forEach(e => { e.freshness = 'Current'; e.outcome = 'Ready'; e.immutable = false })
  }
  if (immutable) data.evidence[0].immutable = true
  data.warnings = page === 'overview' ? ['Observed-state values were withheld by grammar checks or the Console redaction boundary.', '1 cluster detail could not be loaded (edge-07).'] : []
  vi.spyOn(consoleData, 'getSnapshot').mockResolvedValue(data)
  vi.spyOn(consoleData, 'getCluster').mockImplementation(async id => data.clusters.find(c => c.id === id)!)
  render(<App auth={auth}/> )
  await screen.findByRole('button', { name: 'Sign out of OpenKubes Console' })
  return data
}
it('G1 lifecycle Unknown has no green step or check', async () => {
  const data = await mount('clusters', 'bff')
  fireEvent.click(screen.getByRole('button', { name: `Open ${data.clusters[0].name}` }))
  await screen.findByRole('heading', { name: 'Lifecycle posture' })
  const rows = document.querySelectorAll('.lifecycle-step')
  expect(rows.length).toBeGreaterThan(0)
  rows.forEach(row => {
    expect(row.querySelector('.status')).toHaveTextContent('Unknown')
    expect(row.querySelector('.step-dot')).not.toHaveClass('ready')
    expect(row.querySelector('.step-dot')).not.toHaveClass('fit-yes')
    expect(row.querySelector('.step-dot')).not.toHaveTextContent('✓')
  })
  fireEvent.click(screen.getByRole('tab', { name: 'Lifecycle' }))
  document.querySelectorAll('.timeline-marker').forEach(marker => expect(marker).not.toHaveClass('ready'))
})
it.each(['overview', 'clusters', 'workloads'])('G2 %s evidence links use titles with revision tooltips', async page => {
  const data = await mount(page)
  const links = document.querySelectorAll<HTMLButtonElement>('.evidence-link')
  expect(links.length).toBeGreaterThan(0)
  links.forEach(link => {
    const item = data.evidence.find(e => link.querySelector('.evidence-link-label')?.textContent === e.title)
    expect(item).toBeDefined()
    expect(link.title).toContain(item!.revision)
    expect(link.querySelector('.evidence-link-label')).toHaveTextContent(item!.title)
  })
})
it('G3 suppressed tiles contain one Unavailable each', async () => {
  await mount()
  const tiles = document.querySelectorAll('.metrics-grid .metric')
  expect(tiles).toHaveLength(4)
  tiles.forEach(tile => expect(within(tile as HTMLElement).getAllByText('Unavailable', { exact: true })).toHaveLength(1))
})
it('G5 banners explain an operator cause without internal terms', async () => {
  await mount()
  const banner = document.querySelector('.data-warning')!
  expect(banner).not.toHaveTextContent(/grammar|redaction boundary/i)
  expect(banner).toHaveTextContent('Some observation values could not be safely displayed.')
  expect(banner).toHaveTextContent('1 cluster detail could not be loaded (edge-07).')
  fireEvent.click(screen.getByRole('button', { name: /Ask OK AI/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Platform status' }))
  expect(document.querySelector('.diagnostic-message.assistant:last-child')).not.toHaveTextContent(/grammar checks|redaction boundary/i)
  expect(document.querySelector('.diagnostic-message.assistant:last-child')).toHaveTextContent('edge-07')
})
it.each(['overview', 'clusters', 'workloads', 'capabilities', 'agents', 'evidence'])('G6 %s footers have no ticket keys', async page => {
  await mount(page)
  expect(document.querySelector('.product-footer')).not.toHaveTextContent(/OK-\d+/)
})
const stamp = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/
it('G6 snapshot timestamp carries date, time and UTC', async () => {
  await mount()
  expect(document.querySelector('.snapshot')).toHaveTextContent(stamp)
})
it('G6 diagnostic timestamp carries date, time and UTC', async () => {
  await mount()
  fireEvent.click(screen.getByRole('button', { name: /Ask OK AI/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Platform status' }))
  expect(document.querySelector('.diagnostic-message.assistant small')).toHaveTextContent(stamp)
})
it('G6 receipt timestamp carries date, time and UTC', async () => {
  await mount()
  fireEvent.click(document.querySelector<HTMLButtonElement>('.evidence-link')!)
  expect(screen.getByRole('dialog').querySelector('.evidence-details')).toHaveTextContent(stamp)
})
it.each(['capabilities', 'workloads', 'agents'])('D1 %s fixture banner is present', async page => {
  await mount(page)
  expect(document.querySelector('.data-warning strong')).toHaveTextContent('Observation unavailable - readiness Unknown')
})
it('D1 capabilities suppress recorded coverage counts and bar', async () => {
  await mount('capabilities')
  const grid = document.querySelector('.capability-grid')!
  expect(grid).not.toHaveTextContent(/\d+% profile coverage|\d+ clusters/)
  expect(grid.querySelector('.coverage')).toBeNull()
  expect(grid).toHaveTextContent('Coverage unavailable')
})
it('D1 agents suppress deployment figures', async () => {
  await mount('agents')
  expect(document.querySelector('.agent-metrics .metric:last-child > strong')).toHaveTextContent('Unavailable')
  expect(document.querySelector('.agent-grid')).not.toHaveTextContent(/\d+ deployments?/)
  expect(document.querySelector('.agent-deployments')?.previousElementSibling).toHaveTextContent('Recorded deployments')
  expect(document.querySelector('.agent-deployments')?.previousElementSibling?.querySelector('.count-badge')).toBeNull()
})
it('D2 heading does not assert readiness', async () => {
  await mount()
  expect(screen.getByRole('heading', { name: 'What informs platform readiness?' })).toBeVisible()
})

it.each(['Stale', 'Unknown', 'Current'] as const)('D2 %s banner title is consistent across page scopes', async verdict => {
  const data = structuredClone(platformFixture)
  data.source = 'bff'
  data.freshness = verdict
  data.clusterListFreshness = verdict
  data.clusters.forEach(c => { c.freshness = verdict; c.readiness = 'Ready' })
  data.claims = []
  data.evidence = data.evidence.map(e => ({ ...e, freshness: verdict, outcome: 'Ready', immutable: false }))
  data.warnings = ['Observed-state values were withheld by grammar checks or the Console redaction boundary.']
  vi.spyOn(consoleData, 'getSnapshot').mockResolvedValue(data)
  window.history.replaceState(null, '', '#/overview')
  render(<App auth={auth}/>)
  await screen.findByRole('button', { name: 'Sign out of OpenKubes Console' })
  const title = document.querySelector('.data-warning strong')!.textContent
  for (const page of ['clusters', 'workloads', 'capabilities', 'agents', 'evidence']) {
    fireEvent.click(document.querySelector<HTMLAnchorElement>(`nav a[href="#/${page}"]`)!)
    await screen.findByRole('heading', { name: page === 'agents' ? 'AI Agents' : page === 'evidence' ? 'Evidence & Audit' : page[0].toUpperCase() + page.slice(1) })
    expect(document.querySelector('.data-warning strong')).toHaveTextContent(title!)
  }
})

it('G4 placement summary stays in the copy column before its chevron', async () => {
  await mount()
  const rows = document.querySelectorAll('.activity-row')
  expect(rows.length).toBeGreaterThan(0)
  rows.forEach(row => {
    expect(row.querySelector('.activity-copy .observation-label')).not.toBeNull()
    expect(row.children).toHaveLength(4)
    expect(row.lastElementChild?.tagName.toLowerCase()).toBe('svg')
  })
})

it('G6 sign-in footer has no ticket key', async () => {
  window.history.replaceState(null, '', '#/overview')
  render(<App/>)
  await screen.findByRole('heading', { name: 'Welcome to OpenKubes' })
  expect(document.querySelector('.auth-story-foot')).not.toHaveTextContent(/OK-\d+/)
})

it('D1 current BFF coverage remains visible and agents retain catalog wording', async () => {
  await mount('capabilities', 'bff', true)
  expect(document.querySelector('.capability-grid .coverage')).not.toBeNull()
  expect(document.querySelector('.capability-grid')).toHaveTextContent(/\d+% profile coverage/)
  fireEvent.click(document.querySelector<HTMLAnchorElement>('nav a[href="#/agents"]')!)
  await screen.findByRole('heading', { name: 'AI Agents' })
  expect(document.querySelector('.agent-metrics .metric:last-child > strong')).toHaveTextContent('2')
  expect(document.querySelector('.agent-grid')).toHaveTextContent('Catalog definition')
})

it('D2 Unknown fixture banner uses the same Unknown title as BFF pages', async () => {
  await mount('overview', 'fixture', false, 'Unknown')
  expect(document.querySelector('.data-warning strong')).toHaveTextContent('Observation unavailable - readiness Unknown')
})

it('G6 Evidence list timestamps carry date, time and UTC', async () => {
  await mount('evidence')
  const rows = document.querySelectorAll('.evidence-row')
  expect(rows.length).toBeGreaterThan(0)
  rows.forEach(row => expect(row.children[4]).toHaveTextContent(stamp))
})
it('G6 cluster evidence card timestamps carry date, time and UTC', async () => {
  const data = await mount('clusters')
  fireEvent.click(screen.getByRole('button', { name: `Open ${data.clusters[0].name}` }))
  await screen.findByRole('heading', { name: 'Readiness basis' })
  const cards = document.querySelectorAll('.evidence-card small')
  expect(cards.length).toBeGreaterThan(0)
  cards.forEach(card => expect(card).toHaveTextContent(stamp))
})
it('G6 immutable receipt label timestamp carries date, time and UTC', async () => {
  await mount('evidence', 'bff', true, undefined, true)
  const label = document.querySelector('.evidence-row .observation-label')!
  expect(label).toHaveTextContent('Immutable receipt')
  expect(label).toHaveTextContent(stamp)
})

it('U2 renders the distinguishing BFF title and accessible Evidence prefix', async () => {
  const title = 'ok-mgmt external cluster registration observation'
  const data = structuredClone(platformFixture)
  data.evidence[0].title = title
  vi.spyOn(consoleData, 'getSnapshot').mockResolvedValue(data)
  window.history.replaceState(null, '', '#/clusters')
  render(<App auth={auth}/> )
  const link = await screen.findByRole('button', { name: `Evidence: ${title}` })
  expect(link.querySelector('.evidence-link-label')).toHaveTextContent(title)
  expect(link.querySelector('.sr-only')).toHaveTextContent('Evidence:')
})

it('U3 exact BFF sentinels become neutral distinguishing titles and summary copy on every evidence surface', async () => {
  const data = structuredClone(platformFixture)
  // bff/adapters/openKubesObservedState.mjs:48 (title), :19 (summary).
  const title = 'Value withheld by the Console redaction boundary.'
  const summary = 'Evidence summary withheld by the Console redaction boundary.'
  data.evidence.forEach(e => { e.title = title; e.summary = summary })
  vi.spyOn(consoleData, 'getSnapshot').mockResolvedValue(data)
  vi.spyOn(consoleData, 'getCluster').mockResolvedValue(data.clusters[0])
  window.history.replaceState(null, '', '#/overview')
  render(<App auth={auth}/> )
  await screen.findByRole('heading', { name: 'Hello UX' })
  const labels = [...document.querySelectorAll('.evidence-link-label')].map(el => el.textContent)
  expect(new Set(labels).size).toBe(labels.length)
  expect(labels.length).toBeGreaterThan(0)
  labels.forEach(label => expect(label).toContain('evidence ·'))
  fireEvent.click(document.querySelector<HTMLButtonElement>('.evidence-link')!)
  expect(screen.getByRole('dialog')).not.toHaveTextContent(/redaction boundary/)
  expect(screen.getByRole('dialog')).toHaveTextContent('Summary not shown for safety.')
  fireEvent.click(screen.getByRole('button', { name: 'Close evidence' }))
  fireEvent.click(screen.getByRole('button', { name: /Ask OK AI/ }))
  fireEvent.click(screen.getByRole('button', { name: 'ok-shared status' }))
  expect(document.querySelector('.diagnostic-message.assistant:last-child p')).not.toHaveTextContent(/redaction boundary/)
  expect(document.querySelector('.diagnostic-evidence')).not.toHaveTextContent(/redaction boundary/)
  expect(document.querySelector('.diagnostic-evidence')).toHaveTextContent('evidence ·')
  fireEvent.click(screen.getByRole('button', { name: 'Close OK AI Diagnostic' }))
  fireEvent.click(document.querySelector<HTMLAnchorElement>('nav a[href="#/clusters"]')!)
  await screen.findByRole('heading', { name: 'Clusters' })
  fireEvent.click(screen.getByRole('button', { name: `Open ${data.clusters[0].name}` }))
  await screen.findByRole('heading', { name: 'Readiness basis' })
  expect(document.querySelector('.evidence-card')).not.toHaveTextContent(/redaction boundary/)
  expect(document.querySelector('.evidence-card')).toHaveTextContent('Summary not shown for safety.')
  fireEvent.click(screen.getByRole('button', { name: '← All clusters' }))
  fireEvent.click(document.querySelector<HTMLAnchorElement>('nav a[href="#/evidence"]')!)
  await screen.findByRole('heading', { name: 'Evidence & Audit' })
  expect(document.querySelector('.evidence-list')).not.toHaveTextContent(/redaction boundary/)
})

it.each(['overview', 'clusters', 'detail', 'workloads', 'capabilities', 'agents', 'evidence', 'create'])('U5 %s main content has no ticket keys including successful dry-run', async page => {
  const data = await mount(page === 'detail' ? 'clusters' : page)
  const noKeys = () => expect(document.querySelector('#main-content')).not.toHaveTextContent(/\bOK-\d+\b/)
  if (page === 'detail') {
    fireEvent.click(screen.getByRole('button', { name: `Open ${data.clusters[0].name}` }))
    await screen.findByRole('heading', { name: 'Readiness basis' })
  }
  noKeys()
  if (page === 'create') {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { contractIdentity: 'CreateCluster', contractRevision: 'test-revision', mutationAllowed: false } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    fireEvent.click(screen.getByRole('button', { name: 'Generate contract' })); noKeys()
    fireEvent.click(screen.getByRole('button', { name: 'Continue to authorization' })); noKeys()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Run safe dry-run' }))
    await screen.findByRole('heading', { name: 'Dry-run plan' })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(document.querySelector('#main-content')).toHaveTextContent('test-revision')
    noKeys()
  }
})

it.each([false, true])('U6 workload requirement checks agree with presentation current=%s', async current => {
  const data = structuredClone(platformFixture)
  if (current) {
    data.source = 'bff'; data.freshness = 'Current'
    data.claims.forEach(c => { c.readiness = 'Ready' })
    data.evidence.forEach(e => { e.freshness = 'Current'; e.outcome = 'Ready'; e.immutable = false })
  }
  window.history.replaceState(null, '', '#/workloads')
  vi.spyOn(consoleData, 'getSnapshot').mockResolvedValue(data)
  render(<App auth={auth}/> )
  await screen.findByRole('heading', { name: 'Workloads' })
  const tags = document.querySelectorAll('.cap-tags')
  expect(tags.length).toBeGreaterThan(0)
  tags.forEach(tag => {
    expect(tag.classList.contains('current')).toBe(current)
    expect(Boolean(tag.querySelector('svg'))).toBe(current)
  })
})

it.each(['overview', 'capabilities', 'agents', 'workloads'])('U7 R4 %s explains incomplete observations despite Current freshness', async page => {
  const data = structuredClone(platformFixture)
  data.source = 'bff'; data.freshness = 'Current'; data.clusterListFreshness = 'Current'; data.warnings = []
  data.clusters.forEach(c => { c.freshness = 'Current'; c.readiness = 'Ready' })
  data.clusters[0].readiness = 'Unknown'
  data.evidence.forEach(e => { e.freshness = 'Current'; e.outcome = 'Ready'; e.immutable = false })
  data.claims.forEach(c => { c.readiness = 'Ready' })
  data.capabilities.forEach(c => { c.readiness = 'Ready' })
  data.agentDeployments.forEach(d => { d.readiness = 'Ready' })
  window.history.replaceState(null, '', `#/${page}`)
  vi.spyOn(consoleData, 'getSnapshot').mockResolvedValue(data)
  render(<App auth={auth}/> )
  await screen.findByRole('button', { name: 'Sign out of OpenKubes Console' })
  expect(document.querySelector('.data-warning strong')).toHaveTextContent('Observation unavailable - readiness Unknown')
  const suppressed = page === 'overview' ? '.metrics-grid .metric small' : page === 'agents' ? '.agent-metrics .metric:last-child small' : page === 'capabilities' ? '.capability-card dl div:last-child dd' : null
  if (suppressed) document.querySelectorAll(suppressed).forEach(el => expect(el).toHaveTextContent('Not available while observations are incomplete'))
  if (page === 'capabilities' || page === 'agents') {
    const selector = page === 'capabilities' ? '.capability-card .status' : '.agent-deployments .status'
    const badges = document.querySelectorAll(selector)
    expect(badges.length).toBeGreaterThan(0)
    badges.forEach(el => expect(el).toHaveTextContent(/^Unknown$/))
  }
})

it.each(['immutable basis', 'null metric', 'Current fixture'])('U7 suppression always has an explanation for %s', async cause => {
  const data = structuredClone(platformFixture)
  data.source = cause === 'Current fixture' ? 'fixture' : 'bff'
  data.freshness = 'Current'; data.clusterListFreshness = 'Current'; data.warnings = []; data.claims = []
  data.clusters.forEach(c => { c.freshness = 'Current'; c.readiness = 'Ready' })
  data.evidence.forEach(e => { e.freshness = 'Current'; e.outcome = 'Ready'; e.immutable = false })
  if (cause === 'Current fixture') { data.clusters = []; data.evidence = [] }
  if (cause === 'immutable basis') data.evidence[0].immutable = true
  if (cause === 'null metric') data.overview = {
    clusters: { total: data.clusters.length, ready: data.clusters.length, pending: 0, failed: 0, unknown: 0 },
    managementPlane: null,
    capabilities: { total: null, ready: null, pending: null, failed: null, unknown: null },
    workloadClaims: { total: null, ready: null, pending: null, failed: null, unknown: null },
    openFindings: { total: null, critical: null }, recentPlacements: [],
  }
  window.history.replaceState(null, '', '#/overview')
  vi.spyOn(consoleData, 'getSnapshot').mockResolvedValue(data)
  render(<App auth={auth}/> )
  await screen.findByRole('heading', { name: 'Hello UX' })
  expect(document.querySelector('.data-warning strong')).toHaveTextContent(cause === 'immutable basis' ? 'Some readiness is based on retained receipts' : 'Observation unavailable - readiness Unknown')
  document.querySelectorAll('.metric > strong').forEach(el => expect(el).toHaveTextContent(/^Unavailable$/))
})


it.each(['current', 'stale', 'stale-item', 'stale-cluster', 'stale-list', 'unknown', 'unknown-snapshot', 'historical-only'] as const)('B1 %s cause has one accurate title on all six pages', async cause => {
  const data = structuredClone(platformFixture)
  data.source = 'bff'; data.freshness = cause === 'stale' ? 'Stale' : cause === 'unknown-snapshot' ? 'Unknown' : 'Current'
  data.clusterListFreshness = 'Current'; data.warnings = []; data.claims = []
  data.clusters.forEach(c => { c.freshness = 'Current'; c.readiness = 'Ready' })
  data.evidence.forEach(e => { e.freshness = 'Current'; e.outcome = 'Ready'; e.immutable = false })
  if (cause === 'unknown' || cause === 'stale') data.clusters[0].readiness = 'Unknown'
  if (cause === 'stale-item') data.evidence[0].freshness = 'Stale'
  if (cause === 'stale-cluster') data.clusters[0].freshness = 'Stale'
  if (cause === 'stale-list') data.clusterListFreshness = 'Stale'
  if (cause === 'historical-only') data.evidence[0].immutable = true
  vi.spyOn(consoleData, 'getSnapshot').mockResolvedValue(data)
  window.history.replaceState(null, '', '#/overview')
  render(<App auth={auth}/>)
  await screen.findByRole('button', { name: 'Sign out of OpenKubes Console' })
  for (const page of ['overview', 'clusters', 'workloads', 'capabilities', 'agents', 'evidence']) {
    if (page !== 'overview') {
      fireEvent.click(document.querySelector<HTMLAnchorElement>(`nav a[href="#/${page}"]`)!)
      await screen.findByRole('heading', { name: page === 'agents' ? 'AI Agents' : page === 'evidence' ? 'Evidence & Audit' : page[0].toUpperCase() + page.slice(1) })
    }
    const title = document.querySelector('.data-warning strong')
    if (cause === 'current') expect(title).toBeNull()
    else expect(title?.textContent).toBe(cause.startsWith('stale') ? 'Some observations are stale' : cause.startsWith('unknown') ? 'Observation unavailable - readiness Unknown' : 'Some readiness is based on retained receipts')
  }
})

it.each(['Ready', 'Pending', 'Failed', 'Unknown'] as const)('B6 current placement %s requirements only confirm Ready', async readiness => {
  const data = structuredClone(platformFixture)
  data.source = 'bff'; data.freshness = 'Current'
  data.claims.forEach(c => { c.readiness = readiness })
  data.evidence.forEach(e => { e.freshness = 'Current'; e.outcome = 'Ready'; e.immutable = false })
  vi.spyOn(consoleData, 'getSnapshot').mockResolvedValue(data)
  window.history.replaceState(null, '', '#/workloads')
  render(<App auth={auth}/>)
  await screen.findByRole('heading', { name: 'Workloads' })
  const tags = document.querySelectorAll('.cap-tags')
  expect(tags.length).toBeGreaterThan(0)
  tags.forEach(tag => {
    expect(tag.classList.contains('current')).toBe(readiness === 'Ready')
    expect(Boolean(tag.querySelector('svg'))).toBe(readiness === 'Ready')
  })
})

it('B3 all producer display sentinels are neutral in text and attributes including loaded detail', async () => {
  const data = structuredClone(platformFixture)
  const withheld = 'Value withheld by the Console redaction boundary.'
  Object.assign(data, { sourceRevision: withheld, displayName: withheld })
  data.clusters.forEach(c => {
    c.name = withheld; c.provider = withheld; c.profile = withheld; c.region = withheld
    c.contractVersion = withheld; c.revision = withheld
    c.lifecycle.forEach(step => { step.label = withheld; step.detail = withheld })
  })
  data.claims.forEach(c => { c.name = withheld; c.targetCluster = withheld })
  data.evidence.forEach(e => { e.title = withheld; e.revision = withheld; e.contract = withheld; e.source = withheld; e.summary = 'Evidence summary withheld by the Console redaction boundary.' })
  vi.spyOn(consoleData, 'getSnapshot').mockResolvedValue(data)
  vi.spyOn(consoleData, 'getCluster').mockResolvedValue(data.clusters[0])
  window.history.replaceState(null, '', '#/overview')
  render(<App auth={auth}/>)
  await screen.findByRole('button', { name: 'Sign out of OpenKubes Console' })
  const neutral = () => {
    expect(document.documentElement.textContent).not.toContain('redaction boundary')
    for (const el of document.querySelectorAll('*')) for (const attr of el.attributes) expect(attr.value).not.toContain('redaction boundary')
  }
  for (const page of ['overview', 'clusters', 'workloads', 'capabilities', 'agents', 'evidence']) {
    if (page !== 'overview') {
      fireEvent.click(document.querySelector<HTMLAnchorElement>(`nav a[href="#/${page}"]`)!)
      await screen.findByRole('heading', { name: page === 'agents' ? 'AI Agents' : page === 'evidence' ? 'Evidence & Audit' : page[0].toUpperCase() + page.slice(1) })
    }
    neutral()
    const evidence = document.querySelector<HTMLButtonElement>('.evidence-link, .evidence-row')
    if (evidence) { fireEvent.click(evidence); neutral(); fireEvent.click(screen.getByRole('button', { name: 'Close evidence' })) }
    if (page === 'clusters') {
      fireEvent.click(screen.getAllByRole('button', { name: 'Open Withheld' })[0])
      await screen.findByRole('heading', { name: 'Readiness basis' })
      neutral()
      fireEvent.click(screen.getByRole('tab', { name: 'Lifecycle' })); neutral()
      fireEvent.click(screen.getByRole('button', { name: '← All clusters' }))
    }
  }
})


it('U3 exact BFF diagnostic input uses evidence labels in answer and links', () => {
  const data = structuredClone(platformFixture)
  data.evidence.forEach(item => { item.title = 'Value withheld by the Console redaction boundary.' })
  render(<DiagnosticWidget generation={1} data={data} openEvidence={vi.fn()}/>)
  fireEvent.click(screen.getByRole('button', { name: /Ask OK AI/ }))
  fireEvent.click(screen.getByRole('button', { name: 'ok-shared status' }))
  expect(document.querySelector('.diagnostic-message.assistant:last-child p')).not.toHaveTextContent('redaction boundary')
  expect(document.querySelector('.diagnostic-evidence')).not.toHaveTextContent('redaction boundary')
  expect(document.querySelector('.diagnostic-evidence')).toHaveTextContent('evidence ·')
})
