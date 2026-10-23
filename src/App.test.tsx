import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { consoleData } from './data/consoleData'
import { BffConsoleAdapter } from './data/bffAdapter'
import { platformFixture } from './data/fixtures'
import clusterListExample from '../contracts/presentation/v0alpha1/examples/cluster-list.json'
import evidenceExample from '../contracts/presentation/v0alpha1/examples/evidence-reference.json'
import detailExample from '../contracts/presentation/v0alpha1/examples/cluster-detail.json'
import overviewExample from '../contracts/presentation/v0alpha1/examples/platform-overview.json'
import type { PlatformOverviewData } from './domain/presentationContract'
import type { ConsoleAuthClient } from './auth/authClient'


const dataMode = vi.hoisted(() => ({ value: 'fixture' as 'fixture' | 'bff' }))
vi.mock('./data/consoleData', async (importOriginal) => ({
  ...await importOriginal<typeof import('./data/consoleData')>(),
  get consoleDataMode() { return dataMode.value },
}))

const shellEntries = (log: HTMLElement) => Array.from(log.children).map((entry) => ({
  className: entry.className, text: entry.querySelector('pre')?.textContent,
}))

const entry = (kind: string, text: string) => ({ className: `terminal-entry terminal-${kind}`, text })
const proposal = entry('proposal', 'Suggested read-only command · kubectl get clusterconditions -o wide')

const renderSignedIn = async () => {
  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: /Continue with OpenKubes Identity/i }))
  fireEvent.click(screen.getByRole('button', { name: /Simulate identity provider return/i }))
  expect(await screen.findByRole('heading', { name: 'Identity verified' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /Enter Console/i }))
  await screen.findByRole('button', { name: /Sign out of OpenKubes Console/i })
}

beforeEach(() => { window.location.hash = '#/overview'; dataMode.value = 'fixture' })

const openShell = async (name = 'ok-mgmt') => {
  window.location.hash = '#/clusters'
  await renderSignedIn()
  fireEvent.click(await screen.findByRole('button', { name: `Open ${name}` }))
  fireEvent.click(await screen.findByRole('button', { name: /Open Shell/i }))
  const shell = within(await screen.findByRole('dialog', { name: `Shell · ${name}` }))
  return { ...shell, run: (value: string) => {
    fireEvent.change(shell.getByPlaceholderText(/read-only command or ask why/i), { target: { value } })
    fireEvent.click(shell.getByRole('button', { name: /^Run$/ }))
  }, log: shell.getByRole('log') }
}

describe('OpenKubes Console', () => {

  it('keeps protected platform content behind federated-first sign-in', async () => {
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Welcome to OpenKubes' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Continue with OpenKubes Identity/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Use a local account/i })).toHaveTextContent(/Bootstrap \/ break-glass only/i)
    expect(screen.queryByText('ok-mgmt')).not.toBeInTheDocument()
  })

  it('restores a live BFF session before exposing platform data and logs out server-side', async () => {
    const auth: ConsoleAuthClient = {
      mode: 'oidc',
      restoreSession: vi.fn(async () => ({ method: 'oidc' as const, identity: 'Live User', source: 'provider-1', assurance: 'Federated · MFA', expiresIn: 'Until 10:00' })),
      startOidc: vi.fn(),
      authenticateLocal: vi.fn(),
      logout: vi.fn(async () => {}),
    }
    render(<App auth={auth}/>)

    expect(screen.getByText('Checking secure Console session…')).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Hello Live' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Sign out of OpenKubes Console/i }))
    await waitFor(() => expect(auth.logout).toHaveBeenCalledTimes(1))
    expect(await screen.findByRole('heading', { name: 'Welcome to OpenKubes' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Local account not enabled/i })).toBeDisabled()
  })

  it('hands the live sign-in action to the fixed OIDC client port', async () => {
    const auth: ConsoleAuthClient = {
      mode: 'oidc', restoreSession: vi.fn(async () => null), startOidc: vi.fn(), authenticateLocal: vi.fn(), logout: vi.fn(async () => {}),
    }
    render(<App auth={auth}/>)
    fireEvent.click(await screen.findByRole('button', { name: /Continue with OpenKubes Identity/i }))
    fireEvent.click(screen.getByRole('button', { name: /Continue to identity provider/i }))
    expect(auth.startOidc).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/Simulation only/i)).not.toBeInTheDocument()
  })

  it('reviews a federated identity separately from authority and signs out safely', async () => {
    await renderSignedIn()
    expect(screen.getByText('Federated identity')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Sign out of OpenKubes Console/i }))
    expect(await screen.findByRole('heading', { name: 'Welcome to OpenKubes' })).toBeInTheDocument()
    expect(screen.queryByText('ok-mgmt')).not.toBeInTheDocument()
  })

  it('guards local bootstrap access with a reason and explicit acknowledgement', async () => {
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /Use a local account/i }))
    expect(screen.getByRole('heading', { name: 'Bootstrap / break-glass' })).toBeInTheDocument()
    const review = screen.getByRole('button', { name: /Review local session/i })
    expect(review).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Local username'), { target: { value: 'bootstrap-admin' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'prototype-only' } })
    fireEvent.change(screen.getByLabelText(/Operational reason/i), { target: { value: 'Federation is unavailable during recovery' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /time-bound and audited/i }))
    expect(review).toBeEnabled()
    fireEvent.click(review)
    expect(await screen.findByRole('heading', { name: 'Review break-glass session' })).toBeInTheDocument()
    expect(screen.getByText('Local bootstrap / break-glass')).toBeInTheDocument()
    expect(screen.queryByDisplayValue('prototype-only')).not.toBeInTheDocument()
  })

  it('submits live break-glass credentials only through the auth client and enters with its session projection', async () => {
    const authenticateLocal = vi.fn(async () => ({
      method: 'local' as const, identity: 'Recovery Admin', source: 'BreakGlass local account',
      assurance: 'Password · ExceptionalAccess', expiresIn: 'Until 10:00',
    }))
    const auth: ConsoleAuthClient = {
      mode: 'breakglass', restoreSession: vi.fn(async () => null), startOidc: vi.fn(),
      authenticateLocal, logout: vi.fn(async () => {}),
    }
    render(<App auth={auth}/>)
    fireEvent.click(await screen.findByRole('button', { name: /Use a local account/i }))
    expect(screen.getByRole('heading', { name: 'Break-glass access' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Local username'), { target: { value: 'recovery-admin' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'one-time-secret' } })
    fireEvent.change(screen.getByLabelText(/Operational reason/i), { target: { value: 'Federation provider is unavailable' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /time-bound and audited/i }))
    fireEvent.click(screen.getByRole('button', { name: /Authenticate and enter Console/i }))

    await waitFor(() => expect(authenticateLocal).toHaveBeenCalledWith({
      username: 'recovery-admin', password: 'one-time-secret', reason: 'Federation provider is unavailable',
    }))
    expect(await screen.findByRole('heading', { name: 'Hello Recovery' })).toBeInTheDocument()
    expect(screen.queryByDisplayValue('one-time-secret')).not.toBeInTheDocument()
  })

  it('shows bootstrap as the sole live entry method and clears a rejected password', async () => {
    const auth: ConsoleAuthClient = {
      mode: 'bootstrap', restoreSession: vi.fn(async () => null), startOidc: vi.fn(),
      authenticateLocal: vi.fn(async () => { throw new Error('private dependency detail') }), logout: vi.fn(async () => {}),
    }
    render(<App auth={auth}/>)
    expect(await screen.findByRole('button', { name: /Use a local account/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Continue with OpenKubes Identity/i })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Use a local account/i }))
    fireEvent.change(screen.getByLabelText('Local username'), { target: { value: 'bootstrap-admin' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'bootstrap-secret' } })
    fireEvent.change(screen.getByLabelText(/Operational reason/i), { target: { value: 'Initial platform bootstrap' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /time-bound and audited/i }))
    fireEvent.click(screen.getByRole('button', { name: /Authenticate and enter Console/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Exceptional local access could not be completed.')
    expect(screen.queryByDisplayValue('bootstrap-secret')).not.toBeInTheDocument()
    expect(screen.queryByText('private dependency detail')).not.toBeInTheDocument()
  })

  it('renders the management plane first with evidence-backed status', async () => {
    await renderSignedIn()
    const managementMarkers = screen.getAllByText('Management plane')
    expect(managementMarkers.length).toBeGreaterThan(0)
    expect(screen.getAllByText('ok-mgmt').length).toBeGreaterThan(0)
  })

  it('labels illustrative capability fixtures separately from empty live observations', async () => {
    const getSnapshot = vi.spyOn(consoleData, 'getSnapshot').mockResolvedValue({
      ...structuredClone(platformFixture),
      source: 'bff',
      capabilities: [],
    })
    dataMode.value = 'bff'
    window.location.hash = '#/capabilities'
    try {
      await renderSignedIn()
      expect(screen.getByText('Demo catalog')).toBeInTheDocument()
      expect(screen.getByText(/These seven entries are demo fixtures, not observations from ok-shared/i)).toBeInTheDocument()
      expect(screen.getByRole('heading', { name: 'Identity' })).toBeInTheDocument()
      expect(screen.getByRole('heading', { name: 'Messaging' })).toBeInTheDocument()
    } finally {
      getSnapshot.mockRestore()
      dataMode.value = 'fixture'
    }
  })

  it('exposes all curated product areas in navigation', async () => {
    await renderSignedIn()
    for (const label of ['Platform Overview', 'Clusters', 'Workloads', 'AI Agents', 'Capabilities', 'Evidence & Audit', 'Create Cluster', 'Register Existing Cluster']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    }
  })

  it('keeps prototype authorization disabled until review is confirmed', async () => {
    window.location.hash = '#/create'
    await renderSignedIn()
    await screen.findByText('Declare cluster intent')
    fireEvent.click(screen.getByRole('button', { name: /Generate contract/i }))
    fireEvent.click(screen.getByRole('button', { name: /Continue to authorization/i }))
    const authorize = screen.getByRole('button', { name: /Run safe dry-run/i })
    expect(authorize).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox'))
    await waitFor(() => expect(authorize).toBeEnabled())
  })

  it('shows a grouped illustrative CAPI provider catalog in the cluster draft', async () => {
    window.location.hash = '#/create'
    await renderSignedIn()

    const provider = screen.getByRole('combobox', { name: 'Infrastructure provider' })
    expect(within(provider).getByRole('group', { name: /Sovereign & self-managed/i })).toBeInTheDocument()
    expect(within(provider).getByRole('group', { name: /Public cloud/i })).toBeInTheDocument()
    for (const label of ['Bare Metal Infra', 'KubeVirt Workers', 'OpenStack', 'VMware vSphere', 'Proxmox', 'STACKIT', 'Hetzner', 'OVHcloud', 'YORIZON', 'AWS', 'GCP', 'Azure']) {
      expect(within(provider).getByRole('option', { name: label })).toBeInTheDocument()
    }
    expect(screen.getByText(/Illustrative CAPI provider catalog · selection does not provision infrastructure/i)).toBeInTheDocument()

    fireEvent.change(provider, { target: { value: 'VMware vSphere' } })
    fireEvent.click(screen.getByRole('button', { name: /Generate contract/i }))
    expect(await screen.findByText('VMware vSphere')).toBeInTheDocument()
    expect(screen.getByText(/provider: vmware-vsphere/)).toBeInTheDocument()
  })

  it('opens a cluster-scoped shell and blocks mutating commands', async () => {
    const shell = await openShell()
    expect(shell.log.querySelector('pre')?.textContent).toBe('Read-only prototype session established for ok-mgmt. No credential, kubeconfig, WebSocket, or backend connection was created.')

    shell.run('clear')
    shell.run('kubectl delete node observed-node')
    expect(shellEntries(shell.log)).toEqual([
      entry('command', 'kubectl delete node observed-node'),
      entry('blocked', 'BLOCKED · This read-only prototype cannot invoke a mutating operation. A production request would enter Review → Authorization → Execution.'),
    ])
    shell.run('clear')
    shell.run('why is this cluster ready?')
    expect(shellEntries(shell.log)).toEqual([
      entry('command', 'why is this cluster ready?'),
      entry('ai', 'This shell session holds readiness Ready and 4 lifecycle stage(s), all reporting Ready.'),
      proposal,
    ])
  })

  it.each(['ok-mgmt', 'edge-07'])('asserts complete diagnostic responses for %s', async (name) => {
    const shell = await openShell(name)
    for (const [command, kind, text] of [
      ['kubectl get nodes', 'blocked', 'UNAVAILABLE · Node listings are not available from the observed-state contract.'],
      ['kubectl get namespaces', 'blocked', 'UNAVAILABLE · Namespace listings are not available from the observed-state contract.'],
      ['help', 'output', 'Allowed examples:\n  kubectl get clusterconditions -o wide\n  ok evidence explain\n  why is this cluster pending?'],
      ['whoami', 'blocked', 'UNKNOWN · This command is not in the prototype read-only allowlist. Type “help” to see supported diagnostics.'],
    ]) {
      shell.run('clear')
      shell.run(command)
      expect(shellEntries(shell.log)).toEqual([entry('command', command), entry(kind, text)])
    }
    expect(within(shell.getByRole('combobox', { name: 'Shell namespace' })).getAllByRole('option').map((option) => option.textContent)).toEqual(['all namespaces'])
    expect(shell.queryByRole('button', { name: 'kubectl get nodes' })).not.toBeInTheDocument()
    expect(shell.queryByRole('button', { name: 'kubectl get namespaces' })).not.toBeInTheDocument()
  })

  it.each(['ok evidence explain', 'why is this cluster pending?'])(
    'reports Unknown and unavailable conditions for a BFF-adapted summary in fixture mode: %s', async (command) => {
      const fetcher = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        const body = url.endsWith('/overview') ? overviewExample
          : url.endsWith('/clusters') ? clusterListExample : evidenceExample
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }) as typeof fetch
      const adapter = new BffConsoleAdapter('/api/console/v0', fetcher)
      const snapshot = await adapter.getSnapshot()
      const cluster = snapshot.clusters.find((item) => item.name === 'edge-07')!
      expect(cluster.readiness).toBe('Unknown')
      expect(cluster.lifecycle).toEqual([])
      const observation = vi.spyOn(consoleData, 'getSnapshot').mockResolvedValueOnce(snapshot)
      try {
        const shell = await openShell('edge-07')
        shell.run('clear')
        shell.run(command)
        expect(shellEntries(shell.log)).toEqual([
          entry('command', command),
          entry('ai', 'This shell session holds readiness Unknown for edge-07. This shell session holds no lifecycle detail for edge-07.'),
          proposal,
        ])
        shell.run('clear')
        fireEvent.click(shell.getByRole('button', { name: 'kubectl get clusterconditions -o wide' }))
        expect(shellEntries(shell.log)).toEqual([
          entry('command', 'kubectl get clusterconditions -o wide'),
          entry('blocked', 'UNAVAILABLE · This shell session holds no lifecycle detail for edge-07.'),
        ])
        shell.run('clear')
        shell.run('evidence')
        expect(shellEntries(shell.log)).toEqual([
          entry('command', 'evidence'),
          entry('output', 'This shell session holds the following evidence snapshot:\nEVIDENCE     ev-edge-unknown\nCONTRACT     platform.openkubes.io/v1alpha0\nREVISION     rev-88e913\nREADINESS    Unknown\nSOURCE       bff'),
        ])
      } finally {
        observation.mockRestore()
      }
    },
  )

  // Expected output is literal and independent of the mutable cluster snapshot.
  it.each([
    {
      name: 'unknown without stages', readiness: 'Unknown', states: [], source: 'fixture',
      explanation: 'This shell session holds readiness Unknown for ok-mgmt. This shell session holds no lifecycle detail for ok-mgmt.',
      conditions: 'UNAVAILABLE · This shell session holds no lifecycle detail for ok-mgmt.',
      evidence: 'This shell session holds the following evidence snapshot:\nEVIDENCE     ev-mgmt-ready\nCONTRACT     platform.openkubes.io/v1alpha1\nREVISION     rev-7d2a9c\nREADINESS    Unknown\nSOURCE       fixture',
    },
    {
      name: 'ready without stages', readiness: 'Ready', states: [], source: undefined,
      explanation: 'This shell session holds readiness Ready for ok-mgmt. This shell session holds no lifecycle detail for ok-mgmt.',
      conditions: 'UNAVAILABLE · This shell session holds no lifecycle detail for ok-mgmt.',
      evidence: 'This shell session holds the following evidence snapshot:\nEVIDENCE     ev-mgmt-ready\nCONTRACT     platform.openkubes.io/v1alpha1\nREVISION     rev-7d2a9c\nREADINESS    Ready\nSOURCE       unspecified',
    },
    {
      name: 'unknown with ready stages', readiness: 'Unknown', states: ['Ready', 'Ready'], source: 'bff',
      explanation: 'This shell session holds readiness Unknown for ok-mgmt. Its 2 lifecycle stage(s) all report Ready; stages do not establish overall readiness.',
      conditions: 'This shell session holds the following lifecycle snapshot:\nStage 1            Ready    Detail 1\nStage 2            Ready    Detail 2',
      evidence: 'This shell session holds the following evidence snapshot:\nEVIDENCE     ev-mgmt-ready\nCONTRACT     platform.openkubes.io/v1alpha1\nREVISION     rev-7d2a9c\nREADINESS    Unknown\nSOURCE       bff',
    },
    {
      name: 'pending with ready stages', readiness: 'Pending', states: ['Ready', 'Ready'], source: 'fixture',
      explanation: 'This shell session holds readiness Pending for ok-mgmt. Its 2 lifecycle stage(s) all report Ready; stages do not establish overall readiness.',
      conditions: 'This shell session holds the following lifecycle snapshot:\nStage 1            Ready    Detail 1\nStage 2            Ready    Detail 2',
      evidence: 'This shell session holds the following evidence snapshot:\nEVIDENCE     ev-mgmt-ready\nCONTRACT     platform.openkubes.io/v1alpha1\nREVISION     rev-7d2a9c\nREADINESS    Pending\nSOURCE       fixture',
    },
    {
      name: 'ready with two ready stages', readiness: 'Ready', states: ['Ready', 'Ready'], source: 'fixture',
      explanation: 'This shell session holds readiness Ready and 2 lifecycle stage(s), all reporting Ready.',
      conditions: 'This shell session holds the following lifecycle snapshot:\nStage 1            Ready    Detail 1\nStage 2            Ready    Detail 2',
      evidence: 'This shell session holds the following evidence snapshot:\nEVIDENCE     ev-mgmt-ready\nCONTRACT     platform.openkubes.io/v1alpha1\nREVISION     rev-7d2a9c\nREADINESS    Ready\nSOURCE       fixture',
    },
    {
      name: 'ready with pending stage', readiness: 'Ready', states: ['Ready', 'Pending'], source: 'bff',
      explanation: 'This shell session holds readiness Ready for ok-mgmt.\nStage 2: Pending — Detail 2',
      conditions: 'This shell session holds the following lifecycle snapshot:\nStage 1            Ready    Detail 1\nStage 2            Pending  Detail 2',
      evidence: 'This shell session holds the following evidence snapshot:\nEVIDENCE     ev-mgmt-ready\nCONTRACT     platform.openkubes.io/v1alpha1\nREVISION     rev-7d2a9c\nREADINESS    Ready\nSOURCE       bff',
    },
    {
      name: 'ready with failed stage', readiness: 'Ready', states: ['Failed'], source: 'fixture',
      explanation: 'This shell session holds readiness Ready for ok-mgmt.\nStage 1: Failed — Detail 1',
      conditions: 'This shell session holds the following lifecycle snapshot:\nStage 1            Failed   Detail 1',
      evidence: 'This shell session holds the following evidence snapshot:\nEVIDENCE     ev-mgmt-ready\nCONTRACT     platform.openkubes.io/v1alpha1\nREVISION     rev-7d2a9c\nREADINESS    Ready\nSOURCE       fixture',
    },
    {
      name: 'unknown with failed stage', readiness: 'Unknown', states: ['Failed'], source: undefined,
      explanation: 'This shell session holds readiness Unknown for ok-mgmt.\nStage 1: Failed — Detail 1',
      conditions: 'This shell session holds the following lifecycle snapshot:\nStage 1            Failed   Detail 1',
      evidence: 'This shell session holds the following evidence snapshot:\nEVIDENCE     ev-mgmt-ready\nCONTRACT     platform.openkubes.io/v1alpha1\nREVISION     rev-7d2a9c\nREADINESS    Unknown\nSOURCE       unspecified',
    },
    {
      name: 'failed with mixed stages', readiness: 'Failed', states: ['Pending', 'Failed'], source: 'fixture',
      explanation: 'This shell session holds readiness Failed for ok-mgmt.\nStage 1: Pending — Detail 1\nStage 2: Failed — Detail 2',
      conditions: 'This shell session holds the following lifecycle snapshot:\nStage 1            Pending  Detail 1\nStage 2            Failed   Detail 2',
      evidence: 'This shell session holds the following evidence snapshot:\nEVIDENCE     ev-mgmt-ready\nCONTRACT     platform.openkubes.io/v1alpha1\nREVISION     rev-7d2a9c\nREADINESS    Failed\nSOURCE       fixture',
    },
    {
      name: 'unknown with unknown stage', readiness: 'Unknown', states: ['Unknown'], source: 'bff',
      explanation: 'This shell session holds readiness Unknown for ok-mgmt.\nStage 1: Unknown — Detail 1',
      conditions: 'This shell session holds the following lifecycle snapshot:\nStage 1            Unknown  Detail 1',
      evidence: 'This shell session holds the following evidence snapshot:\nEVIDENCE     ev-mgmt-ready\nCONTRACT     platform.openkubes.io/v1alpha1\nREVISION     rev-7d2a9c\nREADINESS    Unknown\nSOURCE       bff',
    },
    {
      name: 'ready with one ready stage', readiness: 'Ready', states: ['Ready'], source: 'fixture',
      explanation: 'This shell session holds readiness Ready and 1 lifecycle stage(s), all reporting Ready.',
      conditions: 'This shell session holds the following lifecycle snapshot:\nStage 1            Ready    Detail 1',
      evidence: 'This shell session holds the following evidence snapshot:\nEVIDENCE     ev-mgmt-ready\nCONTRACT     platform.openkubes.io/v1alpha1\nREVISION     rev-7d2a9c\nREADINESS    Ready\nSOURCE       fixture',
    },
    {
      name: 'failed with three non-ready stages', readiness: 'Failed', states: ['Pending', 'Unknown', 'Failed'], source: 'bff',
      explanation: 'This shell session holds readiness Failed for ok-mgmt.\nStage 1: Pending — Detail 1\nStage 2: Unknown — Detail 2\nStage 3: Failed — Detail 3',
      conditions: 'This shell session holds the following lifecycle snapshot:\nStage 1            Pending  Detail 1\nStage 2            Unknown  Detail 2\nStage 3            Failed   Detail 3',
      evidence: 'This shell session holds the following evidence snapshot:\nEVIDENCE     ev-mgmt-ready\nCONTRACT     platform.openkubes.io/v1alpha1\nREVISION     rev-7d2a9c\nREADINESS    Failed\nSOURCE       bff',
    },
    {
      name: 'failed without stages', readiness: 'Failed', states: [], source: 'fixture',
      explanation: 'This shell session holds readiness Failed for ok-mgmt. This shell session holds no lifecycle detail for ok-mgmt.',
      conditions: 'UNAVAILABLE · This shell session holds no lifecycle detail for ok-mgmt.',
      evidence: 'This shell session holds the following evidence snapshot:\nEVIDENCE     ev-mgmt-ready\nCONTRACT     platform.openkubes.io/v1alpha1\nREVISION     rev-7d2a9c\nREADINESS    Failed\nSOURCE       fixture',
    },
    {
      name: 'failed with ready stages', readiness: 'Failed', states: ['Ready', 'Ready'], source: 'fixture',
      explanation: 'This shell session holds readiness Failed for ok-mgmt. Its 2 lifecycle stage(s) all report Ready; stages do not establish overall readiness.',
      conditions: 'This shell session holds the following lifecycle snapshot:\nStage 1            Ready    Detail 1\nStage 2            Ready    Detail 2',
      evidence: 'This shell session holds the following evidence snapshot:\nEVIDENCE     ev-mgmt-ready\nCONTRACT     platform.openkubes.io/v1alpha1\nREVISION     rev-7d2a9c\nREADINESS    Failed\nSOURCE       fixture',
    },
  ] as const)('keeps readiness independent of stages: $name', async ({ readiness, states, source, explanation, conditions, evidence }) => {
    const snapshot = await consoleData.getSnapshot()
    snapshot.source = source
    const cluster = snapshot.clusters.find((item) => item.name === 'ok-mgmt')!
    cluster.readiness = readiness
    cluster.lifecycle = states.map((state, index) => ({ label: `Stage ${index + 1}`, state, detail: `Detail ${index + 1}` }))
    const observation = vi.spyOn(consoleData, 'getSnapshot').mockResolvedValueOnce(snapshot)
    try {
      const shell = await openShell()
      shell.run('clear')
      shell.run('ok evidence explain')
      expect(shellEntries(shell.log)).toEqual([
        entry('command', 'ok evidence explain'), entry('ai', explanation), proposal,
      ])
      shell.run('clear')
      shell.run('kubectl get clusterconditions -o wide')
      expect(shellEntries(shell.log)).toEqual([
        entry('command', 'kubectl get clusterconditions -o wide'),
        entry(states.length ? 'output' : 'blocked', conditions),
      ])
      shell.run('clear')
      shell.run('evidence')
      expect(shellEntries(shell.log)).toEqual([entry('command', 'evidence'), entry('output', evidence)])
    } finally {
      observation.mockRestore()
    }
  })

  it.each(['resolved', 'rejected'] as const)('keeps shell lifecycle session-scoped when BFF detail is %s', async (status) => {
    dataMode.value = 'bff'
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/clusters/')) {
        await gate
        if (status === 'rejected') throw new Error('Detail unavailable')
        return new Response(JSON.stringify({ ...detailExample, data: { ...detailExample.data, id: 'cluster-ok-mgmt', name: 'ok-mgmt', role: 'Management plane', readiness: 'Failed', revision: 'rev-new' } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      const body = url.endsWith('/overview') ? overviewExample
        : url.endsWith('/clusters') ? clusterListExample : evidenceExample
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch
    const adapter = new BffConsoleAdapter('/api/console/v0', fetcher)
    const observation = vi.spyOn(consoleData, 'getSnapshot').mockImplementation(() => adapter.getSnapshot())
    const detail = vi.spyOn(consoleData, 'getCluster').mockImplementation((id) => adapter.getCluster(id))
    try {
      const shell = await openShell()
      expect(detail).toHaveBeenCalledExactlyOnceWith('cluster-ok-mgmt')
      expect(screen.queryByText('Endpoint observed through the management plane')).not.toBeInTheDocument()
      release()
      if (status === 'resolved') {
        expect(await screen.findByText('Endpoint observed through the management plane')).toBeInTheDocument()
        expect(screen.getAllByText('Failed').length).toBeGreaterThan(0)
        expect(screen.getByText(/rev-new/)).toBeInTheDocument()
      } else {
        expect(await screen.findByRole('alert')).toHaveTextContent('Cluster detail is unavailable')
      }
      shell.run('clear')
      fireEvent.click(shell.getByRole('button', { name: 'ok evidence explain' }))
      expect(shellEntries(shell.log)).toEqual([
        entry('command', 'ok evidence explain'),
        entry('ai', 'This shell session holds readiness Ready for ok-mgmt. This shell session holds no lifecycle detail for ok-mgmt.'),
        proposal,
      ])
      shell.run('clear')
      fireEvent.click(shell.getByRole('button', { name: 'kubectl get clusterconditions -o wide' }))
      expect(shellEntries(shell.log)).toEqual([
        entry('command', 'kubectl get clusterconditions -o wide'),
        entry('blocked', 'UNAVAILABLE · This shell session holds no lifecycle detail for ok-mgmt.'),
      ])
      shell.run('clear')
      shell.run('evidence')
      expect(shellEntries(shell.log)).toEqual([
        entry('command', 'evidence'),
        entry('output', 'This shell session holds the following evidence snapshot:\nEVIDENCE     ev-mgmt-ready\nCONTRACT     platform.openkubes.io/v1alpha1\nREVISION     rev-7d2a9c\nREADINESS    Ready\nSOURCE       bff'),
      ])
    } finally {
      release()
      observation.mockRestore()
      detail.mockRestore()
    }
  })

  it('deploys a verified Agent only through a conformant Worker Cluster review', async () => {
    window.location.hash = '#/agents'
    await renderSignedIn()
    expect(await screen.findByRole('heading', { name: 'AI Agents' })).toBeInTheDocument()
    expect(screen.getByText('Kagent Platform Operator')).toBeInTheDocument()

    fireEvent.click(screen.getAllByRole('button', { name: /Deploy Agent/i })[0])
    expect(await screen.findByRole('heading', { name: /Deploy Kagent Platform Operator/i })).toBeInTheDocument()
    const target = screen.getByRole('radio', { name: /ok-ai/i })
    expect(target).toBeChecked()
    expect(screen.queryByRole('radio', { name: /ok-mgmt/i })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Review permissions/i }))
    expect(await screen.findByText('Review tools and permissions')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Generate claim/i }))
    expect(await screen.findByText('Review the generated AgentDeploymentClaim')).toBeInTheDocument()
    const simulate = screen.getByRole('button', { name: /Simulate deployment/i })
    expect(simulate).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox'))
    expect(simulate).toBeEnabled()
    fireEvent.click(simulate)
    expect(await screen.findByText('Deployment journey validated')).toBeInTheDocument()
    expect(screen.getByText(/No Agent, namespace, credential, workload, or backend resource was created/i)).toBeInTheDocument()
  })

  it('shows the OK AI diagnostic preview without presenting it as verified or deployable', async () => {
    window.location.hash = '#/agents'
    await renderSignedIn()

    expect(await screen.findByRole('heading', { name: 'OK AI Diagnostic Agent' })).toBeInTheDocument()
    expect(screen.getByText('Demo Preview')).toBeInTheDocument()
    expect(screen.getByText(/Read-only; it does not change clusters or workloads/i)).toBeInTheDocument()
    expect(screen.getByText('Preview only · not deployed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Preview only/i })).toBeDisabled()
  })

  it('opens a persistent read-only OK AI Diagnostic widget and links answers to observed evidence', async () => {
    await renderSignedIn()

    fireEvent.click(screen.getByRole('button', { name: /Ask OK AI/i }))
    expect(screen.getByRole('dialog', { name: 'OK AI Diagnostic preview' })).toBeInTheDocument()
    expect(screen.getByText(/no live AI service or cluster actions are connected/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'ok-shared status' }))
    expect(await screen.findByText(/ok-shared is currently shown as Pending/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /View evidence · Shared services convergence/i }))
    expect(await screen.findByRole('heading', { name: 'Shared services convergence' })).toBeInTheDocument()
  })

  it('registers an existing cluster with external ownership and least authority', async () => {
    window.location.hash = '#/register'
    await renderSignedIn()
    expect(await screen.findByRole('heading', { name: 'Register Existing Cluster' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Outbound Connector/i })).toBeChecked()
    expect(screen.getByRole('radio', { name: /Upload kubeconfig/i })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: /Run safe discovery/i }))
    expect(await screen.findByText(/No cluster was contacted/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Review management scope/i }))
    expect(screen.getByRole('radio', { name: /Observe only/i })).toBeChecked()
    expect(screen.getByRole('radio', { name: /Full adoption/i })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: /Generate registration/i }))
    expect(await screen.findByRole('heading', { name: /Review ExternalClusterRegistration/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Continue to authorization/i }))
    const authorize = screen.getByRole('button', { name: /Authorize prototype/i })
    expect(authorize).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed this exact ExternalClusterRegistration/i }))
    expect(authorize).toBeEnabled()
    fireEvent.click(authorize)
    expect(await screen.findByRole('heading', { name: /Registration journey validated/i })).toBeInTheDocument()
    expect(screen.getByText(/Simulated only · no resource created/i)).toBeInTheDocument()
  })
})


it('shows unavailable observed metrics and no invented management plane for a tenant-only fleet', async () => {
  window.location.hash = '#/overview'
  const snapshot = await consoleData.getSnapshot()
  snapshot.clusters = snapshot.clusters.filter((cluster) => cluster.id === 'cluster-ok-ai')
  snapshot.overview = {
    ...overviewExample.data as PlatformOverviewData,
    managementPlane: null,
    capabilities: { total: null, ready: null, pending: null, failed: null, unknown: null },
    workloadClaims: { total: null, ready: null, pending: null, failed: null, unknown: null },
    openFindings: { total: null, critical: null },
  }
  const observation = vi.spyOn(consoleData, 'getSnapshot').mockResolvedValueOnce(snapshot)
  try {
    await renderSignedIn()
    expect(await screen.findAllByText('Unavailable')).toHaveLength(3)
    expect(screen.getByText(/0 management plane/)).toBeInTheDocument()
    expect(document.querySelector('.management-ribbon')).toBeNull()
    window.location.hash = '#/clusters'
    fireEvent(window, new Event('hashchange'))
    expect(await screen.findByRole('button', { name: 'Ready · 1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Attention · 0' })).toBeInTheDocument()
    expect(document.querySelector('.management-row')).toBeNull()
  } finally {
    observation.mockRestore()
  }
})
