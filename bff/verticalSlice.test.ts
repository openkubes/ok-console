// @vitest-environment node

import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BffConsoleAdapter } from '../src/data/bffAdapter'
import { FixtureConsoleAdapter } from '../src/data/fixtureAdapter'
import { FixtureObservedStateAdapter } from './adapters/fixtureObservedState.mjs'
import { createConsoleBffHandler } from './app.mjs'

const server = createServer(createConsoleBffHandler({
  source: new FixtureObservedStateAdapter(),
  correlationId: () => 'corr-vertical-slice',
}))
let adapter: BffConsoleAdapter

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Integration BFF did not expose a TCP address.')
  adapter = new BffConsoleAdapter(`http://127.0.0.1:${address.port}/api/console/v0`)
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
})

describe('OK-158/OK-159 read-only vertical slice', () => {
  it('flows observed state through the real BFF and ConsoleDataPort adapter', async () => {
    const snapshot = await adapter.getSnapshot()
    const fixtureSnapshot = await new FixtureConsoleAdapter().getSnapshot()
    const managementPlane = await adapter.getCluster('cluster-ok-mgmt')
    const evidence = await adapter.getEvidence('ev-mgmt-ready')

    expect(snapshot).toMatchObject({
      source: 'bff',
      presentationVersion: 'console.openkubes.io/v0alpha1',
      freshness: 'Current',
    })
    expect(snapshot.clusters.map((cluster) => cluster.name)).toEqual([
      'ok-mgmt',
      'ok-ai',
      'ok-shared',
      'edge-07',
    ])
    const requiredSnapshotFields = [
      'agentDeployments',
      'agents',
      'capabilities',
      'claims',
      'clusters',
      'evidence',
      'freshness',
      'generatedAt',
      'presentationVersion',
      'source',
      'warnings',
    ]
    expect(snapshot).toEqual(expect.objectContaining(
      Object.fromEntries(requiredSnapshotFields.map((field) => [field, expect.anything()])),
    ))
    expect(fixtureSnapshot).toEqual(expect.objectContaining(
      Object.fromEntries(requiredSnapshotFields.map((field) => [field, expect.anything()])),
    ))
    expect(snapshot.overview).toBeDefined()
    expect(Object.keys(snapshot.clusters[0]).sort()).toEqual(Object.keys(fixtureSnapshot.clusters[0]).sort())
    expect(managementPlane).toMatchObject({
      name: 'ok-mgmt',
      role: 'Management plane',
      readiness: 'Ready',
      capabilities: ['cap-identity', 'cap-gitops', 'cap-observability', 'cap-registry'],
    })
    expect(evidence).toMatchObject({
      id: 'ev-mgmt-ready',
      cluster: 'cluster-ok-mgmt',
      immutable: true,
    })
  })
})
