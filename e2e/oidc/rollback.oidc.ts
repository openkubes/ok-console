import { expect, test } from '@playwright/test'
import {
  CSRF_COOKIE, SESSION_COOKIE, cookie, databaseNow, harness, openSignIn, restartBff, sessionRequest, sessionsSince, signInMapped,
} from './support'

// Runs after the OIDC + break-glass project (see playwright.oidc.config.ts) because it relaunches
// the BFF. The rollback procedure is docs/security/ok-173-oidc-provider-and-rollback.md.

/** Positive control that a relaunch really changed the mode: OIDC start redirects to the issuer only when federation is on. */
const expectFederation = async (page: import('@playwright/test').Page, enabled: boolean) => {
  const start = await page.request.get(`${harness().origin}/api/console/v0/auth/oidc/start`, { failOnStatusCode: false, maxRedirects: 0, headers: { cookie: '' } })
  if (enabled) {
    expect(start.status()).toBe(302)
    expect(start.headers().location?.startsWith(`${harness().issuer}/protocol/openid-connect/auth`)).toBe(true)
  } else {
    // No OIDC handler: the anonymous request falls through to the generic projection guard.
    expect(start.status()).toBe(403)
    expect(start.headers().location).toBeUndefined()
    expect(await start.json()).toMatchObject({ error: { code: 'FORBIDDEN' } })
  }
}

const signedInCookies = async (page: import('@playwright/test').Page) => {
  await signInMapped(page)
  const session = (await cookie(page.context(), SESSION_COOKIE))!
  const csrf = (await cookie(page.context(), CSRF_COOKIE))!
  return `${SESSION_COOKIE}=${session.value}; ${CSRF_COOKIE}=${csrf.value}`
}

test('AC11: rollback to bootstrap-only removes federation, rejects existing OIDC sessions and keeps the audited bootstrap path', async ({ page, browser }) => {
  const oidcCookies = await signedInCookies(page)
  await restartBff('bootstrap', { epoch: 'ok173-e2e-epoch-rollback' })

  await expectFederation(page, false)
  expect((await sessionRequest(page, 'GET', { cookieHeader: oidcCookies })).status()).toBe(401)

  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const fresh = await context.newPage()
  await openSignIn(fresh)
  await expect(fresh.getByRole('button', { name: /Continue with/ })).toHaveCount(0)
  await expect(fresh.getByText('Use the reviewed bootstrap account')).toBeVisible()
  await fresh.getByRole('button', { name: /Use a local account/ }).click()
  await expect(fresh.getByRole('heading', { name: 'Bootstrap access' })).toBeVisible()

  const since = await databaseNow()
  await fresh.getByLabel('Local username').fill('bootstrap-admin')
  await fresh.locator('input[autocomplete="current-password"]').fill(harness().passwords.local)
  await fresh.getByLabel('Operational reason').fill('OK-173 disposable proof: rollback to bootstrap-only')
  await fresh.getByRole('checkbox').check()
  await fresh.getByRole('button', { name: /Authenticate and enter Console/ }).click()
  await fresh.waitForURL(`${harness().origin}/`)
  await expect(fresh.getByText('Bootstrap session')).toBeVisible()
  const sessions = await sessionsSince(since)
  expect(sessions).toHaveLength(1)
  expect(sessions[0]).toMatchObject({ authentication_method: 'Bootstrap', deployment_epoch: 'ok173-e2e-epoch-rollback' })
  await context.close()
})

test('AC11: the session-epoch change in the rollback procedure is what rejects existing OIDC sessions', async ({ page }) => {
  await restartBff('breakglass', { epoch: 'ok173-e2e-epoch-forward' })
  await expectFederation(page, true)
  const oidcCookies = await signedInCookies(page)
  // Same epoch as the OIDC session: the procedure's epoch step deliberately omitted. The OIDC
  // session survives; rollback then depends on that manual step (tracked as a follow-up).
  await restartBff('bootstrap', { epoch: 'ok173-e2e-epoch-forward' })
  await expectFederation(page, false)
  expect((await sessionRequest(page, 'GET', { cookieHeader: oidcCookies })).status()).toBe(200)
  await restartBff('bootstrap', { epoch: 'ok173-e2e-epoch-rollback-2' })
  await expectFederation(page, false)
  expect((await sessionRequest(page, 'GET', { cookieHeader: oidcCookies })).status()).toBe(401)
})
