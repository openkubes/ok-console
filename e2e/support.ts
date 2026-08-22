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
