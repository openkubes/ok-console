import { describe, expect, it } from 'vitest'
import { FixtureConsoleAdapter } from './fixtureAdapter'
import { PRESENTATION_CONTRACT_VERSION } from '../domain/contracts'

describe('FixtureConsoleAdapter', () => {
  it('places the management plane before workload clusters', async () => {
    const snapshot = await new FixtureConsoleAdapter().getSnapshot()
    expect(snapshot.clusters[0]).toMatchObject({ name: 'ok-mgmt', role: 'Management plane' })
    expect(snapshot.clusters[1].name).toBe('ok-ai')
  })

  it('declares the exact presentation mapping version', async () => {
    const snapshot = await new FixtureConsoleAdapter().getSnapshot()
    expect(snapshot.presentationVersion).toBe(PRESENTATION_CONTRACT_VERSION)
    expect(snapshot.clusters.every((cluster) => cluster.contractVersion.length > 0)).toBe(true)
  })

  it('resolves every readiness claim to evidence', async () => {
    const snapshot = await new FixtureConsoleAdapter().getSnapshot()
    const evidenceIds = new Set(snapshot.evidence.map((item) => item.id))
    expect(snapshot.clusters.every((cluster) => evidenceIds.has(cluster.evidenceId))).toBe(true)
    expect(snapshot.capabilities.every((capability) => evidenceIds.has(capability.evidenceId))).toBe(true)
    expect(snapshot.claims.every((claim) => evidenceIds.has(claim.evidenceId))).toBe(true)
  })

  it('returns defensive copies across the adapter boundary', async () => {
    const adapter = new FixtureConsoleAdapter()
    const first = await adapter.getSnapshot()
    first.clusters[0].name = 'mutated'
    const second = await adapter.getSnapshot()
    expect(second.clusters[0].name).toBe('ok-mgmt')
  })
})

it('presents static browser fixture observations as Stale and Unknown', async () => {
  const snapshot = await new FixtureConsoleAdapter().getSnapshot()
  expect(snapshot.freshness).toBe('Stale')
  for (const cluster of snapshot.clusters) {
    expect(cluster.readiness).toBe('Unknown')
    for (const stage of cluster.lifecycle) expect(stage.state).toBe('Unknown')
  }
  for (const item of [...snapshot.capabilities, ...snapshot.claims, ...snapshot.agentDeployments]) {
    expect(item.readiness).toBe('Unknown')
  }
  for (const item of snapshot.evidence.filter(item => item.type !== 'Authorization')) {
    expect(item.outcome).toBe('Unknown')
  }
})
