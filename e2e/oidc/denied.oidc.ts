import { expect, test, type Page } from '@playwright/test'
import {
  CALLBACK_PATH, OIDC_TRANSACTION_COOKIE, SESSION_COOKIE, authenticationAuditSince, bffLog, browserStorageDump, cookie,
  databaseNow, expectLogged, harness, harnessSecrets, leaks, protectedValues, sessionRequest, sessionsSince, signInMapped,
  startOidc, submitKeycloakLogin, tokenExchanges,
} from './support'

// Browser-level denied flows against the real issuer. API-level negatives for a forged issuer,
// audience, nonce or signature live in the OK-163 callback suite; this file covers what only a
// real browser + real provider can show.

const auditTrail = async (since: Date) => (await authenticationAuditSince(since)).map((row) => `${row.authentication_method}:${row.outcome}:${row.cause}`)
const isCallback = (url: URL) => url.pathname === CALLBACK_PATH

const expectNoSession = async (page: Page, since: Date) => {
  expect(await sessionsSince(since)).toHaveLength(0)
  expect(await cookie(page.context(), SESSION_COOKIE)).toBeUndefined()
  expect((await sessionRequest(page, 'GET')).status()).toBe(401)
}

/** extra: values this flow produced that the issuer tap cannot see (e.g. a code never exchanged). */
const expectNoLeak = async (page: Page, extra: string[] = []) => {
  const secrets = [...protectedValues(), ...extra]
  expect(leaks(await browserStorageDump(page), secrets.filter((value) => !page.url().includes(value)))).toEqual([])
  expectLogged(CALLBACK_PATH)
  expect(leaks(bffLog(), [...secrets, ...harnessSecrets()])).toEqual([])
}

/** Lets the provider issue a code for the mapped user but never lets the browser deliver it. */
const captureCallback = async (page: Page) => {
  // Redirect hops cannot be intercepted, so take the callback URL from the provider's own redirect.
  let intercepted = ''
  const isLoginAction = (url: URL) => url.origin === harness().issuerOrigin && url.pathname.includes('/login-actions/authenticate')
  await page.route(isLoginAction, async (route) => {
    const response = await route.fetch({ maxRedirects: 0 })
    const location = response.headers().location ?? ''
    if (location && isCallback(new URL(location))) {
      intercepted = location
      await route.fulfill({ status: 200, contentType: 'text/plain', body: 'callback captured' })
    } else {
      await route.fulfill({ response })
    }
  })
  await startOidc(page)
  await submitKeycloakLogin(page, 'mapped-operator', harness().passwords.mapped)
  await expect.poll(() => intercepted).not.toBe('')
  await page.unroute(isLoginAction)
  return new URL(intercepted)
}

test('AC4: an authenticated but unmapped provider subject is denied with no session, cookie or token disclosure', async ({ page }) => {
  const since = await databaseNow()
  const exchangesBefore = tokenExchanges()
  await startOidc(page)
  const callback = page.waitForResponse((response) => response.url().includes(CALLBACK_PATH))
  await submitKeycloakLogin(page, 'unmapped-user', harness().passwords.unmapped)
  const response = await callback
  expect(response.status()).toBe(403)
  expect(await response.json()).toMatchObject({ kind: 'SecurityError', error: { code: 'OIDC_SUBJECT_UNMAPPED' } })
  expect(tokenExchanges()).toBe(exchangesBefore + 1)
  await expectNoSession(page, since)
  expect(await cookie(page.context(), OIDC_TRANSACTION_COOKIE)).toBeUndefined()
  expect(await auditTrail(since)).toEqual(expect.arrayContaining(['OIDC:Started:REQUESTED', 'OIDC:Denied:UNMAPPED_SUBJECT']))
  expect((await auditTrail(since)).filter((entry) => entry.includes(':Granted:'))).toEqual([])
  await expectNoLeak(page)
})

test('AC4: a provider error return (user cancelled) fails closed without a token exchange', async ({ page }) => {
  const since = await databaseNow()
  const exchangesBefore = tokenExchanges()
  const authorization = await startOidc(page)
  const state = authorization.searchParams.get('state')!
  const response = await page.goto(`${harness().origin}${CALLBACK_PATH}?error=access_denied&error_description=cancelled&state=${encodeURIComponent(state)}`)
  expect(response?.status()).toBe(401)
  expect(await response?.json()).toMatchObject({ kind: 'SecurityError', error: { code: 'OIDC_CALLBACK_REJECTED' } })
  expect(tokenExchanges()).toBe(exchangesBefore)
  await expectNoSession(page, since)
  expect(await cookie(page.context(), OIDC_TRANSACTION_COOKIE)).toBeUndefined()
  const trail = await auditTrail(since)
  expect(trail.filter((entry) => entry.startsWith('OIDC:Denied:') && !entry.endsWith(':SESSION_INVALID'))).toHaveLength(1)
  expect(trail.filter((entry) => entry.includes(':Granted:'))).toEqual([])
  await expectNoLeak(page, [state])
})

test('AC3/AC4: a callback with a tampered state is rejected before the code is spent and issues no session', async ({ page }) => {
  const since = await databaseNow()
  const exchangesBefore = tokenExchanges()
  const tampered = await captureCallback(page)
  const code = tampered.searchParams.get('code')!
  expect(code.length).toBeGreaterThanOrEqual(16)
  const state = tampered.searchParams.get('state')!
  tampered.searchParams.set('state', `${state.slice(0, -1)}${state.endsWith('A') ? 'B' : 'A'}`)
  const response = await page.goto(tampered.href)
  expect(response?.status()).toBe(401)
  expect(await response?.json()).toMatchObject({ kind: 'SecurityError', error: { code: 'OIDC_CALLBACK_REJECTED' } })
  expect(tokenExchanges()).toBe(exchangesBefore)
  await expectNoSession(page, since)
  await expectNoLeak(page, [code])
})

test('AC3/AC4: replaying a used callback, even with its original transaction cookie, issues no second session', async ({ page, browser }) => {
  const since = await databaseNow()
  const transaction = page.waitForResponse((response) => response.url().includes('/api/console/v0/auth/oidc/start'))
  const callback = await signInMapped(page)
  const transactionCookie = (await (await transaction).headersArray())
    .find((header) => header.name.toLowerCase() === 'set-cookie' && header.value.startsWith(`${OIDC_TRANSACTION_COOKIE}=`))!.value.split(';')[0]
  expect(callback).toContain('code=')
  expect(await sessionsSince(since)).toHaveLength(1)
  const exchangesAfterLogin = tokenExchanges()

  // Strongest replay: URL plus the original transaction cookie. The transaction was consumed.
  const withCookie = await page.request.get(callback, { headers: { cookie: transactionCookie }, failOnStatusCode: false, maxRedirects: 0 })
  expect(withCookie.status()).toBe(401)
  expect(await withCookie.json()).toMatchObject({ error: { code: 'OIDC_TRANSACTION_INVALID' } })

  const stranger = await browser.newContext({ ignoreHTTPSErrors: true })
  const strangerPage = await stranger.newPage()
  const otherBrowser = await strangerPage.goto(callback)
  expect(otherBrowser?.status()).toBe(401)
  expect(await cookie(stranger, SESSION_COOKIE)).toBeUndefined()
  await stranger.close()

  expect(tokenExchanges()).toBe(exchangesAfterLogin)
  expect(await sessionsSince(since)).toHaveLength(1)
  expect(await auditTrail(since)).toEqual(expect.arrayContaining(['OIDC:Denied:TRANSACTION_INVALID']))
  await expectNoLeak(page)
})
