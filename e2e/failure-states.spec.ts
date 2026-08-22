import { expect, test } from '@playwright/test'
import { injectBffFailure, signInPrototype } from './support'

for (const failure of ['stale', 'degraded'] as const) {
  test(`${failure} observations remain usable and visibly qualified`, async ({ page }) => {
    await injectBffFailure(page, failure)
    await signInPrototype(page)
    await expect(page.getByRole('status')).toContainText(failure === 'stale' ? 'Some observations are stale' : 'Platform data is partially degraded')
    await expect(page.getByRole('heading', { name: 'Cluster posture' })).toBeVisible()
  })
}

for (const failure of ['forbidden', 'unavailable', 'incompatible'] as const) {
  test(`${failure} fails closed with a bounded correlation-bearing view`, async ({ page }) => {
    await injectBffFailure(page, failure)
    await page.goto('/')
    await page.getByRole('button', { name: 'Continue with OpenKubes Identity' }).click()
    await page.getByRole('button', { name: 'Simulate identity provider return' }).click()
    await page.getByRole('button', { name: 'Enter Console' }).click()

    const alert = page.getByRole('alert')
    await expect(alert).toContainText('Platform data is unavailable')
    await expect(alert).toContainText(/Correlation ID corr-[0-9a-f-]+/)
    await expect(alert).not.toContainText(/stack|exception|postgres|observed-state|cookie|authorization header/i)
    if (failure === 'unavailable') await expect(page.getByRole('button', { name: 'Retry safely' })).toBeVisible()
  })
}
