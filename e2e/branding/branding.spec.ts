import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { brandingE2eTargets } from './targets'

const signIn = async (page: Page) => {
  await page.getByRole('button', { name: /Continue with OpenKubes Identity/ }).click()
  await page.getByRole('button', { name: /Simulate identity provider return/i }).click()
  await page.getByRole('button', { name: /Enter Console/i }).click()
}

const watchConsole = (page: Page) => {
  const problems: string[] = []
  page.on('console', (message) => { if (['error', 'warning'].includes(message.type())) problems.push(message.text()) })
  page.on('pageerror', (error) => problems.push(String(error)))
  return problems
}


const installationOf = (html: string) => JSON.parse(/<script type="application\/json" id="ok-console-installation">([^<]*)<\/script>/.exec(html)?.[1] ?? 'null')

// Lifecycle follows the deployment policy only, checked in the UI and directly against the server.
const expectLifecycle = async (page: Page, request: APIRequestContext, base: string, policy: 'fixture-read-only' | null) => {
  const installation = installationOf(await (await request.get(`${base}/`)).text())
  expect(installation.deploymentPolicy).toEqual({ schema: 'openkubes.console.deployment-policy/v1', policy: policy ?? 'default', clusterLifecycle: !policy })
  const dryRun = await request.post(`${base}/api/console/v0/operations/create-cluster/dry-run`, { data: { contract: {} } })
  if (!policy) {
    expect(await dryRun.text()).not.toContain('DEPLOYMENT_POLICY_READ_ONLY')
    await expect(page.locator('a[href="#/create"]')).toHaveCount(1)
    await expect(page.locator('a[href="#/register"]')).toHaveCount(1)
    return
  }
  expect(dryRun.status()).toBe(403)
  expect((await dryRun.json()).error.code).toBe('DEPLOYMENT_POLICY_READ_ONLY')
  const userWrite = await request.post(`${base}/api/console/v0/local-identity/create`, { data: {} })
  expect(userWrite.status()).toBe(403)
  await expect(page.locator('a[href="#/create"], a[href="#/register"]')).toHaveCount(0)
  await expect(page.locator('.cluster-quick-actions [aria-disabled="true"]')).toHaveCount(2)
  const lifecycleRequests: string[] = []
  page.on('request', (r) => { if (r.url().includes('create-cluster')) lifecycleRequests.push(r.url()) })
  await page.goto(`${base}/#/create`)
  await expect(page.getByRole('note', { name: 'Cluster lifecycle not available' })).toContainText('fixture-read-only deployment policy')
  await page.goto(`${base}/#/register`)
  await expect(page.getByRole('note', { name: 'Cluster lifecycle not available' })).toBeVisible()
  expect(lifecycleRequests).toEqual([])
}

for (const target of brandingE2eTargets()) {
  test.describe(`branding: ${target.name}`, () => {
    const base = `http://127.0.0.1:${target.port}`

    test('serves the right identity from the first byte, through login and into the Console', async ({ page, request }) => {
      const problems = watchConsole(page)
      const html = await (await request.get(`${base}/`)).text()
      const installation = installationOf(html)
      expect((await request.get(`${base}/branding/branding.json`)).status()).toBe(404)

      if (!target.config) {
        expect(installation.branding).toBeNull()
        expect(html).toContain('<title>OpenKubes Console</title>')
        await page.goto(`${base}/#/overview`)
        await expect(page.getByRole('heading', { level: 1, name: 'Welcome to OpenKubes' })).toBeVisible()
        await expect(page.locator('.powered-by')).toHaveCount(0)
        await signIn(page)
        await expect(page.getByRole('button', { name: 'Sign out of OpenKubes Console' })).toBeVisible()
        await expect(page.locator('.brand')).toContainText('OpenKubes')
        await expect(page.getByRole('button', { name: /Ask OK AI/ })).toBeVisible()
        await expect(page).toHaveTitle(/· OpenKubes Console$/)
        await expectLifecycle(page, request, base, target.policy)
        expect(problems).toEqual([])
        return
      }

      const brand = target.config
      const shortName = brand.productShortName ?? brand.productName
      expect(installation.branding).toEqual(brand)
      expect(html).toContain(`<title>${brand.productName}</title>`)
      expect(html).toContain(`href="./branding/${brand.favicon}"`)
      expect(html).not.toMatch(/OpenKubes Console|openkubes-icon/)

      await page.goto(`${base}/#/overview`)
      await expect(page.getByRole('heading', { level: 1, name: `Welcome to ${shortName}` })).toBeVisible()
      await expect(page.locator('.auth-brand img')).toHaveAttribute('src', `./branding/${brand.logo.file}`)
      await expect(page.locator('.auth-brand img')).toHaveJSProperty('complete', true)
      expect(await page.locator('.auth-brand img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
      await expect(page.getByText(`${shortName} evaluates authority separately`, { exact: false })).toBeVisible()
      if (brand.poweredBy) await expect(page.locator('.auth-powered-by')).toHaveText(`Powered by ${brand.poweredBy.name}`)
      else await expect(page.locator('.powered-by')).toHaveCount(0)

      await signIn(page)
      await expect(page.getByRole('button', { name: `Sign out of ${brand.productName}` })).toBeVisible()
      await expect(page).toHaveTitle(new RegExp(`· ${brand.productName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))
      await expect(page.locator('.brand')).toContainText(shortName)
      await expect(page.locator('.breadcrumbs')).toContainText(shortName)
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--blue').trim())).toBe(brand.colors.primary.toLowerCase())

      // Generic wording is neutral; technical origin stays visible.
      await expect(page.getByText('One evidence-backed view across your sovereign Kubernetes platforms.')).toBeVisible()
      await expect(page.getByRole('button', { name: /Ask AI/ })).toBeVisible()
      await expect(page.getByText(/OK AI/)).toHaveCount(0)
      await expect(page.locator('.context-switcher')).toContainText('OpenKubes Platform')
      await expect(page.locator('.product-footer')).toContainText('Built on OpenKubes Console')

      await expectLifecycle(page, request, base, target.policy)
      expect(problems).toEqual([])
    })
  })
}

test('a configured brand that fails in the browser never falls back to the built-in identity', async ({ page }) => {
  const configured = brandingE2eTargets().find((target) => target.config)!
  // Simulates a broken brand reaching the browser (the BFF itself refuses to start with one).
  await page.route(`http://127.0.0.1:${configured.port}/`, async (route) => {
    const response = await route.fetch()
    const html = (await response.text()).replace(/("branding":)\{.*?\},("deploymentPolicy")/, '$1{"schema":"broken"},$2')
    await route.fulfill({ response, body: html })
  })
  page.on('console', () => undefined)
  await page.goto(`http://127.0.0.1:${configured.port}/`)
  await expect(page.getByRole('alert')).toContainText('Console unavailable')
  await expect(page).toHaveTitle('Console unavailable')
  const text = await page.locator('body').innerText()
  for (const name of ['OpenKubes', configured.config!.productName, configured.config!.productShortName ?? configured.config!.productName]) expect(text).not.toContain(name)
  await expect(page.locator('img')).toHaveCount(0)
})
