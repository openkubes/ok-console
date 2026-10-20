import { describe, expect, it, vi } from 'vitest'
import { AuthenticationAuditError, PostgresAuthenticationAudit, validateAuthenticationAuditEvent } from './authenticationAudit.mjs'

const event = {
  correlationId: 'corr-1', method: 'OIDC', outcome: 'Denied', cause: 'CALLBACK_REJECTED',
  reason: 'OIDC callback validation failed', principal: 'subject-1',
}

describe('authentication audit port', () => {
  it('accepts bounded credential-free events', () => {
    expect(validateAuthenticationAuditEvent(event)).toEqual(event)
  })

  it.each([
    ['token', { reason: 'access_token=secret' }],
    ['url', { reason: 'https://issuer.invalid/callback' }],
    ['control character', { reason: 'bad\nreason' }],
    ['unknown cause', { cause: 'TOKEN_ACCEPTED' }],
  ])('rejects unsafe %s data', (_label, override) => {
    expect(() => validateAuthenticationAuditEvent({ ...event, ...override })).toThrow(AuthenticationAuditError)
  })

  it('stores only a principal digest and approved fields', async () => {
    const query = vi.fn(async () => ({ rows: [] }))
    const audit = new PostgresAuthenticationAudit({ pool: { query }, pepper: Buffer.alloc(32, 7) })
    await audit.record(event)
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0][0]).toContain('INSERT INTO ok_console.authentication_audit')
    expect(query.mock.calls[0][1]).toEqual([
      'corr-1', 'OIDC', 'Denied', 'CALLBACK_REJECTED', expect.any(String), 'OIDC callback validation failed',
    ])
    expect(query.mock.calls[0][1][4]).not.toBe('subject-1')
  })

  it('fails closed when persistence fails', async () => {
    const audit = new PostgresAuthenticationAudit({ pool: { query: vi.fn(async () => { throw new Error('db down') }) }, pepper: Buffer.alloc(32, 7) })
    await expect(audit.record(event)).rejects.toThrow(AuthenticationAuditError)
  })
})
