import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import AuthEntry, { type PrototypeSession } from './AuthEntry'
import type { AuthMode } from './authClient'

const session: PrototypeSession = { method: 'local', identity: 'reader', source: 'Ordinary local account', assurance: 'Password', expiresIn: '15 minutes' }

describe('shared branded login shell', () => {
  it.each<AuthMode>(['prototype', 'oidc', 'bootstrap', 'breakglass', 'local'])('preserves branding and one login landmark in %s mode', (mode) => {
    const { container } = render(<AuthEntry authMode={mode} onAuthenticated={vi.fn()}/>)
    expect(screen.getAllByRole('main')).toHaveLength(1)
    expect(screen.getByRole('heading', { name: /Contracts.*Clusters.*Evidence/ })).toBeInTheDocument()
    expect(screen.getByAltText('OpenKubes')).toHaveAttribute('src', './openkubes-icon.png')
    expect(container.querySelectorAll('.auth-story')).toHaveLength(1)
    expect(container.querySelectorAll('.auth-card')).toHaveLength(1)
    expect(container.querySelector('.auth-panel-footer')).toHaveTextContent('PrivacySecurityOpenKubes')
  })

  it.each<{mode: AuthMode; providers: number; exceptional: boolean}>([
    { mode: 'local', providers: 0, exceptional: false },
    { mode: 'oidc', providers: 1, exceptional: false },
    { mode: 'bootstrap', providers: 0, exceptional: true },
    { mode: 'breakglass', providers: 1, exceptional: true },
    { mode: 'prototype', providers: 2, exceptional: true },
  ])('exposes only configured methods in $mode mode', ({mode, providers, exceptional}) => {
    render(<AuthEntry authMode={mode} onAuthenticated={vi.fn()}/>)
    expect(screen.queryAllByRole('button', { name: /Continue with/ })).toHaveLength(providers)
    expect(screen.queryAllByRole('button', { name: /Use a local account/ })).toHaveLength(exceptional ? 1 : 0)
    expect(screen.queryByRole('button', { name: /Local account not enabled/ })).not.toBeInTheDocument()
    expect(screen.queryAllByRole('button', { name: 'Sign in' })).toHaveLength(mode === 'local' ? 1 : 0)
  })

  it('keeps ordinary local login distinct from exceptional access and federation', () => {
    render(<AuthEntry authMode="local" onAuthenticated={vi.fn()}/>)
    expect(screen.getByText('Local authentication')).toBeInTheDocument()
    expect(screen.getByText(/password authentication without MFA/)).toBeInTheDocument()
    expect(screen.queryByText('Federated by default')).not.toBeInTheDocument()
    expect(screen.queryByText('Exceptional access')).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/Operational reason/)).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Username')).toHaveAttribute('autocomplete', 'username')
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password')
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password')
  })

  it.each(['bootstrap', 'breakglass'] as const)('retains the separate reason/acknowledgement guard for %s', (mode) => {
    render(<AuthEntry authMode={mode} onAuthenticated={vi.fn()}/>)
    const entry = screen.getByRole('button', { name: /Use a local account/ })
    expect(entry).toHaveTextContent(mode === 'bootstrap' ? 'Bootstrap only' : 'Break-glass only')
    fireEvent.click(entry)
    expect(screen.getByLabelText(/Operational reason/)).toHaveAttribute('minlength', '12')
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Authenticate and enter Console' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument()
  })

  it('retains the explicit prototype simulation boundary', () => {
    render(<AuthEntry onAuthenticated={vi.fn()}/>)
    expect(screen.getByText('Prototype · no live auth')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Continue with OpenKubes Identity/ }))
    expect(screen.getByRole('button', { name: 'Simulate identity provider return' })).toBeInTheDocument()
    expect(screen.getByText(/Simulation only/)).toBeInTheDocument()
  })

  it('preserves local callback arguments, pending protection and credential clearing', async () => {
    let resolveLogin!: (value: PrototypeSession) => void
    const login = vi.fn(() => new Promise<PrototypeSession>(resolve => { resolveLogin = resolve }))
    const authenticated = vi.fn()
    render(<AuthEntry authMode="local" onAuthenticated={authenticated} onAuthenticateLocal={login}/>)
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'reader' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'test-only-password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled()
    expect(login).toHaveBeenCalledExactlyOnceWith({ username: 'reader', password: 'test-only-password', reason: '' })
    expect(authenticated).not.toHaveBeenCalled()
    await act(async () => { resolveLogin(session) })
    await waitFor(() => expect(authenticated).toHaveBeenCalledWith(session))
    expect(screen.getByLabelText('Password')).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled()
  })

  it('uses the existing session retry callback inside the shared local layout', () => {
    const retry = vi.fn()
    render(<AuthEntry authMode="local" onAuthenticated={vi.fn()} serviceError="The authentication service is unavailable." onRetry={retry}/>)
    expect(screen.getByRole('alert')).toHaveTextContent('The authentication service is unavailable.')
    fireEvent.click(screen.getByRole('button', { name: 'Retry session check' }))
    expect(retry).toHaveBeenCalledOnce()
  })
})
