import { IdentityError } from './localIdentity.mjs'
import { validateCsrf } from './session.mjs'

const ROOT = '/api/console/v0/local-identity'
export const createLocalIdentityHttp = ({ identity, sessions, expectedOrigin }) => async ({ request, response, pathname, correlationId }) => {
  if (pathname !== ROOT && !pathname.startsWith(`${ROOT}/`)) return false
  const operation = pathname.slice(ROOT.length + 1)
  const method = operation === 'list' ? 'GET' : 'POST'
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }
  try {
    if (!['login','initialize','create','list','disable','recover'].includes(operation)) throw new IdentityError(404)
    if (request.method !== method) throw new IdentityError(405)
    if (method === 'POST' && request.headers.origin !== expectedOrigin) throw new IdentityError(403)
    let context
    if (operation !== 'login') {
      context = await sessions.resolve(request.headers.cookie, { touch: false })
      if (!context) throw new IdentityError(401)
      if (method === 'POST' && !validateCsrf({ method, origin: request.headers.origin, expectedOrigin, token: request.headers['x-csrf-token'], context })) throw new IdentityError(403)
    }
    let input = {}
    if (method === 'POST') {
      if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new IdentityError(415)
      const chunks = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length
        if (size > 4096) throw new IdentityError(413)
        chunks.push(chunk)
      }
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new IdentityError(400) }
      if (!input || Array.isArray(input) || typeof input !== 'object') throw new IdentityError(400)
    }
    if (operation === 'login') {
      const issued = await identity.login(input, correlationId)
      response.writeHead(200, { ...headers, 'Set-Cookie': [issued.cookie, issued.csrfCookie] })
      response.end(JSON.stringify(issued.session))
    } else {
      const result = await identity.manage(operation, context, input, correlationId)
      response.writeHead(200, headers)
      response.end(JSON.stringify(result))
    }
  } catch (error) {
    response.writeHead(error instanceof IdentityError ? error.status : 503, headers)
    response.end(JSON.stringify({ error: { code: 'LOCAL_IDENTITY_REJECTED', message: 'Local identity request could not be completed.' } }))
  }
  return true
}

export const validateLocalIdentityProfile = (env) => {
  const enabled = env.OK_CONSOLE_LOCAL_IDENTITY_ENABLED
  if (enabled === undefined || enabled === 'false') return false
  if (enabled !== 'true') throw new IdentityError()
  if (env.OK_CONSOLE_LOCAL_IDENTITY_RECOVERY_ENABLED !== undefined && !['true','false'].includes(env.OK_CONSOLE_LOCAL_IDENTITY_RECOVERY_ENABLED)) throw new IdentityError()
  if (env.OK_CONSOLE_LOCAL_IDENTITY_RECOVERY_ENABLED === 'true' && env.OK_CONSOLE_LOCAL_ACCESS_MODE !== 'bootstrap') throw new IdentityError()
  let origin
  try { origin = new URL(env.OK_CONSOLE_ORIGIN) } catch { throw new IdentityError() }
  if (env.OK_CONSOLE_PROFILE !== 'ok-local' || env.NODE_ENV !== 'development'
    || env.OK_CONSOLE_SESSION_STORE_MODE !== 'postgres' || env.OK_CONSOLE_DEV_PROTOTYPE_ENABLED === 'true'
    || env.OK_CONSOLE_BFF_ENABLE_FAILURE_INJECTION === 'true'
    || !['127.0.0.1','::1'].includes(env.OK_CONSOLE_BFF_HOST)
    || origin.protocol !== 'https:' || !['127.0.0.1','[::1]'].includes(origin.hostname)
    || origin.origin !== env.OK_CONSOLE_ORIGIN
    || origin.hostname.replaceAll('[','').replaceAll(']','') !== env.OK_CONSOLE_BFF_HOST
    || Number(origin.port || 443) !== Number(env.OK_CONSOLE_BFF_PORT ?? 8787)
    || env.KUBERNETES_SERVICE_HOST !== undefined) throw new IdentityError()
  return true
}
