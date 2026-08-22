import { describe, expect, it, vi } from 'vitest'
import { ConsoleAuthError, createConsoleAuthClient } from './authClient'

const session = {
  apiVersion: 'auth.console.openkubes.io/v0alpha1',
  kind: 'ConsoleSession',
  data: {
    subject: { displayName: 'Live User', provider: 'provider-1', method: 'OIDC', assurance: ['Federated', 'MFA'] },
    session: { absoluteExpiresAt: '2026-08-22T10:00:00Z' },
  },
}

describe('Console auth client', () => {
  it('restores only a compatible public Console session', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(session), { status: 200 }))
    const auth = createConsoleAuthClient({ mode: 'oidc', fetcher })

    await expect(auth.restoreSession()).resolves.toMatchObject({
      method: 'oidc', identity: 'Live User', source: 'provider-1', assurance: 'Federated · MFA',
    })
    expect(fetcher).toHaveBeenCalledWith('/api/console/v0/auth/session', expect.objectContaining({
      method: 'GET', credentials: 'same-origin',
    }))
  })

  it('treats an unauthenticated response as an empty session', async () => {
    const auth = createConsoleAuthClient({ mode: 'oidc', fetcher: async () => new Response(null, { status: 401 }) })
    await expect(auth.restoreSession()).resolves.toBeNull()
  })

  it('fails closed for an incompatible session projection', async () => {
    const auth = createConsoleAuthClient({ mode: 'oidc', fetcher: async () => new Response(JSON.stringify({ kind: 'ConsoleSession', data: {} }), { status: 200 }) })
    await expect(auth.restoreSession()).rejects.toBeInstanceOf(ConsoleAuthError)
  })

  it('starts OIDC only through the fixed same-origin endpoint', () => {
    const navigate = vi.fn()
    const live = createConsoleAuthClient({ mode: 'oidc', navigate })
    const prototype = createConsoleAuthClient({ mode: 'prototype', navigate })
    live.startOidc()
    prototype.startOidc()
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith('/api/console/v0/auth/oidc/start')
  })

  it('logs out with the readable session-bound CSRF value', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }))
    const auth = createConsoleAuthClient({
      mode: 'oidc', fetcher,
      readCookie: () => '__Host-ok_console_csrf=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    })
    await auth.logout()
    expect(fetcher).toHaveBeenCalledWith('/api/console/v0/auth/session', {
      method: 'DELETE', credentials: 'same-origin',
      headers: { 'X-CSRF-Token': 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
    })
  })

  it('does not send logout when the CSRF cookie is missing or duplicated', async () => {
    const fetcher = vi.fn()
    const auth = createConsoleAuthClient({
      mode: 'oidc', fetcher,
      readCookie: () => '__Host-ok_console_csrf=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA; __Host-ok_console_csrf=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    })
    await expect(auth.logout()).rejects.toBeInstanceOf(ConsoleAuthError)
    expect(fetcher).not.toHaveBeenCalled()
  })
})
