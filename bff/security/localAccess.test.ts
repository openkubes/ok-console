// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import { createLocalAccessVerifier, LocalAccessError, PostgresLocalAccessThrottle } from './localAccess.mjs'

const account = {
  username: 'recovery-admin', enabled: true, salt: Buffer.alloc(16, 1).toString('base64'),
  verifier: Buffer.alloc(32, 2).toString('base64'), identityId: 'local-1', displayName: 'Recovery Admin',
  environmentId: 'prod', tenantIds: ['platform'], permissions: ['platform.read'],
}

const setup = (overrides = {}) => {
  const throttle = { blocked: vi.fn(async () => false), failure: vi.fn(async () => {}), success: vi.fn(async () => {}) }
  const sessionStore = { create: vi.fn(async (input) => ({ cookie: 'session', input })) }
  const audit = vi.fn(async () => {})
  const derive = vi.fn(async () => Buffer.alloc(32, 2))
  const verify = createLocalAccessVerifier({ mode: 'BreakGlass', accounts: [account], throttle, sessionStore, audit, derive, authorizationRevision: 'rbac-1', ...overrides })
  return { verify, throttle, sessionStore, audit, derive }
}

describe('exceptional local access verifier', () => {
  it('issues a short-method session only from the reviewed account mapping', async () => {
    const { verify, throttle, sessionStore, audit } = setup()
    await expect(verify({ username: ' Recovery-Admin ', password: 'secret', reason: 'OIDC provider recovery' })).resolves.toMatchObject({ cookie: 'session' })
    expect(throttle.success).toHaveBeenCalledWith('recovery-admin')
    expect(sessionStore.create).toHaveBeenCalledWith(expect.objectContaining({
      subject: expect.objectContaining({ method: 'BreakGlass', assurance: ['Password', 'ExceptionalAccess'] }),
      authorizationRevision: 'rbac-1',
    }))
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'Granted', reason: 'OIDC provider recovery' }))
  })

  it('runs the same memory-hard derivation path for an unknown account and returns a generic error', async () => {
    const { verify, derive, throttle } = setup()
    await expect(verify({ username: 'unknown', password: 'guess', reason: 'Emergency recovery attempt' })).rejects.toEqual(expect.objectContaining<Partial<LocalAccessError>>({ code: 'LOCAL_ACCESS_REJECTED' }))
    expect(derive).toHaveBeenCalledTimes(1)
    expect(throttle.failure).toHaveBeenCalledWith('unknown')
  })

  it('does no password work after the cross-replica throttle blocks a principal', async () => {
    const throttle = { blocked: vi.fn(async () => true), failure: vi.fn(), success: vi.fn() }
    const { verify, derive } = setup({ throttle })
    await expect(verify({ username: 'recovery-admin', password: 'secret', reason: 'Emergency recovery attempt' })).rejects.toBeInstanceOf(LocalAccessError)
    expect(derive).not.toHaveBeenCalled()
  })

  it('requires a bounded operational reason before verification', async () => {
    const { verify, derive } = setup()
    await expect(verify({ username: 'recovery-admin', password: 'secret', reason: 'short' })).rejects.toBeInstanceOf(LocalAccessError)
    expect(derive).not.toHaveBeenCalled()
  })
})

describe('PostgreSQL exceptional-access throttle', () => {
  it('stores only an HMAC digest and uses database time for blocking', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ blocked: true }] }).mockResolvedValue({ rows: [], rowCount: 1 })
    const throttle = new PostgresLocalAccessThrottle({ pool: { query }, pepper: Buffer.alloc(32, 5) })
    expect(await throttle.blocked('recovery-admin')).toBe(true)
    await throttle.failure('recovery-admin')
    await throttle.success('recovery-admin')
    expect(JSON.stringify(query.mock.calls)).not.toContain('recovery-admin')
    expect(query.mock.calls[1][0]).toContain("interval '15 minutes'")
  })
})
