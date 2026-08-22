// @vitest-environment node

import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { LocalAccessError } from './localAccess.mjs'
import { createLocalAccessHttpHandler } from './localAccessHttp.mjs'

const request = (body: string, headers: Record<string, string> = {}) => Object.assign(Readable.from([body]), {
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
  it('issues only Console cookies after exact-Origin JSON verification', async () => {
    const verifier = vi.fn(async () => ({ cookie: 'session-cookie', csrfCookie: 'csrf-cookie', session: { kind: 'ConsoleSession' } }))
    const handler = createLocalAccessHttpHandler({ verifier, expectedOrigin: 'https://console.example' })
    const target = response()
    await handler({ request: request(JSON.stringify({ username: 'admin', password: 'secret', reason: 'Emergency provider recovery' })), response: target, pathname: '/api/console/v0/auth/local', correlationId: 'corr-1' })
    expect(verifier).toHaveBeenCalledWith({ username: 'admin', password: 'secret', reason: 'Emergency provider recovery', correlationId: 'corr-1' })
    expect(target.status).toBe(200)
    expect(target.headers?.['Set-Cookie']).toEqual(['session-cookie', 'csrf-cookie'])
    expect(JSON.stringify(target)).not.toContain('secret')
  })

  it('rejects origin and content type before reading credentials', async () => {
    const verifier = vi.fn()
    const handler = createLocalAccessHttpHandler({ verifier, expectedOrigin: 'https://console.example' })
    const hostile = request('{"password":"secret"}', { origin: 'https://evil.example' })
    const target = response()
    await handler({ request: hostile, response: target, pathname: '/api/console/v0/auth/local', correlationId: 'corr-2' })
    expect(target.status).toBe(403)
    expect(verifier).not.toHaveBeenCalled()
    expect(hostile.readableEnded).toBe(false)
  })

  it('bounds bodies and normalizes credential failures', async () => {
    const verifier = vi.fn(async () => { throw new LocalAccessError() })
    const handler = createLocalAccessHttpHandler({ verifier, expectedOrigin: 'https://console.example' })
    const oversized = response()
    await handler({ request: request('', { 'content-length': '20000' }), response: oversized, pathname: '/api/console/v0/auth/local', correlationId: 'corr-3' })
    expect(oversized.status).toBe(401)
    const denied = response()
    await handler({ request: request(JSON.stringify({ username: 'unknown', password: 'guess', reason: 'Emergency provider recovery' })), response: denied, pathname: '/api/console/v0/auth/local', correlationId: 'corr-4' })
    expect(denied.status).toBe(401)
    expect(denied.body).not.toContain('unknown')
    expect(denied.body).not.toContain('guess')
  })

  it('distinguishes a fail-closed dependency outage without exposing its cause', async () => {
    const verifier = vi.fn(async () => { throw new LocalAccessError('LOCAL_ACCESS_UNAVAILABLE') })
    const handler = createLocalAccessHttpHandler({ verifier, expectedOrigin: 'https://console.example' })
    const target = response()
    await handler({ request: request(JSON.stringify({ username: 'admin', password: 'secret', reason: 'Emergency provider recovery' })), response: target, pathname: '/api/console/v0/auth/local', correlationId: 'corr-5' })
    expect(target.status).toBe(503)
    expect(target.body).toContain('LOCAL_ACCESS_UNAVAILABLE')
    expect(target.body).not.toContain('database')
  })
})
