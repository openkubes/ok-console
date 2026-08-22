import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import type { ConsoleAuthClient } from './auth/authClient'

const renderSignedIn = async () => {
  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: /Continue with OpenKubes Identity/i }))
  fireEvent.click(screen.getByRole('button', { name: /Simulate identity provider return/i }))
  expect(await screen.findByRole('heading', { name: 'Identity verified' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /Enter Console/i }))
  await screen.findByRole('button', { name: /Sign out of OpenKubes Console/i })
}

describe('OpenKubes Console', () => {
  beforeEach(() => { window.location.hash = '#/overview' })

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
    const authorize = screen.getByRole('button', { name: /Authorize prototype/i })
    expect(authorize).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox'))
    await waitFor(() => expect(authorize).toBeEnabled())
  })

  it('opens a cluster-scoped shell and blocks mutating commands', async () => {
    window.location.hash = '#/clusters'
    await renderSignedIn()
    await screen.findByRole('heading', { name: 'Clusters' })
    fireEvent.click(screen.getByRole('button', { name: 'Open ok-mgmt' }))
    fireEvent.click(await screen.findByRole('button', { name: /Open Shell/i }))

    expect(await screen.findByRole('heading', { name: 'Shell · ok-mgmt' })).toBeInTheDocument()
    expect(screen.getByText(/No credential, kubeconfig, WebSocket, or backend connection/i)).toBeInTheDocument()

    const input = screen.getByPlaceholderText(/read-only command or ask why/i)
    fireEvent.change(input, { target: { value: 'kubectl delete node ok-mgmt-cp-01' } })
    fireEvent.click(screen.getByRole('button', { name: /^Run$/ }))
    expect(await screen.findByText(/BLOCKED · This read-only prototype/i)).toBeInTheDocument()

    fireEvent.change(input, { target: { value: 'why is this cluster ready?' } })
    fireEvent.click(screen.getByRole('button', { name: /^Run$/ }))
    expect(await screen.findByText(/explanation resolves to the observed contract revision/i)).toBeInTheDocument()
    expect(screen.getByText(/Suggested read-only command/i)).toBeInTheDocument()
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
