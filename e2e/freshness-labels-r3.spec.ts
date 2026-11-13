import { expect, test } from '@playwright/test'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createConsoleBffHandler, prototypeAuthorizer } from '../bff/app.mjs'
import { normalizeOpenKubesObservedState } from '../bff/adapters/openKubesObservedState.mjs'
import { signInPrototype } from './support'

test('fresh producer changes content while Detail and widget remain open', async ({ page }) => {
  const golden = JSON.parse((await readFile(new URL('../bff/openKubesObservedState.fixtures.json', import.meta.url), 'utf8')).replaceAll('openkubes-management', 'community-preview'))
  const envelope = golden.snapshots['hosting-cluster']
  envelope.metadata.partial = false
  for (const cluster of envelope.data.clusters) {
    cluster.readiness = 'Ready'
    for (const step of cluster.lifecycle) step.state = 'Ready'
    envelope.data.evidence.find((item: { id: string }) => item.id === cluster.evidenceId).outcome = 'Ready'
  }
  let now = Date.parse(envelope.metadata.observedAt)
  const server = createServer(createConsoleBffHandler({
    source: { readSnapshot: async () => normalizeOpenKubesObservedState(structuredClone(envelope), { now: () => new Date(now) }) },
    authorizer: prototypeAuthorizer,
  }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing BFF listener')
  await page.route('**/api/console/v0/**', async route => {
    const response = await fetch(`http://127.0.0.1:${address.port}${new URL(route.request().url()).pathname}`)
    await route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() })
  })
  try {
    await page.clock.install()
    await signInPrototype(page)
    await page.clock.pauseAt(new Date(Date.now() + 1000))
    await expect(page.locator('.snapshot')).toContainText('Current observation')
    await page.locator('.cluster-card').filter({ hasText: 'ok-shared' }).locator('.card-main').click()
    await expect(page.locator('.lifecycle-step').first()).toBeVisible()
    await page.getByRole('button', { name: /Ask OK AI/ }).click()
    await page.getByRole('button', { name: 'ok-shared status', exact: true }).click()
    await expect(page.locator('.diagnostic-message.assistant').last()).toContainText('Current observation. Ready.')
    await page.getByRole('button', { name: 'Open Shell' }).click()
    await page.getByRole('button', { name: 'kubectl get clusterconditions -o wide', exact: true }).click()
    const originalOutput = page.locator('.terminal-entry.terminal-output').first()
    now += 3_600_000
    envelope.metadata.observedAt = new Date(now).toISOString()
    for (const item of envelope.data.evidence) item.observedAt = new Date(now).toISOString()
    const shared = envelope.data.clusters.find((cluster: { name: string }) => cluster.name === 'ok-shared')
    shared.readiness = 'Failed'
    shared.revision = 'nodes:31461261;deployment:31452634'
    for (const step of shared.lifecycle) step.state = 'Failed'
    envelope.data.evidence.find((item: { id: string }) => item.id === shared.evidenceId).outcome = 'Failed'
    await page.clock.runFor(30_001)
    await expect(page.locator('.title-actions .status')).toHaveText('Failed')
    await expect(page.locator('.live-label')).toContainText('Observed')
    for (const status of await page.locator('.lifecycle-step .status').all()) await expect(status).toHaveText('Failed')
    await expect(page.locator('.evidence-card').filter({ hasText: 'ok-shared hosting-cluster state' })).toContainText('Failed')
    await expect(originalOutput).toContainText('Earlier output, based on data observed at')
    await expect(originalOutput).not.toContainText(/\bcurrent(ly)?\b/i)
    await page.getByRole('button', { name: 'kubectl get clusterconditions -o wide', exact: true }).click()
    await expect(page.locator('.terminal-entry.terminal-output').last()).toContainText(/Nodes\s+Failed/)
    const command = page.getByRole('textbox', { name: 'Command or question' })
    await command.fill('evidence')
    await command.press('Enter')
    await expect(page.locator('.terminal-entry.terminal-output').last()).toContainText('REVISION     nodes:31461261;deployment:31452634')
    await expect(page.locator('.terminal-entry.terminal-output').last()).toContainText('READINESS    Failed (Current observation)')
    await page.getByRole('button', { name: 'Close cluster shell' }).click()
    const earlier = page.locator('.diagnostic-message.assistant').last()
    await expect(earlier).toContainText('Earlier answer, based on data observed at')
    await expect(earlier).not.toContainText(/\bcurrent(ly)?\b/i)
    await expect(earlier.locator('.live-dot')).toHaveCount(0)
    await page.getByRole('button', { name: 'ok-shared status', exact: true }).click()
    await expect(page.locator('.diagnostic-message.assistant').last()).toContainText('Current observation. Failed.')
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
