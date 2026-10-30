// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import { PostgresOidcTransactionStore } from './oidcTransactionStore.mjs'
import { PostgresAuthenticationAudit } from './authenticationAudit.mjs'
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

    expect(await handler({ request: { method: 'GET', headers: {} }, response: target, pathname: '/api/console/v0/auth/oidc/start', correlationId: 'corr-00000000-0000-4000-8000-000000000000' })).toBe(true)
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
      correlationId: 'corr-00000000-0000-4000-8000-000000000000', pathname: '/api/console/v0/auth/oidc/callback',
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
    await handler({ request: { method: 'GET', url: '/callback', headers: {} }, response: target, correlationId: 'corr-00000000-0000-4000-8000-000000000000', pathname: '/api/console/v0/auth/oidc/callback' })
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
    await handler({ request: { method: 'GET', url: '/callback?code=code', headers: {} }, response: target, correlationId: 'corr-00000000-0000-4000-8000-000000000000', pathname: '/api/console/v0/auth/oidc/callback' })
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
    await handler({ request: { method: 'GET', url: '/callback?code=secret-code', headers: {} }, response: target, correlationId: 'corr-00000000-0000-4000-8000-000000000000', pathname: '/api/console/v0/auth/oidc/callback' })
    expect(target.result.status).toBe(401)
    expect(target.result.body).toContain('OIDC_CALLBACK_REJECTED')
    expect(JSON.stringify(target.result)).not.toContain('secret-code')
  })
})

it('logs an OIDC start failure with a closed stage tag and the server correlation ID', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const id = 'corr-12345678-1234-1234-1234-123456789abc'
  try {
    const handler = createOidcHttpHandler({ protocol: { codeVerifier: () => { throw Object.assign(new Error('private.example raw message'), { code: 'private code' }) } }, transactionStore: {}, sessionStore: {}, identityMapper: () => null, redirectUri: 'https://console.example/callback' })
    const target = response()
    await handler({ request: { method: 'GET', headers: {} }, response: target, pathname: '/api/console/v0/auth/oidc/start', correlationId: id })
    expect(target.result.status).toBe(503)
    expect(log).toHaveBeenCalledTimes(1)
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({ stage: 'REQUEST_RECEIVED', correlationId: id, event: 'OIDC_START_FAILED', cause: 'PKCE', errorCode: 'OTHER' })
  } finally { log.mockRestore() }
})


const startFailure = async (options: Record<string, unknown>) => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const handler = createOidcHttpHandler({
      protocol: { codeVerifier: () => 'verifier-123', state: () => 'state-123', nonce: () => 'nonce-123', challenge: async () => 'challenge', authorizationUrl: () => new URL('https://issuer.invalid/') },
      transactionStore: { create: async () => ({ cookie: 'cookie' }) }, sessionStore: {}, identityMapper: () => null, redirectUri: 'https://console.invalid/callback', ...options,
    })
    const target = response()
    await handler({ request: { method: 'GET', headers: {} }, response: target, pathname: '/api/console/v0/auth/oidc/start', correlationId: 'corr-00000000-0000-4000-8000-000000000000' })
    expect(target.result.status).toBe(503)
    expect(log).toHaveBeenCalledTimes(1)
    const line = log.mock.calls[0][0]
    expect(Buffer.byteLength(line)).toBeLessThan(2048)
    const event = JSON.parse(line)
    expect(Object.keys(event)).toEqual(['stage', 'correlationId', 'event', 'cause', 'errorCode'])
    expect(event).toMatchObject({ stage: 'REQUEST_RECEIVED', correlationId: 'corr-00000000-0000-4000-8000-000000000000', event: 'OIDC_START_FAILED' })
    expect(line).not.toContain('private')
    return event
  } finally { log.mockRestore() }
}

it('classifies real pg pool refusal by store and audit step with preserved own root code', async () => {
  const pool = new Pool({ host: '127.0.0.1', port: 1, user: 'x', database: 'x', connectionTimeoutMillis: 2000 })
  let root: Error & { code?: string }
  try {
    try { await pool.query('select 1'); throw new Error('Expected refused pool') } catch (error) { root = error as typeof root }
    expect(Object.getOwnPropertyDescriptor(root!, 'code')?.value).toBe('ECONNREFUSED')
    const rejectingPool = { query: async () => { throw root } }
    const store = new PostgresOidcTransactionStore({ pool: rejectingPool, codec: { encrypt: () => ({ ciphertext: 'cipher', keyId: 'key' }), decrypt: () => ({}) }, deploymentEpoch: 'epoch-123' })
    const audit = new PostgresAuthenticationAudit({ pool: rejectingPool, pepper: Buffer.alloc(32) })
    const storeEvent = await startFailure({ transactionStore: store })
    const auditEvent = await startFailure({ audit: (event: unknown) => audit.record(event) })
    expect(storeEvent).toMatchObject({ cause: 'TRANSACTION_STORE', errorCode: 'ECONNREFUSED' })
    expect(auditEvent).toMatchObject({ cause: 'AUDIT', errorCode: 'ECONNREFUSED' })
    expect(storeEvent).not.toEqual(auditEvent)
    console.info('D4_R7_PG ' + JSON.stringify({ ownCode: Object.getOwnPropertyDescriptor(root!, 'code')?.value, store: storeEvent, audit: auditEvent }))
    const urlEvent = await startFailure({ protocol: { codeVerifier: () => 'verifier-123', state: () => 'state-123', nonce: () => 'nonce-123', challenge: async () => 'challenge', authorizationUrl: () => new URL('private invalid URL') } })
    expect(urlEvent).toMatchObject({ cause: 'AUTHORIZATION_URL', errorCode: 'OTHER' })
  } finally { await pool.end() }
})

it.each(['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', '57P01', '53300', '28P01', 'private', null, 503, undefined])('bounds root OIDC errorCode %s through cause chains', async (code) => {
  const root = Object.assign(new Error('private'), code === undefined ? {} : { code })
  const error = new Error('private wrapper', { cause: new Error('private wrapper', { cause: root }) })
  expect(await startFailure({ protocol: { codeVerifier: () => { throw error } } })).toMatchObject({ cause: 'PKCE', errorCode: code === undefined ? null : typeof code === 'string' && code !== 'private' ? code : 'OTHER' })
})
it('ignores inherited OIDC codes and accessors and terminates cyclic causes', async () => {
  const cycle = { code: 'ENOTFOUND', cause: {} }; cycle.cause = cycle
  for (const error of [undefined, null, 42, Object.create({ code: 'ENOTFOUND' }), Object.defineProperties({}, { code: { get() { throw new Error('getter invoked') } }, cause: { get() { throw new Error('getter invoked') } } })]) {
    expect(await startFailure({ protocol: { codeVerifier: () => { throw error } } })).toMatchObject({ cause: 'PKCE', errorCode: null })
  }
  expect(await startFailure({ protocol: { codeVerifier: () => { throw cycle } } })).toMatchObject({ cause: 'PKCE', errorCode: 'ENOTFOUND' })
})
