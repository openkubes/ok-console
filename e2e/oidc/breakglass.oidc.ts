import { expect, test } from '@playwright/test'
import {
  SESSION_COOKIE, authenticationAuditSince, bffLog, browserStorageDump, cookie, databaseNow, harness, leaks,
  localAccess, openSignIn, query, sessionsSince,
} from './support'

const REASON = 'OK-173 disposable proof: identity provider maintenance window'
const localAuditSince = (since: Date) => query<{ authentication_method: string, outcome: string, cause: string, operational_reason: string, correlation_id: string, principal_digest: string }>(
  'SELECT authentication_method, outcome, cause, operational_reason, correlation_id, principal_digest FROM ok_console.local_access_audit WHERE occurred_at >= $1 ORDER BY event_id', [since])

test.beforeEach(async () => {
  await query('DELETE FROM ok_console.local_access_throttle')
})

test('AC5/AC6: break-glass is reachable only through the exceptional-access path and yields a short-lived, audited session', async ({ page, context }) => {
  const since = await databaseNow()
  const password = harness().passwords.local
  await openSignIn(page)
  await page.getByRole('button', { name: /Use a local account/ }).click()
  await expect(page.getByRole('heading', { name: 'Break-glass access' })).toBeVisible()
  await expect(page.getByText('This attempt is rate-limited, short-lived, reason-bound')).toBeVisible()
  const submit = page.getByRole('button', { name: /Authenticate and enter Console/ })
  await page.getByLabel('Local username').fill('breakglass-operator')
  await page.locator('input[autocomplete="current-password"]').fill(password)
  await page.getByLabel('Operational reason').fill(REASON)
  await expect(submit).toBeDisabled()
  await page.getByRole('checkbox').check()
  await submit.click()
  await page.waitForURL(`${harness().origin}/`)
  await expect(page.getByText('Break-glass session')).toBeVisible()

  const sessions = await sessionsSince(since)
  expect(sessions).toHaveLength(1)
  expect(sessions[0]).toMatchObject({ authentication_method: 'BreakGlass', revoked_at: null })
  expect(sessions[0].absolute_expires_at.getTime() - sessions[0].issued_at.getTime()).toBe(15 * 60 * 1_000)
  expect(Number(sessions[0].idle_lifetime_ms)).toBe(5 * 60 * 1_000)

  const local = await localAuditSince(since)
  expect(local).toEqual([expect.objectContaining({ authentication_method: 'BreakGlass', outcome: 'Granted', operational_reason: REASON })])
  expect(local[0].principal_digest).not.toContain('breakglass-operator')
  // The anonymous page load first records the rejected session restore; then exactly one grant.
  expect((await authenticationAuditSince(since)).filter((row) => row.cause !== 'SESSION_INVALID')).toEqual([expect.objectContaining({ authentication_method: 'BreakGlass', outcome: 'Granted', operational_reason: REASON, correlation_id: local[0].correlation_id })])

  const session = await cookie(context, SESSION_COOKIE)
  const audit = JSON.stringify(await query('SELECT * FROM ok_console.local_access_audit UNION ALL SELECT NULL, principal_digest, authentication_method, outcome, cause, operational_reason, correlation_id, occurred_at FROM ok_console.authentication_audit'))
  expect(leaks(audit, [password, session!.value])).toEqual([])
  expect(leaks(bffLog(), [password, session!.value])).toEqual([])
  expect(leaks(await browserStorageDump(page), [password])).toEqual([])
})

test('AC6: local access without an operational reason, or from a foreign origin, is refused and audited', async ({ page }) => {
  const since = await databaseNow()
  const password = harness().passwords.local
  const missing = await localAccess(page, { username: 'breakglass-operator', password })
  // Boundary: 11 characters is one short of the 12-character minimum.
  const short = await localAccess(page, { username: 'breakglass-operator', password, reason: 'eleven char' })
  const foreign = await localAccess(page, { username: 'breakglass-operator', password, reason: REASON }, 'https://attacker.invalid')
  expect([missing.status(), short.status(), foreign.status()]).toEqual([401, 401, 403])
  expect(await foreign.json()).toMatchObject({ error: { code: 'ORIGIN_REJECTED' } })
  expect(await sessionsSince(since)).toHaveLength(0)
  expect((await authenticationAuditSince(since)).map((row) => [row.authentication_method, row.outcome, row.cause]))
    .toEqual([['BreakGlass', 'Denied', 'REQUEST_INVALID'], ['BreakGlass', 'Denied', 'REQUEST_INVALID'], ['BreakGlass', 'Denied', 'ORIGIN_REJECTED']])
  expect([...'eleven char']).toHaveLength(11)
})

test('AC6: repeated failures throttle the account so even the correct password is refused, and each refusal is audited', async ({ page }) => {
  const since = await databaseNow()
  for (let attempt = 0; attempt < 5; attempt += 1) {
    expect((await localAccess(page, { username: 'breakglass-operator', password: `wrong-password-${attempt}`, reason: REASON })).status()).toBe(401)
  }
  const blocked = await localAccess(page, { username: 'breakglass-operator', password: harness().passwords.local, reason: REASON })
  expect(blocked.status()).toBe(401)
  expect(await sessionsSince(since)).toHaveLength(0)
  expect(await query('SELECT 1 FROM ok_console.local_access_throttle WHERE blocked_until > clock_timestamp()')).toHaveLength(1)
  const causes = (await localAuditSince(since)).map((row) => `${row.outcome}:${row.cause}`)
  expect(causes).toEqual([...Array(5).fill('Denied:INVALID_CREDENTIAL'), 'Denied:THROTTLED'])
})
