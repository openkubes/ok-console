// @vitest-environment node

import { createServer, request as httpRequest } from 'node:http'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { validateAuthenticationAuditEvent } from './authenticationAudit.mjs'
import { handleSessionHttp } from './httpSession.mjs'
import { deliverIssuedSession } from './issuedSession.mjs'
import { createLocalAccessVerifier } from './localAccess.mjs'
import { createLocalAccessHttpHandler } from './localAccessHttp.mjs'
import { createLocalIdentityHttp } from './localIdentityHttp.mjs'
import { createOidcHttpHandler } from './oidc.mjs'
import { InMemorySessionStore } from './session.mjs'

const ORIGIN = 'https://console.example'
const correlationId = 'corr-00000000-0000-4000-8000-000000000001'

// A response whose first write fails, as when the socket or headers cannot be written.
// `failAt: 'end'` fails after the status line was committed (headersSent).
const failingResponse = (failAt: 'writeHead' | 'end' = 'writeHead') => {
  const writes: Array<{ status: number, headers: Record<string, unknown> }> = []
  let failed = false
  const target = {
    writes, headersSent: false, destroyed: false, body: undefined as string | undefined,
    writeHead(status: number, headers: Record<string, unknown>) {
      if (target.headersSent) throw Object.assign(new Error('headers already sent'), { code: 'ERR_HTTP_HEADERS_SENT' })
      if (!failed && failAt === 'writeHead') { failed = true; throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) }
      writes.push({ status, headers })
      target.headersSent = true
    },
    end(body?: string) {
      if (!failed && failAt === 'end') { failed = true; throw Object.assign(new Error('write after destroy'), { code: 'ERR_STREAM_DESTROYED' }) }
      target.body = body
    },
    destroy() { target.destroyed = true },
  }
  return target
}
const requestCookie = (setCookie: string) => setCookie.split(';')[0]
const subject = (method: string) => ({ id: 'user-1', providerId: 'p', subjectId: 's', displayName: 'User', method, assurance: ['Password'] })
const sessionInput = (method: string) => ({ subject: subject(method), scope: { environmentId: 'prod', tenantIds: ['platform'] }, permissions: ['platform.read'], authorizationRevision: 'rbac-1' })

let errors: ReturnType<typeof vi.spyOn>
beforeEach(() => { errors = vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { errors.mockRestore() })

describe('deliverIssuedSession', () => {
  const setup = (overrides: Record<string, unknown> = {}) => {
    const calls: string[] = []
    const response = { headersSent: false, destroy: vi.fn(() => calls.push('destroy')) }
    const options = {
      response,
      write: vi.fn(() => { calls.push('write'); throw new Error('write failed') }),
      revoke: vi.fn(async () => { calls.push('revoke'); return true }),
      audit: vi.fn(async () => { calls.push('audit') }),
      unavailable: vi.fn(() => { calls.push('unavailable') }),
      log: vi.fn(),
      ...overrides,
    }
    return { options, calls, response }
  }

  it('does nothing beyond the write when the response is written', async () => {
    const { options, calls } = setup({ write: vi.fn(() => {}) })
    await expect(deliverIssuedSession(options)).resolves.toBe(true)
    expect(calls).toEqual([])
  })

  it('revokes, then audits the revocation, then answers unavailable', async () => {
    const { options, calls } = setup()
    await expect(deliverIssuedSession(options)).resolves.toBe(false)
    expect(calls).toEqual(['write', 'revoke', 'audit', 'unavailable'])
  })

  it.each([
    ['revoke reports nothing revoked', async () => false],
    ['revoke throws', async () => { throw new Error('store down') }],
  ])('never audits a revocation that did not happen: %s', async (_name, revoke) => {
    const { options, calls } = setup({ revoke: vi.fn(revoke) })
    await deliverIssuedSession(options)
    expect(calls).toEqual(['write', 'unavailable'])
    expect(options.log.mock.calls.map(([cause]) => cause)).toEqual(['RESPONSE_WRITE', 'RESPONSE_WRITE_REVOKE'])
  })

  it('still answers unavailable when the revocation audit fails', async () => {
    const { options, calls } = setup({ audit: vi.fn(async () => { throw new Error('audit down') }) })
    await deliverIssuedSession(options)
    expect(calls).toEqual(['write', 'revoke', 'unavailable'])
    expect(options.log).toHaveBeenCalledWith('RESPONSE_WRITE_AUDIT', expect.any(Error))
  })

  it('drops the connection when the status line already went out, or the fallback write fails', async () => {
    const sent = setup()
    sent.response.headersSent = true
    await deliverIssuedSession(sent.options)
    expect(sent.calls).toEqual(['write', 'revoke', 'audit', 'destroy'])
    const broken = setup({ unavailable: vi.fn(() => { throw new Error('still broken') }) })
    await deliverIssuedSession(broken.options)
    expect(broken.calls).toEqual(['write', 'revoke', 'audit', 'destroy'])
  })
})

describe('a session issued as Granted is never answered as a rejected credential', () => {
  it('exceptional local access: 503, session revoked, revocation audited', async () => {
    const sessions = new InMemorySessionStore()
    const account = { username: 'recovery-admin', enabled: true, salt: Buffer.alloc(16, 1).toString('base64'), verifier: Buffer.alloc(32, 2).toString('base64'), identityId: 'local-1', displayName: 'Recovery Admin', environmentId: 'prod', tenantIds: ['platform'], permissions: ['platform.read'] }
    const verifierAudit = vi.fn(async () => {})
    const issued: string[] = []
    const verifier = createLocalAccessVerifier({
      mode: 'BreakGlass', accounts: [account], authorizationRevision: 'rbac-1', audit: verifierAudit,
      throttle: { reserve: async () => ({ blocked: false }), success: async () => ({ refused: false }) },
      sessionStore: { create: (input: never) => { const result = sessions.create(input); issued.push(result.cookie); return result } },
      derive: async () => Buffer.alloc(32, 2),
    })
    const audit = vi.fn(async () => {})
    const revoke = vi.fn(async (cookie: string) => sessions.revoke(requestCookie(cookie)))
    const handler = createLocalAccessHttpHandler({ method: 'BreakGlass', verifier, expectedOrigin: ORIGIN, audit, revoke })
    const response = failingResponse()
    const request = Object.assign(Readable.from([JSON.stringify({ username: 'recovery-admin', password: 'secret', reason: 'OIDC provider recovery' })]), {
      method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' },
    })
    await handler({ request, response, pathname: '/api/console/v0/auth/local', correlationId })
    expect(verifierAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'Granted' }))
    expect(response.writes.map((write) => write.status)).toEqual([503])
    expect(JSON.parse(response.body!).error.code).toBe('LOCAL_ACCESS_UNAVAILABLE')
    expect(response.writes[0].headers['Set-Cookie']).toBeUndefined()
    expect(revoke).toHaveBeenCalledWith(issued[0], 'RESPONSE_FAILED')
    expect(sessions.resolve(requestCookie(issued[0]))).toBeNull()
    const event = { method: 'BreakGlass', outcome: 'Revoked', cause: 'RESPONSE_FAILED', correlationId, reason: 'Issued session withdrawn after a response failure' }
    expect(audit.mock.calls).toEqual([[event]])
    expect(validateAuthenticationAuditEvent(event)).toEqual(event)
  })

  it.each(['writeHead', 'end'] as const)('ordinary local login (failure at %s): never 401, session revoked, revocation audited', async (failAt) => {
    const sessions = new InMemorySessionStore()
    let issued: { cookie: string } | undefined
    const identity = { login: vi.fn(async () => { issued = sessions.create(sessionInput('Local')); return issued }) }
    const audit = vi.fn(async () => {})
    const handler = createLocalIdentityHttp({ identity, sessions, expectedOrigin: ORIGIN, audit })
    const response = failingResponse(failAt)
    const request = Object.assign(Readable.from([Buffer.from(JSON.stringify({ username: 'admin-one', password: 'correct horse battery staple' }))]), {
      method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' },
    })
    await handler({ request, response, pathname: '/api/console/v0/local-identity/login', correlationId })
    if (failAt === 'writeHead') expect(response.writes.map((write) => write.status)).toEqual([503])
    else {
      expect(response.writes.map((write) => write.status)).toEqual([200])
      expect(response.destroyed).toBe(true)
    }
    expect(sessions.resolve(requestCookie(issued!.cookie))).toBeNull()
    expect(audit).toHaveBeenCalledExactlyOnceWith({ method: 'Local', outcome: 'Revoked', cause: 'RESPONSE_FAILED', correlationId, reason: 'Issued session withdrawn after a response failure' })
  })

  it('OIDC callback: never Denied/401 after Granted; session revoked, revocation audited', async () => {
    const sessions = new InMemorySessionStore()
    let issued: { cookie: string } | undefined
    const audit = vi.fn(async () => {})
    const handler = createOidcHttpHandler({
      protocol: { exchange: async () => ({ sub: 'provider-subject-1' }) },
      transactionStore: { consume: async () => ({ codeVerifier: 'v', state: 'state-123', nonce: 'n' }) },
      sessionStore: { create: (input: never) => { issued = sessions.create(input); return issued }, revoke: async (cookie: string) => sessions.revoke(requestCookie(cookie)) },
      identityMapper: async () => sessionInput('OIDC'),
      redirectUri: `${ORIGIN}/api/console/v0/auth/oidc/callback`, audit,
    })
    const response = failingResponse()
    await handler({
      request: { method: 'GET', url: '/api/console/v0/auth/oidc/callback?code=c&state=state-123', headers: { cookie: '__Host-ok_console_oidc=transaction-reference-value-with-40-chars-1234' } },
      response, correlationId, pathname: '/api/console/v0/auth/oidc/callback',
    })
    expect(audit.mock.calls.map(([event]) => `${event.outcome}/${event.cause}`)).toEqual(['Granted/VERIFIED', 'Revoked/RESPONSE_FAILED'])
    expect(response.writes.map((write) => write.status)).toEqual([503])
    expect(sessions.resolve(requestCookie(issued!.cookie))).toBeNull()
  })

  it('session rotation: the rotated session is revoked and the client gets 503', async () => {
    const sessions = new InMemorySessionStore()
    const original = sessions.create(sessionInput('OIDC'))
    const csrf = requestCookie(original.csrfCookie).split('=').slice(1).join('=')
    const rotate = sessions.rotate.bind(sessions)
    let rotated: { cookie: string } | undefined
    sessions.rotate = (cookie: string) => { rotated = rotate(cookie); return rotated }
    const audit = vi.fn(async () => {})
    const response = failingResponse()
    await handleSessionHttp({
      request: { method: 'POST', headers: { cookie: requestCookie(original.cookie), origin: ORIGIN, 'x-csrf-token': csrf } },
      response, pathname: '/api/console/v0/auth/session/rotate', correlationId, sessionStore: sessions, expectedOrigin: ORIGIN, audit,
    })
    expect(rotated).toBeDefined()
    expect(audit.mock.calls.map(([event]) => `${event.outcome}/${event.cause}`)).toEqual(['Rotated/VERIFIED', 'Revoked/RESPONSE_FAILED'])
    expect(response.writes.map((write) => write.status)).toEqual([503])
    expect(sessions.resolve(requestCookie(rotated!.cookie))).toBeNull()
  })

  it('a client that disconnects during verification: session revoked, revocation audited, nothing written', async () => {
    const sessions = new InMemorySessionStore()
    let issued: { cookie: string } | undefined
    let releaseVerifier!: () => void
    const verifierGate = new Promise<void>((resolve) => { releaseVerifier = resolve })
    const verifier = async () => {
      await verifierGate
      issued = sessions.create(sessionInput('BreakGlass'))
      return issued
    }
    const audit = vi.fn(async () => {})
    const revoke = vi.fn(async (cookie: string) => sessions.revoke(cookie))
    const handler = createLocalAccessHttpHandler({ method: 'BreakGlass', verifier, expectedOrigin: ORIGIN, audit, revoke })
    let handled!: Promise<unknown>
    let closed!: () => void
    const serverSawClose = new Promise<void>((resolve) => { closed = resolve })
    const server = createServer((request, response) => {
      response.once('close', () => closed())
      handled = handler({ request, response, pathname: '/api/console/v0/auth/local', correlationId })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = server.address() as { port: number }
      const body = JSON.stringify({ username: 'recovery-admin', password: 'secret', reason: 'OIDC provider recovery' })
      const client = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/api/console/v0/auth/local', headers: { origin: ORIGIN, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } })
      client.on('error', () => {})
      client.end(body)
      await vi.waitFor(() => expect(handled).toBeDefined())
      client.destroy()
      await serverSawClose
      releaseVerifier()
      await handled
    } finally { server.close() }
    expect(revoke).toHaveBeenCalledWith(issued!.cookie, 'RESPONSE_FAILED')
    expect(sessions.resolve(requestCookie(issued!.cookie))).toBeNull()
    expect(audit).toHaveBeenCalledExactlyOnceWith({ method: 'BreakGlass', outcome: 'Revoked', cause: 'RESPONSE_FAILED', correlationId, reason: 'Issued session withdrawn after a response failure' })
  })

  it('a delivered response over a real socket is not withdrawn', async () => {
    const sessions = new InMemorySessionStore()
    const revoke = vi.fn(async () => true)
    const audit = vi.fn(async () => {})
    const handler = createLocalAccessHttpHandler({ method: 'BreakGlass', verifier: async () => sessions.create(sessionInput('BreakGlass')), expectedOrigin: ORIGIN, audit, revoke })
    const server = createServer((request, response) => { void handler({ request, response, pathname: '/api/console/v0/auth/local', correlationId }) })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = server.address() as { port: number }
      const response = await fetch(`http://127.0.0.1:${port}/api/console/v0/auth/local`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'recovery-admin', password: 'secret', reason: 'OIDC provider recovery' }) })
      expect(response.status).toBe(200)
      await response.text()
    } finally { server.close() }
    expect(revoke).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
  })
})
