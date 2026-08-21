// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { clearSessionCookie, InMemorySessionStore, readSessionCookie, SESSION_COOKIE, validateCsrf } from './session.mjs'

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
const deterministicRandom = (() => {
  let value = 0
  return (size: number) => Buffer.alloc(size, ++value)
})()

describe('OK-163 opaque server-side sessions', () => {
  it('issues a hardened opaque cookie and a browser-safe projection', () => {
    const store = new InMemorySessionStore({ now: () => new Date('2026-08-21T19:00:00Z'), random: deterministicRandom })
    const issued = store.create({ subject, scope, permissions })

    expect(issued.cookie).toContain(`${SESSION_COOKIE}=`)
    expect(issued.cookie).toContain('Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600')
    expect(issued.session).toMatchObject({ apiVersion: 'auth.console.openkubes.io/v0alpha1', kind: 'ConsoleSession' })
    const serialized = JSON.stringify(issued.session)
    expect(serialized).not.toContain(subject.subjectId)
    expect(serialized).not.toContain(issued.csrfToken)
    expect([...store.sessions.keys()][0]).not.toBe(readSessionCookie(issued.cookie))
  })

  it('rotates the session and CSRF token while invalidating the old cookie', () => {
    const store = new InMemorySessionStore({ now: () => new Date('2026-08-21T19:00:00Z'), random: deterministicRandom })
    const issued = store.create({ subject, scope, permissions })
    const rotated = store.rotate(issued.cookie)

    expect(rotated).not.toBeNull()
    expect(rotated?.cookie).not.toBe(issued.cookie)
    expect(rotated?.csrfToken).not.toBe(issued.csrfToken)
    expect(store.resolve(issued.cookie)).toBeNull()
    expect(store.resolve(rotated?.cookie)).not.toBeNull()
  })

  it('enforces idle and absolute expiry without extending the absolute limit', () => {
    let current = new Date('2026-08-21T19:00:00Z')
    const store = new InMemorySessionStore({ now: () => current, random: deterministicRandom })
    const issued = store.create({ subject, scope, permissions })
    current = new Date('2026-08-21T19:14:00Z')
    const touched = store.resolve(issued.cookie)

    expect(touched?.session.idleExpiresAt).toBe('2026-08-21T19:29:00.000Z')
    current = new Date('2026-08-21T19:28:00Z')
    expect(store.resolve(issued.cookie)?.session.idleExpiresAt).toBe('2026-08-21T19:43:00.000Z')
    current = new Date('2026-08-21T19:42:00Z')
    expect(store.resolve(issued.cookie)?.session.idleExpiresAt).toBe('2026-08-21T19:57:00.000Z')
    current = new Date('2026-08-21T19:56:00Z')
    expect(store.resolve(issued.cookie)?.session.idleExpiresAt).toBe('2026-08-21T20:00:00.000Z')
    current = new Date('2026-08-21T20:00:00Z')
    expect(store.resolve(issued.cookie)).toBeNull()
  })

  it('revokes and clears sessions without exposing store or cookie material', () => {
    const store = new InMemorySessionStore({ now: () => new Date('2026-08-21T19:00:00Z'), random: deterministicRandom })
    const issued = store.create({ subject, scope, permissions })

    expect(store.revoke(issued.cookie)).toBe(true)
    expect(store.resolve(issued.cookie)).toBeNull()
    expect(clearSessionCookie()).toBe(`${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`)
  })

  it('rejects missing, malformed and duplicate cookie values', () => {
    const store = new InMemorySessionStore({ random: deterministicRandom })
    const issued = store.create({ subject, scope, permissions })
    const value = readSessionCookie(issued.cookie)

    expect(readSessionCookie(undefined)).toBeNull()
    expect(readSessionCookie(`${SESSION_COOKIE}=short`)).toBeNull()
    expect(readSessionCookie(`${SESSION_COOKIE}=${value}; ${SESSION_COOKIE}=${value}`)).toBeNull()
  })

  it('protects future mutations with exact origin and session-bound CSRF', () => {
    const store = new InMemorySessionStore({ now: () => new Date('2026-08-21T19:00:00Z'), random: deterministicRandom })
    const issued = store.create({ subject, scope, permissions })
    const context = store.resolve(issued.cookie, { touch: false })
    const request = { method: 'POST', origin: 'https://console.openkubes.example', expectedOrigin: 'https://console.openkubes.example', token: issued.csrfToken, context }

    expect(validateCsrf(request)).toBe(true)
    expect(validateCsrf({ ...request, origin: 'https://evil.example' })).toBe(false)
    expect(validateCsrf({ ...request, origin: undefined, expectedOrigin: undefined })).toBe(false)
    expect(validateCsrf({ ...request, token: 'wrong-token' })).toBe(false)
    expect(validateCsrf({ ...request, method: 'GET', token: undefined })).toBe(true)
  })

  it('uses shorter expiry for bootstrap and break-glass sessions', () => {
    const store = new InMemorySessionStore({ now: () => new Date('2026-08-21T19:00:00Z'), random: deterministicRandom })
    const issued = store.create({ subject: { ...subject, method: 'BreakGlass' }, scope, permissions })

    expect(issued.session.data.session.idleExpiresAt).toBe('2026-08-21T19:05:00.000Z')
    expect(issued.session.data.session.absoluteExpiresAt).toBe('2026-08-21T19:15:00.000Z')
    expect(issued.cookie).toContain('Max-Age=900')
  })

  it('does not refresh idle expiry after denied point-of-use authorization', () => {
    let current = new Date('2026-08-21T19:00:00Z')
    const store = new InMemorySessionStore({ now: () => current, random: deterministicRandom })
    const issued = store.create({ subject, scope, permissions })
    current = new Date('2026-08-21T19:10:00Z')

    expect(store.authorize(issued.cookie, { permission: 'clusters.delete', environmentId: 'community-preview' }).allowed).toBe(false)
    expect(store.resolve(issued.cookie, { touch: false })?.session.idleExpiresAt).toBe('2026-08-21T19:15:00.000Z')
  })

  it('rejects malformed session creation input before storing anything', () => {
    const store = new InMemorySessionStore({ random: deterministicRandom })

    expect(() => store.create({ subject: { ...subject, subjectId: '' }, scope, permissions })).toThrow('input is invalid')
    expect(store.sessions.size).toBe(0)
  })
})
