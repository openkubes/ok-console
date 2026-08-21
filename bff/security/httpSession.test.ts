// @vitest-environment node

import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FixtureObservedStateAdapter } from '../adapters/fixtureObservedState.mjs'
import { createConsoleBffHandler } from '../app.mjs'
import { CSRF_COOKIE, InMemorySessionStore, SESSION_COOKIE } from './session.mjs'

const subject = {
  id: 'subject-01K34',
  providerId: 'openkubes-identity',
  subjectId: 'issuer-subject-opaque-9f2',
  displayName: 'Arash Kaffamanesh',
  method: 'OIDC',
  assurance: ['pwd', 'mfa'],
}
const scope = { environmentId: 'community-preview', tenantIds: ['tenant-platform'] }
const permissions = ['platform.read', 'clusters.read', 'evidence.read']
const expectedOrigin = 'https://console.openkubes.example'

let server: Server
let baseUrl: string
let store: InMemorySessionStore

const cookieValue = (cookie: string, name: string) => cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`))?.[1]

beforeEach(async () => {
  store = new InMemorySessionStore({ now: () => new Date('2026-08-21T19:00:00Z') })
  server = createServer(createConsoleBffHandler({
    source: new FixtureObservedStateAdapter(),
    sessionStore: store,
    expectedOrigin,
    correlationId: () => 'corr-session-http',
  }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Session test server did not expose a TCP address.')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
})

describe('OK-163 Console session HTTP boundary', () => {
  it('returns only the browser-safe session projection for a valid cookie', async () => {
    const issued = store.create({ subject, scope, permissions })
    const response = await fetch(`${baseUrl}/api/console/v0/auth/session`, { headers: { Cookie: issued.cookie } })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ apiVersion: 'auth.console.openkubes.io/v0alpha1', kind: 'ConsoleSession' })
    expect(JSON.stringify(body)).not.toContain(subject.subjectId)
    expect(JSON.stringify(body)).not.toContain(issued.csrfToken)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('fails closed and clears both cookies for an invalid session', async () => {
    const response = await fetch(`${baseUrl}/api/console/v0/auth/session`, {
      headers: { Cookie: `${SESSION_COOKIE}=invalid` },
    })

    expect(response.status).toBe(401)
    expect(response.headers.getSetCookie()).toHaveLength(2)
    expect(response.headers.getSetCookie().join(';')).toContain(`${SESSION_COOKIE}=`)
    expect(response.headers.getSetCookie().join(';')).toContain(`${CSRF_COOKIE}=`)
  })

  it('requires exact Origin and the session-bound CSRF token before rotation', async () => {
    const issued = store.create({ subject, scope, permissions })
    const denied = await fetch(`${baseUrl}/api/console/v0/auth/session/rotate`, {
      method: 'POST',
      headers: { Cookie: issued.cookie, Origin: expectedOrigin },
    })
    expect(denied.status).toBe(403)
    expect(store.resolve(issued.cookie, { touch: false })).not.toBeNull()

    const wrongOrigin = await fetch(`${baseUrl}/api/console/v0/auth/session/rotate`, {
      method: 'POST',
      headers: { Cookie: issued.cookie, Origin: 'https://attacker.example', 'X-CSRF-Token': issued.csrfToken },
    })
    expect(wrongOrigin.status).toBe(403)
    expect(store.resolve(issued.cookie, { touch: false })).not.toBeNull()

    const response = await fetch(`${baseUrl}/api/console/v0/auth/session/rotate`, {
      method: 'POST',
      headers: { Cookie: issued.cookie, Origin: expectedOrigin, 'X-CSRF-Token': issued.csrfToken },
    })
    const cookies = response.headers.getSetCookie()

    expect(response.status).toBe(200)
    expect(cookies).toHaveLength(2)
    expect(store.resolve(issued.cookie, { touch: false })).toBeNull()
    expect(cookieValue(cookies.join('; '), SESSION_COOKIE)).toBeTruthy()
    expect(cookieValue(cookies.join('; '), CSRF_COOKIE)).toBeTruthy()
  })

  it('revokes a valid session and clears both cookies on logout', async () => {
    const issued = store.create({ subject, scope, permissions })
    const response = await fetch(`${baseUrl}/api/console/v0/auth/session`, {
      method: 'DELETE',
      headers: { Cookie: issued.cookie, Origin: expectedOrigin, 'X-CSRF-Token': issued.csrfToken },
    })

    expect(response.status).toBe(204)
    expect(response.headers.getSetCookie()).toHaveLength(2)
    expect(store.resolve(issued.cookie, { touch: false })).toBeNull()
  })

  it('does not expose an endpoint that creates an unauthenticated session', async () => {
    const response = await fetch(`${baseUrl}/api/console/v0/auth/session`, { method: 'POST' })
    const body = await response.json()

    expect(response.status).toBe(405)
    expect(body).toMatchObject({ kind: 'SecurityError', error: { code: 'METHOD_NOT_ALLOWED' } })
    expect(store.sessions.size).toBe(0)
  })

  it('fails closed when the runtime has no explicitly configured session store', async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    server = createServer(createConsoleBffHandler({
      source: new FixtureObservedStateAdapter(),
      correlationId: () => 'corr-no-session-store',
    }))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Session test server did not expose a TCP address.')
    baseUrl = `http://127.0.0.1:${address.port}`

    const response = await fetch(`${baseUrl}/api/console/v0/auth/session`)
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).toMatchObject({ kind: 'SecurityError', error: { code: 'SESSION_UNAVAILABLE' } })
  })
})
