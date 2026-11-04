import { expect, test, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { normalizeOpenKubesObservedState } from '../bff/adapters/openKubesObservedState.mjs'
import { createConsoleBffHandler, prototypeAuthorizer } from '../bff/app.mjs'
import { injectBffFailure, signInPrototype } from './support'

const serve = async (page: Page, kind: 'item' | 'envelope' | 'deployment' | 'fresh') => {
  const golden = JSON.parse((await readFile(new URL('../bff/openKubesObservedState.fixtures.json', import.meta.url), 'utf8')).replaceAll('openkubes-management', 'community-preview'))
  const envelope = golden.snapshots['hosting-cluster']
  const now = () => new Date(envelope.metadata.observedAt)
  const nowMs = now().getTime()
  const cluster = envelope.data.clusters.find((item: { name: string }) => item.name === 'ok-shared')
  const id = kind === 'deployment' ? envelope.data.placements[0].evidenceId : cluster.evidenceId
  const evidence = envelope.data.evidence.find((item: { id: string }) => item.id === id)
  if (kind === 'item' || kind === 'deployment') evidence.observedAt = new Date(nowMs - 15 * 3600000).toISOString()
  if (kind === 'envelope') envelope.metadata.observedAt = new Date(nowMs - 15 * 3600000).toISOString()
  const snapshot = normalizeOpenKubesObservedState(envelope, { now: () => new Date(nowMs) })
  const server = createServer(createConsoleBffHandler({ source: { readSnapshot: async () => snapshot }, authorizer: prototypeAuthorizer }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No local server address')
  await page.route('**/api/console/v0/**', async route => {
    const response = await fetch(`http://127.0.0.1:${address.port}${new URL(route.request().url()).pathname}`)
    await route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() })
  })
  return { evidence, cluster, close: async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  } }
}

for (const kind of ['item', 'envelope', 'injection'] as const) {
  test(`H1 ${kind}: stale Evidence is historical on detail tab and Evidence page`, async ({ page }) => {
    const fixture = kind === 'injection' ? undefined : await serve(page, kind)
    try {
      if (kind === 'injection') await injectBffFailure(page, 'stale')
      await signInPrototype(page)
      const clusterName = fixture?.cluster.name ?? 'ok-mgmt'
      await page.locator('.cluster-card').filter({ hasText: clusterName }).locator('button.card-main').click()
      await page.getByRole('tab', { name: 'Evidence', exact: true }).click()
      const row = fixture ? page.locator('.evidence-row').filter({ hasText: fixture.evidence.title }) : page.locator('.evidence-row').first()
      await expect(row).toContainText('Last observed: Ready')
      await expect(row.locator('.status-ready')).toHaveCount(0)
      await page.goto('/#/evidence')
      await expect(row).toContainText('Last observed: Ready')
      await expect(row.locator('.status-ready')).toHaveCount(0)
      await page.goto('/#/overview')
      const findings = page.locator('.metric').filter({ hasText: 'Open findings' })
      await expect(findings).toContainText('Unavailable critical policy violations')
      await expect(findings).not.toContainText('0 critical')
    } finally { await fixture?.close() }
  })
}

test('H4 stale hosting deployment shows historical replica figures', async ({ page }) => {
  const fixture = await serve(page, 'deployment')
  try {
    await signInPrototype(page)
    await page.goto('/#/workloads')
    const card = page.locator('.claim-card').filter({ hasText: 'openkubes-console/ok-console' })
    await expect(card.getByText('Unknown', { exact: true })).toBeVisible()
    await expect(card.locator('.decision')).toHaveText('Last observed2/2')
    await expect(card).not.toContainText('Available / desired replicas')
  } finally { await fixture.close() }
})

test('H1 H4 fresh Evidence and replica figures retain their current presentation', async ({ page }) => {
  const fixture = await serve(page, 'fresh')
  try {
    await signInPrototype(page)
    await page.goto('/#/evidence')
    const row = page.locator('.evidence-row').filter({ hasText: fixture.evidence.title })
    await expect(row.locator('.status-ready')).toHaveCount(1)
    await expect(row).not.toContainText('Last observed')
    await page.goto('/#/workloads')
    await expect(page.locator('.claim-card').filter({ hasText: 'openkubes-console/ok-console' }).locator('.decision')).toHaveText('Available / desired replicas2/2')
  } finally { await fixture.close() }
})
