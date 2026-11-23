import { expect, test } from '@playwright/test'
import { CSRF_COOKIE, SESSION_COOKIE, SESSION_PATH, cookie, databaseNow, query, sessionRequest, sessionsSince, signInMapped } from './support'

test('AC8: sign-out revokes the server-side session and clears the session and CSRF cookies', async ({ page, context }) => {
  const since = await databaseNow()
  await signInMapped(page)
  const session = (await cookie(context, SESSION_COOKIE))!
  const csrf = (await cookie(context, CSRF_COOKIE))!
  const oldCookies = `${SESSION_COOKIE}=${session.value}; ${CSRF_COOKIE}=${csrf.value}`

  const forged = await sessionRequest(page, 'DELETE')
  expect(forged.status()).toBe(403)
  expect((await sessionRequest(page, 'GET')).status()).toBe(200)
  expect((await sessionsSince(since))[0].revoked_at).toBeNull()

  const signOut = page.waitForResponse((response) => response.url().endsWith(SESSION_PATH) && response.request().method() === 'DELETE')
  await page.getByRole('button', { name: /^Sign out of / }).click()
  const response = await signOut
  expect(response.status()).toBe(204)
  const cleared = (await response.headersArray()).filter((header) => header.name.toLowerCase() === 'set-cookie').map((header) => header.value)
  for (const name of [SESSION_COOKIE, CSRF_COOKIE]) {
    expect(cleared.some((value) => value.startsWith(`${name}=;`) && /Max-Age=0/i.test(value))).toBe(true)
  }
  await expect(page.getByRole('button', { name: /^Sign out of / })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: /Welcome to/ })).toBeVisible()
  expect(await cookie(context, SESSION_COOKIE)).toBeUndefined()
  expect(await cookie(context, CSRF_COOKIE)).toBeUndefined()

  const rows = await query<{ revoked_at: Date | null }>('SELECT revoked_at FROM ok_console.sessions WHERE issued_at >= $1', [since])
  expect(rows).toHaveLength(1)
  expect(rows[0].revoked_at).not.toBeNull()
  expect((await sessionRequest(page, 'GET', { cookieHeader: oldCookies })).status()).toBe(401)
})
