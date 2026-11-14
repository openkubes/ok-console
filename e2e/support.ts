import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, type TestInfo } from '@playwright/test'

export const signInPrototype = async (page: Page) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Continue with OpenKubes Identity' }).click()
  await page.getByRole('button', { name: 'Simulate identity provider return' }).click()
  await page.getByRole('button', { name: 'Enter Console' }).click()
  await expect(page.getByRole('heading', { name: 'Hello Arash' })).toBeVisible()
}

export const openPrimaryNavigation = async (page: Page) => {
  const opener = page.getByRole('button', { name: 'Open navigation' })
  if (await opener.isVisible()) await opener.click()
}

export const assertWcagAa = async (page: Page, testInfo: TestInfo, surface: string) => {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  await testInfo.attach(`axe-${surface}.json`, {
    body: JSON.stringify(results.violations, null, 2),
    contentType: 'application/json',
  })
  expect(results.violations, `${surface} must have zero automated WCAG A/AA violations`).toEqual([])
}

export const injectBffFailure = async (page: Page, failure: 'stale' | 'degraded' | 'forbidden' | 'unavailable' | 'incompatible') => {
  await page.route('**/api/console/v0/**', async (route) => {
    const target = new URL(route.request().url())
    target.searchParams.set('failure', failure)
    await route.continue({ url: target.href })
  })
}


// Called before installing the injector, against the test-only pinned-clock server.
export const assertCurrentFixture = async (page: Page) => {
  await signInPrototype(page)
  const response = await page.request.get('/api/console/v0/overview')
  expect(response.ok()).toBe(true)
  const baseline = await response.json()
  expect(baseline.meta.freshness).toBe('Current')
  for (const code of ['SOURCE_STALE', 'PARTIAL_DATA']) {
    expect(baseline.meta.warnings).not.toContainEqual(expect.objectContaining({ code }))
  }
  const metrics = page.getByRole('region', { name: 'Platform metrics' })
  await expect(metrics.locator('.metric > strong')).toHaveText(['4', '7', '3', '2'])
  await expect(metrics.locator('.metric > small')).toHaveText(['4 ready · 1 management plane', '5 conformant · 2 converging', '1 ready · 2 in progress', '0 critical policy violations'])
  const management = page.locator('.cluster-card').filter({ hasText: 'ok-mgmt' })
  await expect(management.getByText('Ready', { exact: true })).toBeVisible()
  await expect(management.getByText('Unknown', { exact: true })).toHaveCount(0)
}

export const assertUnavailableMetrics = async (page: Page) => {
  const metrics = page.getByRole('region', { name: 'Platform metrics' })
  await expect(metrics.locator('.metric > strong')).toHaveText(Array(4).fill('Unavailable'))
  await expect(metrics.locator('.metric > small')).toHaveText(Array(4).fill('Unavailable'))
}
