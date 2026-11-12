// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import { createLocalAccessVerifier, LocalAccessError, PostgresLocalAccessAudit } from './localAccess.mjs'

const account = {
  username: 'recovery-admin', enabled: true, salt: Buffer.alloc(16, 1).toString('base64'),
  verifier: Buffer.alloc(32, 2).toString('base64'), identityId: 'local-1', displayName: 'Recovery Admin',
  environmentId: 'prod', tenantIds: ['platform'], permissions: ['platform.read'],
}

const setup = (overrides = {}) => {
  const throttle = { reserve: vi.fn(async () => ({ blocked: false, globalWindow: 'window' })), success: vi.fn(async () => {}) }
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
    expect(throttle.success).toHaveBeenCalledWith('recovery-admin', { blocked: false, globalWindow: 'window' })
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
    expect(throttle.reserve).toHaveBeenCalledExactlyOnceWith('unknown')
    expect(throttle.success).not.toHaveBeenCalled()
  })

  it('does no password work after the cross-replica throttle blocks a principal', async () => {
    const throttle = { reserve: vi.fn(async () => ({ blocked: true })), success: vi.fn() }
    const { verify, derive } = setup({ throttle })
    await expect(verify({ username: 'recovery-admin', password: 'secret', reason: 'Emergency recovery attempt' })).rejects.toBeInstanceOf(LocalAccessError)
    expect(derive).not.toHaveBeenCalled()
  })

  it('denies disabled local access before throttle, password work or session issuance', async () => {
    const isEnabled = vi.fn(async () => false)
    const { verify, throttle, derive, sessionStore, audit } = setup({ isEnabled })
    await expect(verify({ username: 'recovery-admin', password: 'secret', reason: 'Emergency recovery attempt' }))
      .rejects.toMatchObject<Partial<LocalAccessError>>({ code: 'LOCAL_ACCESS_REJECTED' })
    expect(isEnabled).toHaveBeenCalledTimes(1)
    expect(throttle.reserve).not.toHaveBeenCalled()
    expect(derive).not.toHaveBeenCalled()
    expect(sessionStore.create).not.toHaveBeenCalled()
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'Denied', cause: 'THROTTLED' }))
  })

  it('fails closed at ENABLED_CHECK before any downstream operation', async () => {
    const cause = new Error('private enabled-check failure')
    const { verify, throttle, derive, sessionStore, audit } = setup({ isEnabled: async () => { throw cause } })
    await expect(verify({ username: 'recovery-admin', password: 'secret', reason: 'Emergency recovery attempt' }))
      .rejects.toMatchObject({ code: 'LOCAL_ACCESS_UNAVAILABLE', step: 'ENABLED_CHECK', cause })
    expect(throttle.reserve).not.toHaveBeenCalled()
    expect(derive).not.toHaveBeenCalled()
    expect(sessionStore.create).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
  })

  it('treats an undefined enabled-check option as enabled', async () => {
    const { verify } = setup({ isEnabled: undefined })
    await expect(verify({ username: 'recovery-admin', password: 'secret', reason: 'Emergency recovery attempt' }))
      .resolves.toMatchObject({ cookie: 'session' })
  })

  it('requires a bounded operational reason before verification', async () => {
    const { verify, derive } = setup()
    await expect(verify({ username: 'recovery-admin', password: 'secret', reason: 'short' })).rejects.toBeInstanceOf(LocalAccessError)
    expect(derive).not.toHaveBeenCalled()
  })

  it('fails unavailable when shared throttle or denied-attempt audit Evidence cannot be persisted', async () => {
    const blockedFailure = setup({ throttle: { reserve: vi.fn(async () => { throw new Error('database unavailable') }) } })
    await expect(blockedFailure.verify({ username: 'recovery-admin', password: 'secret', reason: 'Emergency recovery attempt' }))
      .rejects.toMatchObject<Partial<LocalAccessError>>({ code: 'LOCAL_ACCESS_UNAVAILABLE' })

    const auditFailure = setup({ audit: vi.fn(async () => { throw new Error('audit unavailable') }) })
    await expect(auditFailure.verify({ username: 'unknown', password: 'guess', reason: 'Emergency recovery attempt' }))
      .rejects.toMatchObject<Partial<LocalAccessError>>({ code: 'LOCAL_ACCESS_UNAVAILABLE' })
  })

  it('never derives or issues a session when reservation fails', async () => {
    const { verify, throttle, derive, sessionStore } = setup()
    throttle.reserve.mockRejectedValueOnce(new Error('reservation unavailable'))
    await expect(verify({ username: 'recovery-admin', password: 'secret', reason: 'Emergency recovery attempt' }))
      .rejects.toMatchObject({ code: 'LOCAL_ACCESS_UNAVAILABLE', step: 'THROTTLE_RESERVE' })
    expect(derive).not.toHaveBeenCalled()
    expect(sessionStore.create).not.toHaveBeenCalled()
  })

  it('durably reserves before deriving a password verdict', async () => {
    const { verify, throttle, derive } = setup()
    derive.mockImplementationOnce(async () => {
      expect(throttle.reserve).toHaveBeenCalledExactlyOnceWith('recovery-admin')
      return Buffer.alloc(32, 3)
    })
    await expect(verify({ username: 'recovery-admin', password: 'wrong', reason: 'Emergency recovery attempt' }))
      .rejects.toMatchObject({ code: 'LOCAL_ACCESS_REJECTED' })
    expect(throttle.reserve).toHaveBeenCalledTimes(1)
    expect(throttle.success).not.toHaveBeenCalled()
  })

  it('refuses success before session creation if reservation release fails', async () => {
    const sessionStore = { create: vi.fn(), revoke: vi.fn() }
    const { verify, throttle } = setup({ sessionStore })
    throttle.success.mockRejectedValueOnce(new Error('release unavailable'))
    await expect(verify({ username: 'recovery-admin', password: 'secret', reason: 'Emergency recovery attempt' }))
      .rejects.toMatchObject({ code: 'LOCAL_ACCESS_UNAVAILABLE', step: 'THROTTLE_RESET' })
    expect(sessionStore.create).not.toHaveBeenCalled()
    expect(sessionStore.revoke).not.toHaveBeenCalled()
  })

  it('revokes an issued session when granted-attempt audit Evidence fails', async () => {
    const sessionStore = {
      create: vi.fn(async () => ({ cookie: 'session-reference' })),
      revoke: vi.fn(async () => true),
    }
    const { verify } = setup({ sessionStore, audit: vi.fn(async () => { throw new Error('audit unavailable') }) })
    await expect(verify({ username: 'recovery-admin', password: 'secret', reason: 'Emergency recovery attempt' }))
      .rejects.toMatchObject<Partial<LocalAccessError>>({ code: 'LOCAL_ACCESS_UNAVAILABLE' })
    expect(sessionStore.revoke).toHaveBeenCalledWith('session-reference', 'AUDIT_FAILED')
  })
})

describe('PostgreSQL exceptional-access throttle', () => {
  it('writes credential-free append-only audit Evidence', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }))
    const audit = new PostgresLocalAccessAudit({ pool: { query }, pepper: Buffer.alloc(32, 6) })
    await audit.record({ principal: 'recovery-admin', method: 'BreakGlass', outcome: 'Denied', cause: 'INVALID_CREDENTIAL', reason: 'Emergency recovery attempt', correlationId: 'corr-1' })
    expect(query.mock.calls[0][0]).toContain('INSERT INTO ok_console.local_access_audit')
    expect(JSON.stringify(query.mock.calls)).not.toContain('recovery-admin')
    expect(JSON.stringify(query.mock.calls)).not.toContain('password')
  })
})
