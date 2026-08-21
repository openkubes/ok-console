// @vitest-environment node

import { describe, expect, it } from 'vitest'
import authorizationContext from '../../contracts/security/v0alpha1/examples/authorization-context.json'
import { authorizeSecurityContext } from './authorization.mjs'

const now = () => new Date('2026-08-21T19:10:00Z')
const request = {
  permission: 'clusters.read',
  environmentId: 'community-preview',
  tenantId: 'tenant-platform',
}

describe('OK-163 authorization contract', () => {
  it('authorizes only an explicit current point-of-use permission', () => {
    const result = authorizeSecurityContext(structuredClone(authorizationContext), request, now)

    expect(result).toMatchObject({
      allowed: true,
      reason: 'AUTHORIZED',
      identity: { id: 'subject-01K34', environmentId: 'community-preview' },
    })
    expect(JSON.stringify(result)).not.toContain('issuer-subject-opaque-9f2')
  })

  it('rejects privilege expansion requested by the caller', () => {
    expect(authorizeSecurityContext(authorizationContext, { ...request, permission: 'clusters.delete' }, now))
      .toEqual({ allowed: false, reason: 'PERMISSION_DENIED', identity: null })
  })

  it('rejects idle and absolute expiry without extending either', () => {
    const idleExpired = structuredClone(authorizationContext)
    idleExpired.session.idleExpiresAt = '2026-08-21T19:09:59Z'
    const absoluteExpired = structuredClone(authorizationContext)
    absoluteExpired.session.absoluteExpiresAt = '2026-08-21T19:09:59Z'

    expect(authorizeSecurityContext(idleExpired, request, now).reason).toBe('SESSION_EXPIRED')
    expect(authorizeSecurityContext(absoluteExpired, request, now).reason).toBe('SESSION_EXPIRED')
  })

  it('rejects revoked sessions and cross-environment or cross-tenant access', () => {
    const revoked = structuredClone(authorizationContext)
    revoked.session.revokedAt = '2026-08-21T19:05:00Z'

    expect(authorizeSecurityContext(revoked, request, now).reason).toBe('SESSION_REVOKED')
    expect(authorizeSecurityContext(authorizationContext, { ...request, environmentId: 'production' }, now).reason).toBe('CROSS_ENVIRONMENT')
    expect(authorizeSecurityContext(authorizationContext, { ...request, tenantId: 'tenant-other' }, now).reason).toBe('CROSS_TENANT')
  })

  it('fails closed for malformed, unknown-version and insufficient-assurance contexts', () => {
    const unknownVersion = { ...structuredClone(authorizationContext), apiVersion: 'auth.console.openkubes.io/v9' }

    expect(authorizeSecurityContext(unknownVersion, request, now).reason).toBe('INVALID_CONTEXT')
    expect(authorizeSecurityContext(authorizationContext, { ...request, requiredAssurance: ['hardware-key'] }, now).reason).toBe('ASSURANCE_INSUFFICIENT')
    expect(authorizeSecurityContext(null, request, now).reason).toBe('INVALID_CONTEXT')
  })
})
