import * as client from 'openid-client'
import { clearOidcTransactionCookie } from './oidcTransactionStore.mjs'

const START_PATH = '/api/console/v0/auth/oidc/start'
const CALLBACK_PATH = '/api/console/v0/auth/oidc/callback'

const headers = (extra = {}) => ({
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  ...extra,
})

const boundedError = (response, status, code) => {
  response.writeHead(status, headers({ 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': clearOidcTransactionCookie() }))
  response.end(JSON.stringify({
    apiVersion: 'auth.console.openkubes.io/v0alpha1',
    kind: 'SecurityError',
    error: { code, message: 'Federated sign-in could not be completed.' },
  }))
}

export const createOidcProtocolClient = async ({ issuer, clientId, clientSecret, timeoutSeconds = 5 }) => {
  const configuration = await client.discovery(
    new URL(issuer),
    clientId,
    {
      client_secret: clientSecret,
      redirect_uris: [],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_basic',
    },
    client.ClientSecretBasic(clientSecret),
    { timeout: timeoutSeconds },
  )
  return {
    codeVerifier: client.randomPKCECodeVerifier,
    state: client.randomState,
    nonce: client.randomNonce,
    challenge: client.calculatePKCECodeChallenge,
    authorizationUrl: (parameters) => client.buildAuthorizationUrl(configuration, parameters),
    exchange: async (currentUrl, checks) => {
      const tokens = await client.authorizationCodeGrant(configuration, currentUrl, checks)
      if (typeof tokens.id_token !== 'string') throw new Error('OIDC ID Token is required.')
      const claims = tokens.claims()
      if (!claims || typeof claims.sub !== 'string') throw new Error('OIDC subject is required.')
      return claims
    },
  }
}

export const createStaticOidcIdentityMapper = ({ providerId, environmentId, authorizationRevision, subjects }) => {
  const mappings = new Map(subjects.map((item) => [item.providerSubject, item]))
  return async (claims) => {
    const mapping = mappings.get(claims.sub)
    if (!mapping) return null
    return {
      subject: {
        id: mapping.identityId,
        providerId,
        subjectId: claims.sub,
        displayName: mapping.displayName,
        method: 'OIDC',
        assurance: [...mapping.assurance],
      },
      scope: { environmentId, tenantIds: [...mapping.tenantIds] },
      permissions: [...mapping.permissions],
      authorizationRevision,
    }
  }
}

export const createOidcHttpHandler = ({
  protocol,
  transactionStore,
  sessionStore,
  identityMapper,
  redirectUri,
  successRedirect = '/',
}) => async ({ request, response, pathname }) => {
  if (pathname !== START_PATH && pathname !== CALLBACK_PATH) return false
  if (request.method !== 'GET') {
    boundedError(response, 405, 'METHOD_NOT_ALLOWED')
    return true
  }

  if (pathname === START_PATH) {
    try {
      const codeVerifier = protocol.codeVerifier()
      const state = protocol.state()
      const nonce = protocol.nonce()
      const codeChallenge = await protocol.challenge(codeVerifier)
      const transaction = await transactionStore.create({ codeVerifier, state, nonce })
      const location = protocol.authorizationUrl({
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state,
        nonce,
      })
      response.writeHead(302, headers({ Location: location.href, 'Set-Cookie': transaction.cookie }))
      response.end()
    } catch {
      boundedError(response, 503, 'OIDC_UNAVAILABLE')
    }
    return true
  }

  let transaction
  try {
    transaction = await transactionStore.consume(request.headers.cookie)
    if (!transaction) {
      boundedError(response, 401, 'OIDC_TRANSACTION_INVALID')
      return true
    }
    const incomingUrl = new URL(request.url, 'http://console.invalid')
    const currentUrl = new URL(redirectUri)
    currentUrl.search = incomingUrl.search
    const claims = await protocol.exchange(currentUrl, {
      pkceCodeVerifier: transaction.codeVerifier,
      expectedState: transaction.state,
      expectedNonce: transaction.nonce,
    })
    const authorization = await identityMapper(claims)
    if (!authorization) {
      boundedError(response, 403, 'OIDC_SUBJECT_UNMAPPED')
      return true
    }
    const issued = await sessionStore.create(authorization)
    response.writeHead(303, headers({
      Location: successRedirect,
      'Set-Cookie': [clearOidcTransactionCookie(), issued.cookie, issued.csrfCookie],
    }))
    response.end()
  } catch {
    boundedError(response, 401, 'OIDC_CALLBACK_REJECTED')
  }
  return true
}
