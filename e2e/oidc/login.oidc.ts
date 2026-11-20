import { expect, test } from '@playwright/test'
import {
  CALLBACK_PATH, CSRF_COOKIE, OIDC_TRANSACTION_COOKIE, SESSION_COOKIE, authenticationAuditSince, bffLog, browserStorageDump,
  cookie, databaseNow, expectCookieAttributes, expectLogged, harness, harnessSecrets, leaks, openSignIn, protectedValues, query,
  recordCallbacks, recordConsoleResponses, sessionRequest, sessionsSince, setCookies, startOidc, submitKeycloakLogin, tokenExchanges,
} from './support'

test('AC1: the identity provider is the primary sign-in action; local access sits behind the exceptional-access control', async ({ page }) => {
  await openSignIn(page)
  const provider = page.getByRole('button', { name: /Continue with OpenKubes Identity/ })
  const local = page.getByRole('button', { name: /Use a local account/ })
  await expect(provider).toBeVisible()
  await expect(page.locator('.auth-provider-list .auth-provider')).toHaveCount(1)
  await expect(local).toContainText('Break-glass only · audited')
  await expect(page.locator('input[type=password]')).toHaveCount(0)
  const order = await page.evaluate(() => {
    const first = document.querySelector('.auth-provider')
    const exceptional = document.querySelector('.auth-local-entry')
    return first && exceptional ? first.compareDocumentPosition(exceptional) : 0
  })
  expect(order & 4 /* Node.DOCUMENT_POSITION_FOLLOWING */).toBeTruthy()
})

test('AC2/AC3/AC7: a mapped Keycloak user gets a server-side OIDC session and no protocol secret reaches the browser or logs', async ({ page, context }) => {
  const { origin, issuer, clientId } = harness()
  const since = await databaseNow()
  const exchangesBefore = tokenExchanges()
  const callbacks = recordCallbacks(page)
  const consoleResponses = recordConsoleResponses(page)
  const startResponse = page.waitForResponse((response) => response.url().includes('/api/console/v0/auth/oidc/start'))
  const callbackResponse = page.waitForResponse((response) => response.url().includes(CALLBACK_PATH))

  const authorization = await startOidc(page)
  const params = authorization.searchParams
  expect(authorization.href.startsWith(`${issuer}/protocol/openid-connect/auth`)).toBe(true)
  expect(params.get('response_type')).toBe('code')
  expect(params.get('client_id')).toBe(clientId)
  expect(params.get('redirect_uri')).toBe(`${origin}${CALLBACK_PATH}`)
  expect(params.get('code_challenge_method')).toBe('S256')
  expect(params.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(params.get('state')?.length ?? 0).toBeGreaterThanOrEqual(16)
  expect(params.get('nonce')?.length ?? 0).toBeGreaterThanOrEqual(16)
  expect(params.get('scope')?.split(' ')).toContain('openid')
  expect(params.has('code_verifier')).toBe(false)
  const start = await startResponse
  expect(start.status()).toBe(302)
  expectCookieAttributes(await setCookies(start), OIDC_TRANSACTION_COOKIE, ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/'])

  await submitKeycloakLogin(page, 'mapped-operator', harness().passwords.mapped)
  await page.waitForURL(`${origin}/`)
  await expect(page.getByText('Federated identity')).toBeVisible()
  await expect(page.getByText('Mapped Operator').first()).toBeVisible()
  expect(callbacks).toHaveLength(1)
  expect(tokenExchanges()).toBe(exchangesBefore + 1)

  // Raw Set-Cookie: Playwright's cookie API reports SameSite=Lax when the attribute is absent.
  const callback = await callbackResponse
  expect(callback.status()).toBe(303)
  const issued = await setCookies(callback)
  expectCookieAttributes(issued, SESSION_COOKIE, ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/'])
  expectCookieAttributes(issued, CSRF_COOKIE, ['Secure', 'SameSite=Lax', 'Path=/'])
  expect(await cookie(context, OIDC_TRANSACTION_COOKIE)).toBeUndefined()
  const session = (await cookie(context, SESSION_COOKIE))!
  const csrf = (await cookie(context, CSRF_COOKIE))!

  const sessions = await sessionsSince(since)
  expect(sessions).toHaveLength(1)
  expect(sessions[0]).toMatchObject({ authentication_method: 'OIDC', revoked_at: null })
  expect(sessions[0].absolute_expires_at.getTime() - sessions[0].issued_at.getTime()).toBe(60 * 60 * 1_000)
  expect(Number(sessions[0].idle_lifetime_ms)).toBe(15 * 60 * 1_000)
  expect(await query('SELECT 1 FROM ok_console.oidc_transactions WHERE created_at >= $1', [since])).toHaveLength(0)
  expect((await authenticationAuditSince(since)).map((row) => `${row.authentication_method}:${row.outcome}:${row.cause}`))
    .toEqual(['OIDC:Denied:SESSION_INVALID', 'OIDC:Started:REQUESTED', 'OIDC:Granted:VERIFIED', 'OIDC:Restored:VERIFIED'])
  expect((await sessionRequest(page, 'GET')).status()).toBe(200)

  const secrets = protectedValues()
  expect(secrets.length).toBeGreaterThanOrEqual(6)
  expect(leaks(await browserStorageDump(page), secrets)).toEqual([])
  expect(leaks(await consoleResponses(), [...secrets, ...harnessSecrets()])).toEqual([])
  expectLogged(CALLBACK_PATH)
  expect(leaks(bffLog(), [...secrets, ...harnessSecrets(), session.value, csrf.value])).toEqual([])
})
