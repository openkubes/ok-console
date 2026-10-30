import { expect, test } from '@playwright/test'
import { injectBffFailure, signInPrototype } from './support'

for (const failure of ['stale', 'degraded'] as const) {
  test(`${failure} observations remain usable and visibly qualified`, async ({ page }) => {
    await injectBffFailure(page, failure)
    await signInPrototype(page)
    await expect(page.getByRole('status')).toContainText(failure === 'stale' ? 'Some observations are stale' : 'Platform data is partially degraded')
    await expect(page.getByRole('heading', { name: 'Cluster posture' })).toBeVisible()
    if (failure === 'stale') {
      const clusters = page.locator('.cluster-card')
      await expect(clusters).toHaveCount(4)
      await expect(clusters.getByText('Unknown', { exact: true })).toHaveCount(4)
      await expect(clusters.getByText('Ready', { exact: true })).toHaveCount(0)
      await expect(page.getByRole('region', { name: 'Platform metrics' })).toContainText('Unavailable')
    }
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

test('stale Current Evidence renders the affected cluster Unknown', async ({ page }) => {
  const { createServer } = await import('node:http')
  const { readFile } = await import('node:fs/promises')
  const { normalizeOpenKubesObservedState } = await import('../bff/adapters/openKubesObservedState.mjs')
  const { createConsoleBffHandler, prototypeAuthorizer } = await import('../bff/app.mjs')
  const fixture = JSON.parse(await readFile(new URL('../bff/fixtures/observed-state.json', import.meta.url), 'utf8'))
  for (const item of fixture.evidence) item.observedAt = fixture.observedAt
  const cluster = fixture.clusters[0]
  const evidence = fixture.evidence.find((item: { id: string }) => item.id === cluster.evidenceId)
  evidence.classification = 'Current'
  evidence.observedAt = new Date(Date.parse(fixture.observedAt) - 15 * 3600000).toISOString()
  const snapshot = normalizeOpenKubesObservedState({
    apiVersion: 'observed.openkubes.io/v0alpha2', kind: 'ConsoleObservedState',
    metadata: { observedAt: fixture.observedAt, sourceRevision: fixture.sourceRevision }, data: fixture,
  }, { now: () => new Date(fixture.observedAt) })
  const server = createServer(createConsoleBffHandler({ source: { readSnapshot: async () => snapshot }, authorizer: prototypeAuthorizer }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No fixture server address')
    await page.route('**/api/console/v0/**', async route => {
      const response = await fetch(`http://127.0.0.1:${address.port}${new URL(route.request().url()).pathname}`)
      await route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() })
    })
    await signInPrototype(page)
    const affectedCluster = page.getByRole('article').filter({ hasText: cluster.name })
    await expect(affectedCluster.getByText('Unknown', { exact: true })).toBeVisible()
    await expect(affectedCluster.getByText('Ready', { exact: true })).toHaveCount(0)
    await affectedCluster.locator('button.card-main').click()
    await expect(page.getByRole('heading', { name: 'ok-mgmt', exact: true })).toBeVisible()
    const basis = page.locator('button.evidence-card').filter({ hasText: evidence.title })
    await expect(basis.getByText('Last observed: Ready', { exact: true })).toBeVisible()
    await expect(basis.locator('.status-ready')).toHaveCount(0)
    await basis.click()
    const drawer = page.getByRole('dialog')
    await expect(drawer).toContainText('Stale observation: older than the freshness window')
    await expect(drawer.getByText('Last observed: Ready', { exact: true })).toBeVisible()
    await expect(drawer.locator('.status-ready')).toHaveCount(0)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
