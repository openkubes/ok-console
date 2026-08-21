export const SECURITY_CONTRACT_VERSION = 'auth.console.openkubes.io/v0alpha1'

const deny = (reason) => ({ allowed: false, reason, identity: null })

const timestamp = (value) => {
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

const validContext = (context) => context
  && context.apiVersion === SECURITY_CONTRACT_VERSION
  && context.kind === 'AuthorizationContext'
  && typeof context.sessionId === 'string'
  && typeof context.subject?.id === 'string'
  && typeof context.subject?.providerId === 'string'
  && typeof context.subject?.subjectId === 'string'
  && typeof context.subject?.displayName === 'string'
  && ['OIDC', 'BreakGlass', 'Bootstrap'].includes(context.subject?.method)
  && Array.isArray(context.subject?.assurance)
  && typeof context.scope?.environmentId === 'string'
  && Array.isArray(context.scope?.tenantIds)
  && Array.isArray(context.permissions)
  && timestamp(context.session?.idleExpiresAt) !== null
  && timestamp(context.session?.absoluteExpiresAt) !== null

export const authorizeSecurityContext = (context, request, now = () => new Date()) => {
  if (!validContext(context)) return deny('INVALID_CONTEXT')
  if (!request || typeof request.permission !== 'string' || typeof request.environmentId !== 'string') return deny('INVALID_REQUEST')
  if (context.session.revokedAt) return deny('SESSION_REVOKED')

  const currentTime = now().getTime()
  if (currentTime >= timestamp(context.session.idleExpiresAt) || currentTime >= timestamp(context.session.absoluteExpiresAt)) {
    return deny('SESSION_EXPIRED')
  }
  if (context.scope.environmentId !== request.environmentId) return deny('CROSS_ENVIRONMENT')
  if (request.tenantId && !context.scope.tenantIds.includes(request.tenantId)) return deny('CROSS_TENANT')
  if (!context.permissions.includes(request.permission)) return deny('PERMISSION_DENIED')
  if (request.requiredAssurance?.some((item) => !context.subject.assurance.includes(item))) return deny('ASSURANCE_INSUFFICIENT')

  return {
    allowed: true,
    reason: 'AUTHORIZED',
    identity: {
      id: context.subject.id,
      displayName: context.subject.displayName,
      identitySource: context.subject.method,
      assurance: context.subject.assurance.join(' + '),
      permissions: [...context.permissions],
      environmentId: context.scope.environmentId,
      tenantIds: [...context.scope.tenantIds],
    },
  }
}
