import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { consoleData } from './data/consoleData'
import { BffConsoleAdapter } from './data/bffAdapter'
import type { Freshness } from './domain/presentationContract'
import type { ConsoleAuthClient } from './auth/authClient'
import overview from '../contracts/presentation/v0alpha1/examples/platform-overview.json'
import clusters from '../contracts/presentation/v0alpha1/examples/cluster-list.json'
import detail from '../contracts/presentation/v0alpha1/examples/cluster-detail.json'
import evidence from '../contracts/presentation/v0alpha1/examples/evidence-reference.json'

vi.mock('./data/consoleData', async importOriginal => ({
  ...await importOriginal<typeof import('./data/consoleData')>(),
  consoleDataMode: 'bff',
}))

const auth: ConsoleAuthClient = {
  mode: 'oidc',
  restoreSession: vi.fn(async () => ({ method: 'oidc' as const, identity: 'Freshness Viewer', source: 'test', assurance: 'Federated', expiresIn: '1h' })),
  startOidc: vi.fn(), authenticateLocal: vi.fn(), logout: vi.fn(),
}
afterEach(() => vi.restoreAllMocks())

const cases = ['Current', 'Stale', 'Unknown', 'missing-evidence', 'foreign-evidence', 'unknown-item'] as const
type Input = typeof cases[number]

async function mount(view: string, input: Input, verdicts: { overview?: Freshness; clusters?: Freshness; detail?: Freshness; evidence?: Freshness } = {}) {
  window.location.hash = `#/${view === 'detail' ? 'clusters' : view === 'drawer' ? 'evidence' : view}`
  const verdict = input === 'Stale' || input === 'Unknown' ? input : 'Current'
  const e = structuredClone(evidence)
  e.meta.freshness = verdicts.evidence ?? verdict
  e.data.classification = 'Current'
  e.data.outcome = input === 'unknown-item' ? 'Unknown' : 'Ready'
  const c = structuredClone(clusters)
  c.meta.freshness = verdicts.clusters ?? verdict
  c.data.items = [c.data.items[0]]
  c.data.items[0].readiness = input === 'Unknown' || input === 'unknown-item' ? 'Unknown' : 'Ready'
  c.data.items[0].evidenceId = e.data.id
  e.data.clusterId = input === 'foreign-evidence' ? 'cluster-foreign' : c.data.items[0].id
  const o = structuredClone(overview)
  o.meta.freshness = verdicts.overview ?? verdict
  o.data.recentPlacements = []
  const d = structuredClone(detail)
  d.meta.freshness = verdicts.detail ?? verdict
  Object.assign(d.data, c.data.items[0])
  const adapter = new BffConsoleAdapter('/api/console/v0', vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url)
    const body = path.endsWith('/overview') ? o : path.endsWith('/clusters') ? c : path.includes('/evidence/') ? e : d
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch)
  const snapshot = await adapter.getSnapshot()
  if (input === 'missing-evidence') snapshot.evidence = []
  vi.spyOn(consoleData, 'getSnapshot').mockResolvedValue(snapshot)
  vi.spyOn(consoleData, 'getCluster').mockImplementation(id => adapter.getCluster(id))
  const result = render(<App auth={auth}/>)
  await screen.findByRole('heading', { name: view === 'overview' ? 'Hello Freshness' : view === 'agents' ? 'AI Agents' : view === 'clusters' || view === 'detail' ? 'Clusters' : 'Evidence & Audit' })
  if (view === 'detail') {
    fireEvent.click(screen.getByRole('button', { name: `Open ${c.data.items[0].name}` }))
    await screen.findByText('Lifecycle posture')
    await screen.findByText(d.data.lifecycle[0].label)
  }
  if (view === 'drawer') fireEvent.click(screen.getByRole('button', { name: new RegExp(e.data.title) }))
  return { ...result, snapshot, e }
}

describe('BFF observation framing by view', () => {
  for (const view of ['overview', 'clusters', 'detail', 'evidence', 'drawer', 'agents']) {
    for (const input of cases.filter(input => !['missing-evidence', 'foreign-evidence'].includes(input) || view === 'detail')) {
      it(`${view}: ${input} only displays currency for a genuine observation`, async () => {
        const { container, snapshot, e } = await mount(view, input)
        const scope = view === 'drawer' ? screen.getByRole('dialog') : container.querySelector('main')!
        const current = input === 'Current' && view !== 'agents'
        expect(scope.textContent).toMatch(current ? /Current/ : /^(?![\s\S]*Current)/)
        expect(scope.querySelectorAll('.live-dot').length).toBe(current ? (view === 'drawer' ? 1 : view === 'detail' ? 2 : 1) : 0)
        if (['overview', 'clusters', 'detail', 'evidence'].includes(view) && (input === 'Stale' || input === 'Unknown')) {
          expect(scope.querySelector('.data-warning')).toHaveTextContent(input === 'Stale' ? 'Some observations are stale' : 'Observation unavailable - readiness Unknown')
        }
        if (view === 'agents') {
          expect(screen.getByRole('heading', { name: 'Kagent Platform Operator' })).toBeVisible()
          expect(container.querySelector('.agent-deployments')).toBeEmptyDOMElement()
          expect(snapshot.agentDeployments).toEqual([])
          expect(snapshot.evidence.map(item => item.id)).toEqual([e.data.id])
          expect(within(scope as HTMLElement).queryByText(/cluster-inspector/)).not.toBeInTheDocument()
          expect(container.querySelector('.agent-card footer')).toHaveTextContent('Catalog definition')
        }
      })
    }
  }
})

for (const [view, endpoint] of [['clusters', 'clusters'], ['detail', 'detail'], ['evidence', 'evidence'], ['drawer', 'evidence']] as const) {
  it.each(['Stale', 'Unknown'] as const)(`${view} uses its own response verdict %s even with Current overview`, async freshness => {
    const { container } = await mount(view, 'Current', { [endpoint]: freshness })
    const scope = view === 'drawer' ? screen.getByRole('dialog') : container.querySelector('main')!
    // Cluster detail may also contain independently fresh Evidence: scope the posture label.
    const observation = view === 'detail' ? scope.querySelector('.detail-grid .panel-title')! : scope
    expect(observation.textContent).not.toContain('Current')
    expect(observation.querySelector('.live-dot')).toBeNull()
    if (view !== 'drawer') expect(scope.querySelector('.data-warning')).not.toBeNull()
  })
}
