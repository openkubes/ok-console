import { expect, test } from '@playwright/test'
import {
  CSRF_COOKIE, OIDC_TRANSACTION_COOKIE, SESSION_COOKIE, authenticationAuditSince, bffLog, browserStorageDump, cookie,
  databaseNow, harness, leaks, openSignIn, protectedValues, query, recordCallbacks, sessionRequest, sessionsSince,
  startOidc, submitKeycloakLogin, tokenExchanges,
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

  const authorization = await startOidc(page)
  const params = authorization.searchParams
  expect(authorization.href.startsWith(`${issuer}/protocol/openid-connect/auth`)).toBe(true)
  expect(params.get('response_type')).toBe('code')
  expect(params.get('client_id')).toBe(clientId)
  expect(params.get('redirect_uri')).toBe(`${origin}/api/console/v0/auth/oidc/callback`)
  expect(params.get('code_challenge_method')).toBe('S256')
  expect(params.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(params.get('state')?.length ?? 0).toBeGreaterThanOrEqual(16)
  expect(params.get('nonce')?.length ?? 0).toBeGreaterThanOrEqual(16)
  expect(params.get('scope')?.split(' ')).toContain('openid')
  expect(params.has('code_verifier')).toBe(false)
  const transaction = await cookie(context, OIDC_TRANSACTION_COOKIE)
  expect(transaction).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' })

  await submitKeycloakLogin(page, 'mapped-operator', harness().passwords.mapped)
  await page.waitForURL(`${origin}/`)
  await expect(page.getByText('Federated identity')).toBeVisible()
  await expect(page.getByText('Mapped Operator').first()).toBeVisible()
  expect(callbacks).toHaveLength(1)
  expect(tokenExchanges()).toBe(exchangesBefore + 1)

  const session = await cookie(context, SESSION_COOKIE)
  const csrf = await cookie(context, CSRF_COOKIE)
  expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' })
  expect(csrf).toMatchObject({ secure: true, path: '/' })
  expect(await cookie(context, OIDC_TRANSACTION_COOKIE)).toBeUndefined()

  const sessions = await sessionsSince(since)
  expect(sessions).toHaveLength(1)
  expect(sessions[0]).toMatchObject({ authentication_method: 'OIDC', revoked_at: null })
  expect(sessions[0].absolute_expires_at.getTime() - sessions[0].issued_at.getTime()).toBe(60 * 60 * 1_000)
  expect(Number(sessions[0].idle_lifetime_ms)).toBe(15 * 60 * 1_000)
  expect(await query('SELECT 1 FROM ok_console.oidc_transactions WHERE created_at >= $1', [since])).toHaveLength(0)
  expect((await authenticationAuditSince(since)).map((row) => `${row.authentication_method}:${row.outcome}:${row.cause}`)).toEqual(['OIDC:Denied:SESSION_INVALID', 'OIDC:Started:REQUESTED', 'OIDC:Granted:VERIFIED', 'OIDC:Restored:VERIFIED'])

  const current = await sessionRequest(page, 'GET')
  expect(current.status()).toBe(200)

  const secrets = protectedValues()
  expect(secrets.length).toBeGreaterThanOrEqual(6)
  expect(leaks(await browserStorageDump(page), secrets)).toEqual([])
  expect(leaks(bffLog(), [...secrets, session!.value, csrf!.value])).toEqual([])
})
