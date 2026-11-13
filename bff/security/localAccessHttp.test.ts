// @vitest-environment node

import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { createLocalAccessVerifier, LocalAccessError } from './localAccess.mjs'
import { validateAuthenticationAuditEvent } from './authenticationAudit.mjs'
import { createLocalAccessHttpHandler } from './localAccessHttp.mjs'

const request = (body: string, headers: Record<string, string | undefined> = {}) => Object.assign(Readable.from([body]), {
  method: 'POST', url: '/api/console/v0/auth/local', headers: {
    origin: 'https://console.example', 'content-type': 'application/json', ...headers,
  },
})

const response = () => {
  const result: { status?: number, headers?: Record<string, unknown>, body?: string } = {}
  return Object.assign(result, {
    writeHead(status: number, headers: Record<string, unknown>) { result.status = status; result.headers = headers },
    end(body?: string) { result.body = body },
  })
}

describe('exceptional local-access HTTP boundary', () => {
  const correlationId = 'corr-00000000-0000-4000-8000-000000000001'
  const cases = [
    { name: 'wrong origin', body: '{}', headers: { origin: 'https://evil.example' }, status: 403, code: 'ORIGIN_REJECTED', cause: 'ORIGIN_REJECTED' },
    { name: 'missing origin', body: '{}', headers: { origin: undefined }, status: 403, code: 'ORIGIN_REJECTED', cause: 'ORIGIN_REJECTED' },
    { name: 'wrong content type', body: '{}', headers: { 'content-type': 'text/plain' }, status: 415, code: 'CONTENT_TYPE_REJECTED', cause: 'CONTENT_TYPE_REJECTED' },
    { name: 'missing content type', body: '{}', headers: { 'content-type': undefined }, status: 415, code: 'CONTENT_TYPE_REJECTED', cause: 'CONTENT_TYPE_REJECTED' },
    { name: 'declared oversize', body: '{}', headers: { 'content-length': '16385' }, status: 401, code: 'LOCAL_ACCESS_REJECTED', cause: 'REQUEST_INVALID' },
    { name: 'streamed oversize', body: 'x'.repeat(16385), status: 401, code: 'LOCAL_ACCESS_REJECTED', cause: 'REQUEST_INVALID' },
    { name: 'invalid JSON', body: '{', status: 401, code: 'LOCAL_ACCESS_REJECTED', cause: 'REQUEST_INVALID' },
    ...['null', '[]', '"string"', '42', 'true'].map(body => ({ name: `non-object JSON ${body}`, body, status: 401, code: 'LOCAL_ACCESS_REJECTED', cause: 'REQUEST_INVALID' })),
  ]

  it.each(cases)('audits $name exactly once before responding', async ({ body, headers, status, code, cause }) => {
    let complete!: () => void
    const audit = vi.fn(() => new Promise<void>(resolve => { complete = resolve }))
    const verifier = vi.fn()
    const handler = createLocalAccessHttpHandler({ verifier, expectedOrigin: 'https://console.example', audit })
    const target = response()
    const pending = handler({ request: request(body, headers), response: target, pathname: '/api/console/v0/auth/local', correlationId })
    await vi.waitFor(() => expect(audit).toHaveBeenCalledTimes(1))
    expect(target.status).toBeUndefined()
    const expected = { method: 'Local', outcome: 'Denied', cause, correlationId, reason: 'Rejected before credential verification' }
    expect(audit.mock.calls[0]).toEqual([expected])
    expect(validateAuthenticationAuditEvent(expected)).toEqual(expected)
    complete()
    await pending
    expect(audit).toHaveBeenCalledTimes(1)
    expect(target.status).toBe(status)
    expect(JSON.parse(target.body!).error.code).toBe(code)
    expect(target.headers?.['Set-Cookie']).toBeUndefined()
    expect(verifier).not.toHaveBeenCalled()
  })

  it.each(cases)('fails closed when audit rejects for $name', async ({ body, headers }) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const audit = vi.fn(async () => { throw new Error('password=hunter2-MARKER') })
      const verifier = vi.fn()
      const handler = createLocalAccessHttpHandler({ verifier, expectedOrigin: 'https://console.example', audit })
      const target = response()
      await handler({ request: request(body, headers), response: target, pathname: '/api/console/v0/auth/local', correlationId })
      expect(target.status).toBe(503)
      expect(JSON.parse(target.body!).error.code).toBe('LOCAL_ACCESS_UNAVAILABLE')
      expect(target.headers?.['Set-Cookie']).toBeUndefined()
      expect(audit).toHaveBeenCalledTimes(1)
      expect(verifier).not.toHaveBeenCalled()
      expect(log).toHaveBeenCalledTimes(1)
      expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ event: 'LOCAL_ACCESS_FAILED', cause: 'AUDIT', correlationId })
      expect(JSON.stringify([target, log.mock.calls])).not.toContain('MARKER')
    } finally { log.mockRestore() }
  })

  it.each([
    { body: 'password=hunter2-MARKER', headers: { origin: 'Bearer MARKER' } },
    { body: 'password=hunter2-MARKER', headers: { 'content-type': 'Bearer MARKER' } },
    { body: 'password=hunter2-MARKER', headers: {} },
  ])('keeps request markers out of audit, responses and logs: $headers', async ({ body, headers }) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const audit = vi.fn()
      const verifier = vi.fn()
      const handler = createLocalAccessHttpHandler({ verifier, expectedOrigin: 'https://console.example', audit })
      const target = response()
      await handler({ request: request(body, headers), response: target, pathname: '/api/console/v0/auth/local', correlationId })
      expect(audit).toHaveBeenCalledTimes(1)
      expect(verifier).not.toHaveBeenCalled()
      expect(JSON.stringify([audit.mock.calls, target.body, error.mock.calls, log.mock.calls])).not.toContain('MARKER')
    } finally { error.mockRestore(); log.mockRestore() }
  })

  it('does not audit non-matching paths or non-POST requests', async () => {
    const audit = vi.fn(), verifier = vi.fn()
    const handler = createLocalAccessHttpHandler({ verifier, expectedOrigin: 'https://console.example', audit })
    const target = response()
    expect(await handler({ request: request('{}'), response: target, pathname: '/other', correlationId })).toBe(false)
    expect(target.status).toBeUndefined()
    const input = request('{}'); input.method = 'GET'
    await handler({ request: input, response: target, pathname: '/api/console/v0/auth/local', correlationId })
    expect(target.status).toBe(405)
    expect(audit).not.toHaveBeenCalled()
    expect(verifier).not.toHaveBeenCalled()
  })

  it.each([undefined, null, {}, 'audit'])('requires an audit function at construction: %s', audit => {
    expect(() => createLocalAccessHttpHandler({ verifier: vi.fn(), expectedOrigin: 'https://console.example', audit })).toThrow()
  })

  it('issues only Console cookies after exact-Origin JSON verification', async () => {
    const verifier = vi.fn(async () => ({ cookie: 'session-cookie', csrfCookie: 'csrf-cookie', session: { kind: 'ConsoleSession' } }))
    const audit = vi.fn()
    const handler = createLocalAccessHttpHandler({ audit, verifier, expectedOrigin: 'https://console.example' })
    const target = response()
    await handler({ request: request(JSON.stringify({ username: 'admin', password: 'secret', reason: 'Emergency provider recovery' })), response: target, pathname: '/api/console/v0/auth/local', correlationId: 'corr-1' })
    expect(verifier).toHaveBeenCalledTimes(1)
    expect(audit).not.toHaveBeenCalled()
    expect(verifier).toHaveBeenCalledWith({ username: 'admin', password: 'secret', reason: 'Emergency provider recovery', correlationId: 'corr-1' })
    expect(target.status).toBe(200)
    expect(target.headers?.['Set-Cookie']).toEqual(['session-cookie', 'csrf-cookie'])
    expect(JSON.stringify(target)).not.toContain('secret')
  })

  it('rejects origin and content type before reading credentials', async () => {
    const verifier = vi.fn()
    const handler = createLocalAccessHttpHandler({ audit: vi.fn(), verifier, expectedOrigin: 'https://console.example' })
    const hostile = request('{"password":"secret"}', { origin: 'https://evil.example' })
    const target = response()
    await handler({ request: hostile, response: target, pathname: '/api/console/v0/auth/local', correlationId: 'corr-2' })
    expect(target.status).toBe(403)
    expect(verifier).not.toHaveBeenCalled()
    expect(hostile.readableEnded).toBe(false)
  })

  it('bounds bodies and normalizes credential failures', async () => {
    const verifier = vi.fn(async () => { throw new LocalAccessError() })
    const handler = createLocalAccessHttpHandler({ audit: vi.fn(), verifier, expectedOrigin: 'https://console.example' })
    const oversized = response()
    await handler({ request: request('', { 'content-length': '20000' }), response: oversized, pathname: '/api/console/v0/auth/local', correlationId: 'corr-3' })
    expect(oversized.status).toBe(401)
    const denied = response()
    await handler({ request: request(JSON.stringify({ username: 'unknown', password: 'guess', reason: 'Emergency provider recovery' })), response: denied, pathname: '/api/console/v0/auth/local', correlationId: 'corr-4' })
    expect(denied.status).toBe(401)
    expect(denied.body).not.toContain('unknown')
    expect(denied.body).not.toContain('guess')
  })

  it('reports an enabled-check outage as 503 with a bounded ENABLED_CHECK line', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const verifier = createLocalAccessVerifier({ mode: 'Bootstrap', accounts: [], throttle: {}, sessionStore: { create: vi.fn() },
        isEnabled: async () => { throw new Error('private enabled-check failure') } })
      const handler = createLocalAccessHttpHandler({ audit: vi.fn(), verifier, expectedOrigin: 'https://console.example' })
      const target = response()
      await handler({ request: request(JSON.stringify({ username: 'admin', password: 'secret', reason: 'Emergency provider recovery' })), response: target, pathname: '/api/console/v0/auth/local', correlationId: 'corr-00000000-0000-4000-8000-000000000001' })
      expect(target.status).toBe(503)
      expect(target.body).toContain('LOCAL_ACCESS_UNAVAILABLE')
      expect(log).toHaveBeenCalledTimes(1)
      expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ event: 'LOCAL_ACCESS_FAILED', cause: 'ENABLED_CHECK', correlationId: 'corr-00000000-0000-4000-8000-000000000001' })
      expect(JSON.stringify(log.mock.calls)).not.toContain('private enabled-check failure')
      expect(target.body).not.toContain('private enabled-check failure')
    } finally { log.mockRestore() }
  })

  it('distinguishes a fail-closed dependency outage without exposing its cause', async () => {
    const verifier = vi.fn(async () => { throw new LocalAccessError('LOCAL_ACCESS_UNAVAILABLE') })
    const handler = createLocalAccessHttpHandler({ audit: vi.fn(), verifier, expectedOrigin: 'https://console.example' })
    const target = response()
    await handler({ request: request(JSON.stringify({ username: 'admin', password: 'secret', reason: 'Emergency provider recovery' })), response: target, pathname: '/api/console/v0/auth/local', correlationId: 'corr-5' })
    expect(target.status).toBe(503)
    expect(target.body).toContain('LOCAL_ACCESS_UNAVAILABLE')
    expect(target.body).not.toContain('database')
  })
})
