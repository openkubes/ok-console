import { expect, test, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createConsoleBffHandler, prototypeAuthorizer } from '../bff/app.mjs'
import { normalizeOpenKubesObservedState } from '../bff/adapters/openKubesObservedState.mjs'
import { signInPrototype } from './support'

test.setTimeout(60_000)

const historyNote = 'Earlier answers were cleared because the data they used is no longer current.'

// Test-only server; every request normalizes at the injected server time, as the production source does.
async function clockBff(page: Page) {
  const golden = JSON.parse((await readFile(new URL('../bff/openKubesObservedState.fixtures.json', import.meta.url), 'utf8')).replaceAll('openkubes-management', 'community-preview'))
  const envelope = golden.snapshots['hosting-cluster']
  let nowMs = Date.parse(envelope.metadata.observedAt)
  let block = false
  let requests = 0
  const server = createServer(createConsoleBffHandler({
    source: { readSnapshot: async () => normalizeOpenKubesObservedState(envelope, { now: () => new Date(nowMs) }) },
    authorizer: prototypeAuthorizer,
  }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing local BFF address')
  await page.route('**/api/console/v0/**', async route => {
    if (block) return // Deliberately leave requests unresolved, so only the browser ceiling can demote.
    const response = await fetch(`http://127.0.0.1:${address.port}${new URL(route.request().url()).pathname}`)
    await route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() })
    ++requests
  })
  return {
    advance: () => { nowMs += 3600000 },
    block: () => { block = true },
    requests: () => requests,
    close: async () => {
      try { if (!page.isClosed()) await page.unrouteAll({ behavior: 'ignoreErrors' }) }
      finally {
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      }
    },
  }
}
async function noCurrency(page: Page) {
  await expect.poll(async () => (await page.locator('body').innerText()).replaceAll(historyNote, '')).not.toMatch(/\bcurrent(ly)?\b/i)
  await expect(page.locator('.live-dot')).toHaveCount(0)
}
async function navigate(page: Page, path: string) {
  await page.evaluate(hash => { window.location.hash = hash }, `#/${path}`)
}

for (const mechanism of ['server ageing', 'browser ceiling'] as const) {
  test(`${mechanism}: hash navigation downgrades Overview, Clusters, Detail, Evidence, drawer and widget`, async ({ page }) => {
    const bff = await clockBff(page)
    try {
      await page.clock.install()
      await signInPrototype(page)
      const shared = page.locator('.cluster-card').filter({ hasText: 'ok-shared' })
      await expect(shared).toContainText('Current observation')
      await expect(shared.locator('.live-dot')).toHaveCount(1)
      await page.getByRole('button', { name: /Ask OK AI/ }).click()
      await page.getByRole('button', { name: 'Platform status', exact: true }).click()
      await page.clock.pauseAt(new Date(Date.now() + 1000))
      if (mechanism === 'server ageing') {
        const before = bff.requests()
        bff.advance()
        // Navigation shares the same successful-refresh gate as tab-return events.
        await page.evaluate(() => Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }))
        await page.clock.runFor(30_001)
        await page.evaluate(() => Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }))
        await navigate(page, 'clusters')
        await expect.poll(bff.requests).toBeGreaterThan(before)
        await noCurrency(page)
      } else {
        bff.block()
        // Keep every refresh unresolved and advance only the browser monotonic clock.
        await page.clock.runFor(60_001)
        await noCurrency(page)
      }
      await navigate(page, 'overview')
      await expect(page.getByRole('heading', { name: 'Hello Arash' })).toBeVisible()
      await page.getByRole('button', { name: 'Platform status', exact: true }).click()
      await noCurrency(page)
      await navigate(page, 'clusters')
      await expect(page.getByRole('heading', { name: 'Clusters', exact: true })).toBeVisible()
      await noCurrency(page)
      await page.getByRole('button', { name: 'Close OK AI Diagnostic', exact: true }).click()
      await page.getByRole('button', { name: 'Open ok-shared', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Lifecycle posture' })).toBeVisible()
      await page.getByRole('button', { name: /Ask OK AI/ }).click()
      await page.getByRole('button', { name: 'Platform status', exact: true }).click()
      await noCurrency(page)
      await page.getByRole('button', { name: 'Close OK AI Diagnostic', exact: true }).click()
      await page.locator('.evidence-card').first().click()
      await expect(page.locator('.drawer')).toBeVisible()
      await noCurrency(page)
      await page.getByRole('button', { name: 'Close evidence', exact: true }).click()
      await navigate(page, 'evidence')
      await expect(page.getByRole('heading', { name: 'Evidence & Audit' })).toBeVisible()
      await noCurrency(page)
      await page.locator('.evidence-row').first().click()
      await expect(page.locator('.drawer')).toBeVisible()
      await noCurrency(page)
    } finally { await bff.close() }
  })
}
