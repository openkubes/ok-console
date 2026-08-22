// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import { createOidcHttpHandler, createStaticOidcIdentityMapper } from './oidc.mjs'

const response = () => {
  const result: { status?: number, headers?: Record<string, unknown>, body?: string } = {}
  return {
    result,
    writeHead(status: number, headers: Record<string, unknown>) {
      result.status = status
      result.headers = headers
    },
    end(body?: string) { result.body = body },
  }
}

const transaction = { codeVerifier: 'verifier-123', state: 'state-123', nonce: 'nonce-123' }

describe('OIDC HTTP flow', () => {
  it('starts Authorization Code + PKCE with one-time server state', async () => {
    const create = vi.fn(async () => ({ cookie: '__Host-ok_console_oidc=reference; Secure; HttpOnly' }))
    const protocol = {
      codeVerifier: () => transaction.codeVerifier,
      state: () => transaction.state,
      nonce: () => transaction.nonce,
      challenge: vi.fn(async () => 'challenge-123'),
      authorizationUrl: vi.fn((parameters) => new URL(`https://id.example/authorize?${new URLSearchParams(parameters)}`)),
    }
    const handler = createOidcHttpHandler({
      protocol,
      transactionStore: { create },
      sessionStore: {},
      identityMapper: () => null,
      redirectUri: 'https://console.example/api/console/v0/auth/oidc/callback',
    })
    const target = response()

    expect(await handler({ request: { method: 'GET', headers: {} }, response: target, pathname: '/api/console/v0/auth/oidc/start' })).toBe(true)
    expect(create).toHaveBeenCalledWith(transaction)
    expect(protocol.challenge).toHaveBeenCalledWith(transaction.codeVerifier)
    expect(protocol.authorizationUrl).toHaveBeenCalledWith(expect.objectContaining({
      response_type: 'code', scope: 'openid', code_challenge_method: 'S256',
      state: transaction.state, nonce: transaction.nonce,
    }))
    expect(target.result).toMatchObject({ status: 302, headers: { Location: expect.stringContaining('https://id.example/authorize') } })
  })

  it('consumes state, validates the callback, maps identity and issues only Console cookies', async () => {
    const consume = vi.fn(async () => transaction)
    const exchange = vi.fn(async () => ({ sub: 'provider-subject-1', email: 'untrusted@example.test' }))
    const create = vi.fn(async () => ({
      cookie: '__Host-ok_console_session=opaque; Secure; HttpOnly',
      csrfCookie: '__Host-ok_console_csrf=csrf; Secure',
    }))
    const identityMapper = createStaticOidcIdentityMapper({
      providerId: 'provider-1', environmentId: 'prod', authorizationRevision: 'rbac-9',
      subjects: [{ providerSubject: 'provider-subject-1', identityId: 'user-1', displayName: 'Mapped User', assurance: ['Federated'], tenantIds: ['platform'], permissions: ['platform.read'] }],
    })
    const handler = createOidcHttpHandler({
      protocol: { exchange }, transactionStore: { consume }, sessionStore: { create }, identityMapper,
      redirectUri: 'https://console.example/api/console/v0/auth/oidc/callback', successRedirect: '/#/overview',
    })
    const target = response()
    const cookie = '__Host-ok_console_oidc=transaction-reference-value-with-40-chars-1234'

    await handler({
      request: { method: 'GET', url: '/api/console/v0/auth/oidc/callback?code=secret-code&state=state-123', headers: { cookie } },
      response: target,
      pathname: '/api/console/v0/auth/oidc/callback',
    })

    expect(consume).toHaveBeenCalledWith(cookie)
    expect(exchange).toHaveBeenCalledWith(expect.any(URL), {
      pkceCodeVerifier: transaction.codeVerifier,
      expectedState: transaction.state,
      expectedNonce: transaction.nonce,
    })
    expect((exchange.mock.calls[0][0] as URL).origin).toBe('https://console.example')
    expect(create).toHaveBeenCalledWith({
      subject: { id: 'user-1', providerId: 'provider-1', subjectId: 'provider-subject-1', displayName: 'Mapped User', method: 'OIDC', assurance: ['Federated'] },
      scope: { environmentId: 'prod', tenantIds: ['platform'] },
      permissions: ['platform.read'], authorizationRevision: 'rbac-9',
    })
    expect(target.result.status).toBe(303)
    expect(target.result.headers?.Location).toBe('/#/overview')
    expect(JSON.stringify(target.result)).not.toContain('secret-code')
    expect(JSON.stringify(target.result)).not.toContain('untrusted@example.test')
  })

  it('fails closed for a missing or replayed one-time transaction', async () => {
    const target = response()
    const handler = createOidcHttpHandler({
      protocol: { exchange: vi.fn() },
      transactionStore: { consume: async () => null },
      sessionStore: { create: vi.fn() }, identityMapper: vi.fn(),
      redirectUri: 'https://console.example/api/console/v0/auth/oidc/callback',
    })
    await handler({ request: { method: 'GET', url: '/callback', headers: {} }, response: target, pathname: '/api/console/v0/auth/oidc/callback' })
    expect(target.result.status).toBe(401)
    expect(target.result.body).toContain('OIDC_TRANSACTION_INVALID')
  })

  it('consumes the transaction but creates no session for an unmapped subject', async () => {
    const create = vi.fn()
    const target = response()
    const handler = createOidcHttpHandler({
      protocol: { exchange: async () => ({ sub: 'unknown-subject' }) },
      transactionStore: { consume: async () => transaction },
      sessionStore: { create }, identityMapper: async () => null,
      redirectUri: 'https://console.example/api/console/v0/auth/oidc/callback',
    })
    await handler({ request: { method: 'GET', url: '/callback?code=code', headers: {} }, response: target, pathname: '/api/console/v0/auth/oidc/callback' })
    expect(target.result.status).toBe(403)
    expect(target.result.body).toContain('OIDC_SUBJECT_UNMAPPED')
    expect(create).not.toHaveBeenCalled()
  })

  it('normalizes protocol failures without leaking authorization material', async () => {
    const target = response()
    const handler = createOidcHttpHandler({
      protocol: { exchange: async () => { throw new Error('secret-code provider detail') } },
      transactionStore: { consume: async () => transaction },
      sessionStore: { create: vi.fn() }, identityMapper: vi.fn(),
      redirectUri: 'https://console.example/api/console/v0/auth/oidc/callback',
    })
    await handler({ request: { method: 'GET', url: '/callback?code=secret-code', headers: {} }, response: target, pathname: '/api/console/v0/auth/oidc/callback' })
    expect(target.result.status).toBe(401)
    expect(target.result.body).toContain('OIDC_CALLBACK_REJECTED')
    expect(JSON.stringify(target.result)).not.toContain('secret-code')
  })
})
