import type { Page } from '@playwright/test'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { normalizeOpenKubesObservedState } from '../bff/adapters/openKubesObservedState.mjs'
import { createConsoleBffHandler, prototypeAuthorizer } from '../bff/app.mjs'

/** Real BFF projection with a retained Transition receipt, independent of wall-clock ageing. */
export async function immutableEvidenceWorld(page: Page) {
  const golden = JSON.parse((await readFile(new URL('../bff/openKubesObservedState.fixtures.json', import.meta.url), 'utf8')).replaceAll('openkubes-management', 'community-preview'))
  const envelope = golden.snapshots['hosting-cluster']
  const cluster = envelope.data.clusters.find((item: { name: string }) => item.name === 'ok-shared')
  const evidence = envelope.data.evidence.find((item: { id: string }) => item.id === cluster.evidenceId)
  evidence.classification = 'Immutable'
  evidence.type = 'Transition'
  const now = new Date(envelope.metadata.observedAt)
  await page.clock.setFixedTime(now)
  const snapshot = normalizeOpenKubesObservedState(envelope, { now: () => now })
  const server = createServer(createConsoleBffHandler({ source: { readSnapshot: async () => snapshot }, authorizer: prototypeAuthorizer }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No fixture server address')
  await page.route('**/api/console/v0/**', async route => {
    const response = await fetch(`http://127.0.0.1:${address.port}${new URL(route.request().url()).pathname}`)
    await route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() })
  })
  return async () => {
    try { if (!page.isClosed()) await page.unrouteAll({ behavior: 'ignoreErrors' }) }
    finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  }
}
