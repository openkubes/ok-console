import { expect, test, type Page } from '@playwright/test'
import {
  CALLBACK_PATH, OIDC_TRANSACTION_COOKIE, SESSION_COOKIE, authenticationAuditSince, bffLog, browserStorageDump, cookie,
  databaseNow, harness, leaks, protectedValues, sessionRequest, sessionsSince, signInMapped, startOidc, submitKeycloakLogin,
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

const expectNoLeak = async (page: Page) => {
  const secrets = protectedValues()
  expect(leaks(await browserStorageDump(page), secrets.filter((value) => !page.url().includes(value)))).toEqual([])
  expect(leaks(bffLog(), secrets)).toEqual([])
}

test('AC4: an authenticated but unmapped provider subject is denied with no session, cookie or token disclosure', async ({ page }) => {
  const since = await databaseNow()
  await startOidc(page)
  const callback = page.waitForResponse((response) => response.url().includes(CALLBACK_PATH))
  await submitKeycloakLogin(page, 'unmapped-user', harness().passwords.unmapped)
  const response = await callback
  expect(response.status()).toBe(403)
  expect(await response.json()).toMatchObject({ kind: 'SecurityError', error: { code: 'OIDC_SUBJECT_UNMAPPED' } })
  await expectNoSession(page, since)
  expect(await cookie(page.context(), OIDC_TRANSACTION_COOKIE)).toBeUndefined()
  expect(await auditTrail(since)).toEqual(expect.arrayContaining(['OIDC:Started:REQUESTED', 'OIDC:Denied:UNMAPPED_SUBJECT']))
  expect((await auditTrail(since)).filter((entry) => entry.includes(':Granted:'))).toEqual([])
  await expectNoLeak(page)
})

test('AC4: a provider error return (user cancelled) fails closed', async ({ page }) => {
  const since = await databaseNow()
  const authorization = await startOidc(page)
  const state = authorization.searchParams.get('state')!
  const response = await page.goto(`${harness().origin}${CALLBACK_PATH}?error=access_denied&error_description=cancelled&state=${encodeURIComponent(state)}`)
  expect(response?.status()).toBeGreaterThanOrEqual(400)
  expect(response?.status()).toBeLessThan(500)
  await expectNoSession(page, since)
  expect(await cookie(page.context(), OIDC_TRANSACTION_COOKIE)).toBeUndefined()
  const trail = await auditTrail(since)
  expect(trail.filter((entry) => entry.startsWith('OIDC:Denied:') && !entry.endsWith(':SESSION_INVALID'))).toHaveLength(1)
  expect(trail.filter((entry) => entry.includes(':Granted:'))).toEqual([])
})

test('AC3/AC4: a callback with a tampered state is rejected and issues no session', async ({ page }) => {
  const since = await databaseNow()
  // Redirect hops cannot be intercepted, so take the callback URL from the provider's own
  // redirect and never let the browser follow it: the authorization code stays unused.
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
  const tampered = new URL(intercepted)
  const state = tampered.searchParams.get('state')!
  tampered.searchParams.set('state', `${state.slice(0, -1)}${state.endsWith('A') ? 'B' : 'A'}`)
  const response = await page.goto(tampered.href)
  expect(response?.status()).toBe(401)
  expect(await response?.json()).toMatchObject({ kind: 'SecurityError', error: { code: 'OIDC_CALLBACK_REJECTED' } })
  await expectNoSession(page, since)
  await expectNoLeak(page)
})

test('AC3/AC4: replaying a used callback URL, with or without the original browser, issues no second session', async ({ page, browser }) => {
  const since = await databaseNow()
  const callback = await signInMapped(page)
  expect(callback).toContain('code=')
  expect(await sessionsSince(since)).toHaveLength(1)

  const sameBrowser = await page.goto(callback)
  expect(sameBrowser?.status()).toBe(401)

  const stranger = await browser.newContext({ ignoreHTTPSErrors: true })
  const strangerPage = await stranger.newPage()
  const otherBrowser = await strangerPage.goto(callback)
  expect(otherBrowser?.status()).toBe(401)
  expect(await cookie(stranger, SESSION_COOKIE)).toBeUndefined()
  await stranger.close()

  expect(await sessionsSince(since)).toHaveLength(1)
  await expectNoLeak(page)
})
