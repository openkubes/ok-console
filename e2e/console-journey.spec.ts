import { expect, test } from '@playwright/test'
import { assertWcagAa, openPrimaryNavigation, signInPrototype } from './support'

test('sign-in to Overview, Clusters, Detail, and Evidence uses the same-origin BFF', async ({ page }, testInfo) => {
  const apiResponses: Array<{ url: string, status: number }> = []
  page.on('response', (response) => {
    if (response.url().includes('/api/console/v0/')) apiResponses.push({ url: response.url(), status: response.status() })
  })

  await signInPrototype(page)
  await expect(page.getByText('Console BFF')).toBeVisible()
  await expect(page.getByRole('article').filter({ hasText: 'ok-mgmt' }).getByText('4 capabilities')).toBeVisible()
  await assertWcagAa(page, testInfo, 'overview')
  await page.screenshot({ path: testInfo.outputPath('overview.png'), fullPage: true })

  await openPrimaryNavigation(page)
  await page.getByRole('link', { name: /Clusters Lifecycle contracts/ }).click()
  await expect(page.getByRole('heading', { name: 'Clusters' })).toBeVisible()
  await page.getByRole('button', { name: /^ok-mgmt/ }).click()
  await expect(page.getByRole('heading', { name: 'ok-mgmt' })).toBeVisible()
  await expect(page.getByText('Lifecycle posture')).toBeVisible()

  await page.getByRole('tab', { name: 'Evidence' }).click()
  const evidence = page.locator('.evidence-row').first()
  await expect(evidence).toBeVisible()
  await evidence.click()
  await expect(page.getByRole('dialog', { name: /readiness/i })).toBeVisible()
  await assertWcagAa(page, testInfo, 'evidence-dialog')
  await page.screenshot({ path: testInfo.outputPath('cluster-evidence.png'), fullPage: true })
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)

  expect(apiResponses.length).toBeGreaterThanOrEqual(5)
  expect(apiResponses.every(({ url, status }) => new URL(url).origin === 'http://127.0.0.1:8787' && status === 200)).toBe(true)
})

test('keyboard path exposes focus and reaches the main landmark', async ({ page }) => {
  await page.goto('/')
  await page.keyboard.press('Tab')
  const provider = page.getByRole('button', { name: 'Continue with OpenKubes Identity' })
  await expect(provider).toBeFocused()
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: 'Simulate identity provider return' }).click()
  await page.getByRole('button', { name: 'Enter Console' }).click()
  await expect(page.getByRole('heading', { name: 'Hello Arash' })).toBeVisible()

  await page.keyboard.press('Tab')
  const skip = page.getByRole('link', { name: 'Skip to content' })
  await expect(skip).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('#main-content')).toBeFocused()
})
