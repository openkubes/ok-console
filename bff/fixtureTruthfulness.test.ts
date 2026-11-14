// @vitest-environment node
import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { FixtureObservedStateAdapter } from './adapters/fixtureObservedState.mjs'
import { createConsoleBffHandler, prototypeAuthorizer } from './app.mjs'

let server: Server | undefined
afterEach(async () => {
  vi.useRealTimers()
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()))
    server = undefined
  }
})

it('judges recorded fixture observations using the real clock, including HTTP projections', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-14T12:00:00Z'))
  const source = new FixtureObservedStateAdapter()
  const snapshot = await source.readSnapshot()
  expect(snapshot.sourceHealth).toMatchObject({ freshness: 'Stale', warnings: expect.arrayContaining([expect.objectContaining({ code: 'SOURCE_STALE' })]) })
  expect(snapshot.evidence.length).toBeGreaterThan(0)
  for (const item of snapshot.evidence) expect(item.freshness).toBe('Stale')
  expect(snapshot.clusters.length).toBeGreaterThan(0)
  for (const cluster of snapshot.clusters) {
    expect(cluster.readiness).toBe('Unknown')
    for (const stage of cluster.lifecycle) expect(stage.state).toBe('Unknown')
    for (const capability of cluster.capabilities) expect(capability.readiness).toBe('Unknown')
  }
  for (const placement of snapshot.placements) expect(placement.readiness).toBe('Unknown')
  const recorded = JSON.parse(await readFile(new URL('./fixtures/observed-state.json', import.meta.url), 'utf8'))
  for (const [index, bucket] of snapshot.metrics.entries()) {
    for (const category of ['capabilities', 'workloadClaims']) {
      expect(bucket[category].total).toBe(recorded.metrics[index][category].total)
      for (const field of ['ready', 'pending', 'failed', 'unknown']) expect(bucket[category][field]).toBeNull()
    }
    expect(bucket.openFindings).toEqual({ total: null, critical: null })
  }
  server = createServer(createConsoleBffHandler({ source, authorizer: prototypeAuthorizer }))
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing TCP address')
  for (const path of ['overview', 'clusters', `clusters/${snapshot.clusters[0].id}`]) {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/console/v0/${path}`)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.meta.freshness).toBe('Stale')
    expect(body.meta.warnings).toContainEqual(expect.objectContaining({ code: 'SOURCE_STALE' }))
  }
})

it('lets the shared verdict decide Current when the injected clock matches the recording', async () => {
  const recorded = JSON.parse(await readFile(new URL('./fixtures/observed-state.json', import.meta.url), 'utf8'))
  const snapshot = await new FixtureObservedStateAdapter(undefined, { now: () => new Date(recorded.observedAt) }).readSnapshot()
  expect(snapshot.sourceHealth.freshness).toBe('Current')
  expect(snapshot.sourceHealth.warnings).not.toContainEqual(expect.objectContaining({ code: 'SOURCE_STALE' }))
  expect(snapshot.clusters[0].readiness).toBe('Ready')
  expect(snapshot.evidence.find((item: { id: string }) => item.id === snapshot.clusters[0].evidenceId).freshness).toBe('Current')
})
