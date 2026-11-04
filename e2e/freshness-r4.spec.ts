import { expect, test, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { normalizeOpenKubesObservedState } from '../bff/adapters/openKubesObservedState.mjs'
import { createConsoleBffHandler, prototypeAuthorizer } from '../bff/app.mjs'
import { injectBffFailure, signInPrototype } from './support'

const serve = async (page: Page, kind: 'item' | 'envelope' | 'deployment' | 'fresh' | 'future' | 'immutable' | 'immutable-future' | 'immutable-current') => {
  const golden = JSON.parse((await readFile(new URL('../bff/openKubesObservedState.fixtures.json', import.meta.url), 'utf8')).replaceAll('openkubes-management', 'community-preview'))
  const envelope = golden.snapshots['hosting-cluster']
  const now = () => new Date(envelope.metadata.observedAt)
  const nowMs = now().getTime()
  const cluster = envelope.data.clusters.find((item: { name: string }) => item.name === 'ok-shared')
  const id = kind === 'deployment' ? envelope.data.placements[0].evidenceId : cluster.evidenceId
  const evidence = envelope.data.evidence.find((item: { id: string }) => item.id === id)
  if (kind === 'item' || kind === 'deployment') evidence.observedAt = new Date(nowMs - 15 * 3600000).toISOString()
  if (kind.includes('immutable')) evidence.classification = 'Immutable'
  if (kind.includes('future')) evidence.observedAt = new Date(nowMs + 60001).toISOString()
  if (kind === 'immutable') envelope.metadata.observedAt = new Date(nowMs - 15 * 3600000).toISOString()
  await page.clock.setFixedTime(new Date(nowMs))
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


for (const kind of ['item', 'envelope', 'injection', 'fresh', 'deployment'] as const) {
  test(`J1 ${kind}: cluster lifecycle framing`, async ({ page }) => {
    const fixture = kind === 'injection' ? undefined : await serve(page, kind)
    try {
      if (kind === 'injection') await injectBffFailure(page, 'stale')
      await signInPrototype(page)
      await page.locator('.cluster-card').filter({ hasText: fixture?.cluster.name ?? 'ok-mgmt' }).locator('button.card-main').click()
      const stale = kind === 'item' || kind === 'envelope' || kind === 'injection'
      await expect(page.locator('.detail-grid .eyebrow').first()).toHaveText(stale ? 'Last observed posture' : 'Current observation')
      await expect(page.locator('.live-label')).toHaveText(stale ? 'Last observed' : 'Observed')
      await expect(page.locator('.live-label .live-dot')).toHaveCount(stale ? 0 : 1)
      const details = await page.locator('.lifecycle-step p').allTextContents()
      expect(details.length).toBeGreaterThan(0)
      for (const text of details) expect(text.startsWith('Last observed: ')).toBe(stale)
      if (kind !== 'injection') {
        await expect(page.locator('.lifecycle')).toContainText(`${stale ? 'Last observed: ' : ''}Ready: 1; not ready: 0`)
        await expect(page.locator('.lifecycle')).toContainText(`${stale ? 'Last observed: ' : ''}Available replicas: 2 of 2`)
      }
      await page.getByRole('tab', { name: 'Lifecycle', exact: true }).click()
      await expect(page.locator('.wide-panel .eyebrow')).toHaveText(stale ? 'Intent → last observation' : 'Intent → observation')
      await expect(page.locator('.timeline p')).toHaveText(details)
    } finally { await fixture?.close() }
  })
}

for (const kind of ['future', 'immutable', 'immutable-future', 'immutable-current', 'fresh'] as const) {
  test(`J2 ${kind}: drawer durability`, async ({ page }) => {
    const fixture = await serve(page, kind)
    try {
      await signInPrototype(page)
      await page.goto('/#/evidence')
      await page.locator('.evidence-row').filter({ hasText: fixture.evidence.title }).click()
      const durability = page.getByRole('dialog').locator('dl > div').filter({ hasText: 'Durability' }).locator('dd')
      const expected = kind === 'fresh' ? 'Current, freshness-bound observation'
        : kind === 'immutable-current' ? 'Immutable receipt'
        : kind === 'immutable' ? 'Immutable receipt · Stale observation: older than the freshness window'
        : `${kind === 'immutable-future' ? 'Immutable receipt · ' : ''}Stale observation: dated in the future (clock fault)`
      await expect(durability).toHaveText(expected)
    } finally { await fixture.close() }
  })
}
