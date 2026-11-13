import { expect, test, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { normalizeOpenKubesObservedState } from '../bff/adapters/openKubesObservedState.mjs'
import { createConsoleBffHandler, prototypeAuthorizer } from '../bff/app.mjs'
import { injectBffFailure, signInPrototype } from './support'

const serve = async (page: Page, kind: 'mixed' | 'mixed-envelope' | 'mixed-capability' | 'item' | 'envelope' | 'deployment' | 'deployment-unlisted' | 'unreferenced' | 'fresh' | 'future' | 'immutable' | 'immutable-future' | 'immutable-current') => {
  const golden = JSON.parse((await readFile(new URL('../bff/openKubesObservedState.fixtures.json', import.meta.url), 'utf8')).replaceAll('openkubes-management', 'community-preview'))
  const envelope = golden.snapshots['hosting-cluster']
  const now = () => new Date(envelope.metadata.observedAt)
  const nowMs = now().getTime()
  const cluster = envelope.data.clusters.find((item: { name: string }) => item.name === 'ok-shared')
  const id = kind.startsWith('deployment') ? envelope.data.placements[0].evidenceId : cluster.evidenceId
  const evidence = envelope.data.evidence.find((item: { id: string }) => item.id === id)
  if (kind === 'item' || kind.startsWith('deployment')) evidence.observedAt = new Date(nowMs - 15 * 3600000).toISOString()
  // A retained deployment observation can outlive its overview placement projection.
  if (kind === 'deployment-unlisted') envelope.data.placements = []
  if (kind === 'unreferenced') envelope.data.evidence.push({ ...structuredClone(evidence), id: 'ev-unreferenced-stale', observedAt: new Date(nowMs - 15 * 3600000).toISOString() })
  if (kind.includes('immutable')) evidence.classification = 'Immutable'
  if (kind.includes('future')) evidence.observedAt = new Date(nowMs + 60001).toISOString()
  if (kind === 'immutable') envelope.metadata.observedAt = new Date(nowMs - 15 * 3600000).toISOString()
  if (kind.startsWith('mixed')) {
    const sibling = { ...structuredClone(cluster), id: 'cluster-drill-fresh', name: 'drill-fresh', evidenceId: 'ev-drill-fresh' }
    envelope.data.clusters.push(sibling)
    envelope.data.evidence.push({ ...structuredClone(evidence), id: sibling.evidenceId, clusterId: sibling.id })
    if (kind === 'mixed-capability') {
      sibling.capabilities = [{ id: 'cap-drill', name: 'Drill capability', readiness: 'Ready', evidenceId: 'ev-drill-cap', ownership: sibling.ownership }]
      envelope.data.evidence.push({ ...structuredClone(evidence), id: 'ev-drill-cap', clusterId: sibling.id, observedAt: new Date(nowMs - 15 * 3600000).toISOString() })
    }
    evidence.observedAt = new Date(nowMs - 15 * 3600000).toISOString()
  }
  await page.clock.setFixedTime(new Date(nowMs))
  if (kind === 'envelope' || kind === 'mixed-envelope') envelope.metadata.observedAt = new Date(nowMs - 15 * 3600000).toISOString()
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


for (const kind of ['item', 'envelope', 'injection', 'fresh', 'deployment', 'deployment-unlisted', 'unreferenced'] as const) {
  test(`J1 ${kind}: cluster lifecycle framing`, async ({ page }) => {
    const fixture = kind === 'injection' ? undefined : await serve(page, kind)
    try {
      if (kind === 'injection') await injectBffFailure(page, 'stale')
      await signInPrototype(page)
      if (kind.startsWith('deployment') || kind === 'unreferenced' || kind === 'fresh') {
        // Worlds A/B: the route verdict includes Evidence beyond the primary reference.
        const current = kind === 'fresh'
        const card = page.locator('.cluster-card').filter({ hasText: fixture!.cluster.name })
        await expect(card).toContainText(current ? 'Current observation' : 'Last observed')
        await expect(card.locator('.live-dot')).toHaveCount(current ? 1 : 0)
        if (!current) await expect(card).not.toContainText('Current observation')
        await page.goto('/#/clusters')
        const row = page.locator('.table-row.cluster-columns').filter({ hasText: fixture!.cluster.name })
        await expect(row).toContainText(current ? 'Current observation' : 'Last observed')
        await expect(row.locator('.live-dot')).toHaveCount(current ? 1 : 0)
        if (!current) {
          await expect(row).not.toContainText('Current observation')
        }
        await page.getByRole('button', { name: `Open ${fixture!.cluster.name}`, exact: true }).click()
      } else {
        await page.locator('.cluster-card').filter({ hasText: fixture?.cluster.name ?? 'ok-mgmt' }).locator('button.card-main').click()
      }
      // #140 includes stale hosting placements in the tenant's response verdict.
      const stale = kind !== 'fresh'
      const unavailable = kind === 'item' || kind === 'envelope' || kind === 'injection'
      await expect(page.locator('.detail-grid .eyebrow').first()).toHaveText(unavailable ? 'Observation unavailable - readiness Unknown' : stale ? 'Last observed posture' : 'Current observation')
      await expect(page.locator('.live-label')).toHaveText(unavailable ? 'Observation unavailable - readiness Unknown' : stale ? 'Last observed' : 'Observed')
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
      if (kind === 'immutable-current') await expect(durability).toHaveText(/Immutable receipt · .*2026/)
      else await expect(durability).toHaveText(expected)
    } finally { await fixture.close() }
  })
}

for (const kind of ['fresh', 'envelope'] as const) {
  test(`J3 ${kind}: BFF Agents contains catalog data without invented runtime observations`, async ({ page }) => {
    const fixture = await serve(page, kind)
    try {
      await signInPrototype(page)
      await page.goto('/#/agents')
      await expect(page.getByRole('heading', { name: 'Kagent Platform Operator' })).toBeVisible()
      await expect(page.locator('.agent-deployments article')).toHaveCount(0)
      await expect(page.locator('main')).not.toContainText('cluster-inspector')
      await expect(page.locator('main')).not.toContainText('Current')
      await expect(page.locator('main .live-dot')).toHaveCount(0)
      await page.goto('/#/evidence')
      await expect(page.locator('.evidence-row').filter({ hasText: 'Kagent cluster inspector readiness' })).toHaveCount(0)
      const row = page.locator('.evidence-row').filter({ hasText: fixture.evidence.title })
      await expect(row).toContainText(kind === 'fresh' ? 'Current observation' : 'Last observed')
      await expect(row.locator('.live-dot')).toHaveCount(kind === 'fresh' ? 1 : 0)
    } finally { await fixture.close() }
  })
}


test('U1 future producer Evidence leaves detail Unknown when its reference is unavailable', async ({ page }) => {
  const fixture = await serve(page, 'future')
  try {
    await signInPrototype(page)
    await page.locator('.cluster-card').filter({ hasText: fixture.cluster.name }).locator('button.card-main').click()
    await expect(page.locator('.title-actions .status')).toHaveText('Unknown')
    await expect(page.locator('.live-label')).toHaveText('Observation unavailable - readiness Unknown')
    await expect(page.locator('main .live-dot')).toHaveCount(0)
    await expect(page.locator('main')).not.toContainText('Current observation')
  } finally { await fixture.close() }
})

test('U5 item-only stale producer observation is explained by the SOURCE_STALE banner', async ({ page }) => {
  const fixture = await serve(page, 'item')
  try {
    await signInPrototype(page)
    await expect(page.locator('.data-warning')).toContainText('Some observations are stale')
    await expect(page.locator('.data-warning')).toContainText('An authorized observation is outside its configured freshness window.')
    await expect(page.locator('.snapshot .live-dot')).toHaveCount(0)
  } finally { await fixture.close() }
})

for (const kind of ['mixed', 'mixed-envelope', 'mixed-capability'] as const) {
  test(`per-cluster ${kind}: real BFF keeps the fresh sibling current and the list banner stale`, async ({ page }) => {
    const fixture = await serve(page, kind)
    try {
      await signInPrototype(page)
      const verdicts = await page.evaluate(async () => {
        const list = await fetch('/api/console/v0/clusters').then(response => response.json())
        const own = await fetch('/api/console/v0/evidence/ev-drill-fresh').then(response => response.json())
        return { list: list.meta.freshness, warnings: list.meta.warnings.map((warning: { code: string }) => warning.code), own: own.meta.freshness }
      })
      expect(verdicts).toMatchObject({ list: 'Stale', own: kind === 'mixed-envelope' ? 'Stale' : 'Current', warnings: expect.arrayContaining(['SOURCE_STALE']) })
      const current = kind === 'mixed'
      const card = page.locator('.cluster-card').filter({ hasText: 'drill-fresh' })
      await expect(card).toContainText(current ? 'Current observation' : 'Unknown')
      await expect(card.locator('.live-dot')).toHaveCount(current ? 1 : 0)
      await page.goto('/#/clusters')
      await expect(page.locator('.data-warning')).toContainText('Some observations are stale')
      const fresh = page.locator('.table-row.cluster-columns').filter({ hasText: 'drill-fresh' })
      const stale = page.locator('.table-row.cluster-columns').filter({ hasText: 'ok-shared' })
      await expect(fresh).toContainText(current ? 'Current observation' : 'Unknown')
      await expect(fresh.locator('.live-dot')).toHaveCount(current ? 1 : 0)
      await expect(stale).toContainText('Unknown')
      await expect(stale.locator('.live-dot')).toHaveCount(0)
      await page.getByRole('button', { name: 'Open drill-fresh', exact: true }).click()
      await expect(page.locator('.live-label .live-dot')).toHaveCount(current ? 1 : 0)
      await expect(page.locator('.live-label')).toHaveText(current ? 'Observed' : kind === 'mixed-capability' ? 'Last observed' : 'Observation unavailable - readiness Unknown')
    } finally { await fixture.close() }
  })
}
