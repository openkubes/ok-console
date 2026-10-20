// @vitest-environment node

import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { validateConsoleResponse } from '../src/domain/presentationContract'
import {
  normalizeOpenKubesObservedState,
  OpenKubesObservedStateAdapter,
  OPENKUBES_QUERY_VERSION,
} from './adapters/openKubesObservedState.mjs'
import { FixtureObservedStateAdapter } from './adapters/fixtureObservedState.mjs'
import { createConsoleBffHandler, prototypeAuthorizer } from './app.mjs'
import { createObservedStateSource } from './source.mjs'

type JsonRecord = Record<string, unknown>
type MutableEnvelope = {
  apiVersion: string
  data: {
    environment: { id: string }
    metrics: Array<JsonRecord>
    clusters: Array<JsonRecord & { capabilities: JsonRecord[]; lifecycle: Array<{ detail: string }>; provider: string }>
    placements: JsonRecord[]
    evidence: JsonRecord[]
  }
}

const servers: Server[] = []
const fixtureSource = new FixtureObservedStateAdapter()

const closeServer = async (server: Server) => {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer))
})

const listen = async (server: Server) => {
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not expose a TCP address.')
  return `http://127.0.0.1:${address.port}`
}

const observedEnvelope = async (metadata: JsonRecord = {}) => {
  const fixture = await fixtureSource.readSnapshot()
  return {
    apiVersion: 'observed.openkubes.io/v0alpha2',
    kind: 'ConsoleObservedState',
    metadata: {
      observedAt: fixture.observedAt,
      sourceRevision: 'openkubes-query:84',
      ...metadata,
    },
    data: {
      environment: fixture.environment,
      metrics: fixture.metrics,
      clusters: fixture.clusters,
      placements: fixture.placements,
      evidence: fixture.evidence,
    },
  }
}

const assignClusterTenant = (envelope: MutableEnvelope, clusterId: string, tenantId: string) => {
  const ownership = { environmentId: envelope.data.environment.id, tenantId }
  const cluster = envelope.data.clusters.find((item) => item.id === clusterId)
  if (!cluster) throw new Error(`fixture is missing ${clusterId}`)
  cluster.ownership = ownership
  cluster.capabilities.forEach((capability) => { capability.ownership = ownership })
  envelope.data.evidence
    .filter((item) => item.clusterId === clusterId)
    .forEach((item) => { item.ownership = ownership })
  envelope.data.placements
    .filter((item) => item.targetClusterId === clusterId)
    .forEach((item) => { item.ownership = ownership })
}

const startQuery = async (payload: unknown, { status = 200, contentType = 'application/json; profile="observed.openkubes.io/v0alpha2"' } = {}) => listen(createServer((_request, response) => {
  response.writeHead(status, { 'Content-Type': contentType })
  response.end(JSON.stringify(payload))
}))

const startBff = async (source: OpenKubesObservedStateAdapter, authorizer = prototypeAuthorizer) => listen(createServer(createConsoleBffHandler({
  source,
  authorizer,
  now: () => new Date('2026-08-21T18:01:00Z'),
  correlationId: () => 'corr-openkubes-integration',
})))

const expectContractFailure = async (envelope: unknown, authorizer = prototypeAuthorizer) => {
  const queryUrl = await startQuery(envelope)
  const bffUrl = await startBff(new OpenKubesObservedStateAdapter({ url: queryUrl }), authorizer)
  const response = await fetch(`${bffUrl}/api/console/v0/overview`)
  const body = await response.json()

  expect(response.status).toBe(502)
  expect(body).toMatchObject({ kind: 'Error', error: { code: 'CONTRACT_INCOMPATIBLE', retryable: false } })
  expect(JSON.stringify(body)).not.toContain('other-tenant')
  expect(JSON.stringify(body)).not.toContain('missing-cluster')
  expect(JSON.stringify(body)).not.toContain('missing-evidence')
}

describe('OpenKubes observed-state query adapter', () => {
  it('uses only the ownership-aware v0alpha2 query profile', async () => {
    let acceptedProfile = ''
    const queryUrl = await listen(createServer(async (request, response) => {
      acceptedProfile = request.headers.accept ?? ''
      response.writeHead(200, { 'Content-Type': 'application/json; profile="observed.openkubes.io/v0alpha2"' })
      response.end(JSON.stringify(await observedEnvelope()))
    }))

    await new OpenKubesObservedStateAdapter({ url: queryUrl }).readSnapshot()

    expect(OPENKUBES_QUERY_VERSION).toBe('observed.openkubes.io/v0alpha2')
    expect(acceptedProfile).toBe('application/json; profile="observed.openkubes.io/v0alpha2"')
  })

  it('keeps the deterministic fixture in the normalized single-tenant ownership shape', async () => {
    const fixture = await fixtureSource.readSnapshot()
    const owner = { environmentId: 'community-preview', tenantId: 'platform' }

    expect(fixture.metrics).toEqual([expect.objectContaining({ ownership: owner })])
    expect(fixture.clusters.every((cluster: JsonRecord) => JSON.stringify(cluster.ownership) === JSON.stringify(owner))).toBe(true)
    expect(fixture.clusters.flatMap((cluster: JsonRecord) => cluster.capabilities as JsonRecord[])
      .every((capability: JsonRecord) => JSON.stringify(capability.ownership) === JSON.stringify(owner))).toBe(true)
    expect(fixture.placements.every((placement: JsonRecord) => (
      typeof placement.targetClusterId === 'string'
      && JSON.stringify(placement.ownership) === JSON.stringify(owner)
    ))).toBe(true)
    expect(fixture.evidence.every((item: JsonRecord) => JSON.stringify(item.ownership) === JSON.stringify(owner))).toBe(true)
  })

  it('validates fixture snapshots through the same whole-envelope contract', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ok-console-fixture-'))
    const fixturePath = join(directory, 'observed-state.json')
    try {
      const fixture = await fixtureSource.readSnapshot()
      delete fixture.clusters[0].ownership
      await writeFile(fixturePath, JSON.stringify(fixture), 'utf8')

      await expect(new FixtureObservedStateAdapter(fixturePath).readSnapshot())
        .rejects.toThrow('Observed-state fixture failed structural or semantic contract validation.')
    } finally {
      await rm(directory, { recursive: true })
    }
  })

  it('flows a controlled real HTTP query through every read-only BFF projection', async () => {
    const queryUrl = await startQuery(await observedEnvelope())
    const source = new OpenKubesObservedStateAdapter({
      url: `${queryUrl}/observed-state`,
      now: () => new Date('2026-08-21T18:01:00Z'),
    })
    const bffUrl = await startBff(source)

    for (const path of [
      '/api/console/v0/session',
      '/api/console/v0/overview',
      '/api/console/v0/clusters',
      '/api/console/v0/clusters/cluster-ok-mgmt',
      '/api/console/v0/evidence/ev-mgmt-ready',
    ]) {
      const response = await fetch(`${bffUrl}${path}`)
      const body = await response.json()
      expect(response.status, path).toBe(200)
      expect(validateConsoleResponse(body), path).toEqual({ valid: true, errors: [] })
      expect(body).toMatchObject({ meta: { sourceRevision: 'openkubes-query:84' } })
    }
  })

  it('allowlists the query response before presentation code can consume it', async () => {
    const envelope = await observedEnvelope()
    const firstCluster = envelope.data.clusters[0] as JsonRecord
    envelope.data.clusters[0] = {
      ...firstCluster,
      token: 'must-never-enter-the-canonical-snapshot',
      rawKubernetesObject: { apiVersion: 'v1', kind: 'Secret' },
    }
    const queryUrl = await startQuery(envelope)
    const snapshot = await new OpenKubesObservedStateAdapter({
      url: queryUrl,
      now: () => new Date('2026-08-21T18:01:00Z'),
    }).readSnapshot()
    const serialized = JSON.stringify(snapshot)

    expect(serialized).not.toContain('must-never-enter-the-canonical-snapshot')
    expect(serialized).not.toContain('rawKubernetesObject')
    expect(serialized).not.toContain('Secret')
    expect(snapshot.clusters[0].ownership).toEqual({ environmentId: 'community-preview', tenantId: 'platform' })
    expect(snapshot.clusters[0].capabilities[0].ownership).toEqual(snapshot.clusters[0].ownership)
    expect(snapshot.placements[0]).toMatchObject({
      targetClusterId: 'cluster-ok-ai',
      ownership: { environmentId: 'community-preview', tenantId: 'platform' },
    })
    expect(snapshot.evidence[0].ownership).toEqual({ environmentId: 'community-preview', tenantId: 'platform' })
  })

  it('preserves metric buckets and unavailable metric leaves', async () => {
    const envelope = await observedEnvelope() as unknown as MutableEnvelope
    envelope.data.metrics[0].capabilities = {
      total: null,
      ready: 0,
      pending: 0,
      failed: 0,
      unknown: 0,
    }
    const snapshot = normalizeOpenKubesObservedState(envelope, { now: () => new Date('2026-08-21T18:01:00Z') })

    expect(snapshot.metrics).toEqual(envelope.data.metrics)
  })

  it('rejects an object-shaped metrics collection', async () => {
    const envelope = await observedEnvelope() as unknown as MutableEnvelope
    envelope.data.metrics = envelope.data.metrics[0] as unknown as JsonRecord[]
    await expectContractFailure(envelope)
  })

  it.each([
    ['cluster', (envelope: MutableEnvelope) => { delete envelope.data.clusters[0].ownership }],
    ['capability', (envelope: MutableEnvelope) => { delete envelope.data.clusters[0].capabilities[0].ownership }],
    ['placement', (envelope: MutableEnvelope) => { delete envelope.data.placements[0].ownership }],
    ['evidence', (envelope: MutableEnvelope) => { delete envelope.data.evidence[0].ownership }],
    ['metric bucket', (envelope: MutableEnvelope) => { delete envelope.data.metrics[0].ownership }],
  ])('rejects missing %s ownership', async (_label, mutate) => {
    const envelope = await observedEnvelope() as unknown as MutableEnvelope
    mutate(envelope)
    await expectContractFailure(envelope)
  })

  it.each([
    ['empty tenant', (envelope: MutableEnvelope) => { (envelope.data.clusters[0].ownership as JsonRecord).tenantId = '' }],
    ['whitespace tenant', (envelope: MutableEnvelope) => { (envelope.data.clusters[0].ownership as JsonRecord).tenantId = ' team-a ' }],
    ['control character', (envelope: MutableEnvelope) => { (envelope.data.clusters[0].ownership as JsonRecord).tenantId = 'team\na' }],
    ['oversize tenant', (envelope: MutableEnvelope) => { (envelope.data.clusters[0].ownership as JsonRecord).tenantId = 't'.repeat(257) }],
    ['non-string environment', (envelope: MutableEnvelope) => { (envelope.data.clusters[0].ownership as JsonRecord).environmentId = 7 }],
  ])('rejects invalid ownership strings: %s', async (_label, mutate) => {
    const envelope = await observedEnvelope() as unknown as MutableEnvelope
    mutate(envelope)
    await expectContractFailure(envelope)
  })

  it('rejects ownership from a different environment', async () => {
    const envelope = await observedEnvelope() as unknown as MutableEnvelope
    ;(envelope.data.metrics[0].ownership as JsonRecord).environmentId = 'another-environment'
    await expectContractFailure(envelope)
  })

  it.each([
    ['cluster', (envelope: MutableEnvelope) => { envelope.data.clusters.push(structuredClone(envelope.data.clusters[1])) }],
    ['evidence', (envelope: MutableEnvelope) => { envelope.data.evidence.push(structuredClone(envelope.data.evidence[0])) }],
    ['placement', (envelope: MutableEnvelope) => { envelope.data.placements[1].id = envelope.data.placements[0].id }],
    ['capability within a cluster', (envelope: MutableEnvelope) => { envelope.data.clusters[0].capabilities[1].id = envelope.data.clusters[0].capabilities[0].id }],
  ])('rejects a duplicate %s ID', async (_label, mutate) => {
    const envelope = await observedEnvelope() as unknown as MutableEnvelope
    mutate(envelope)
    await expectContractFailure(envelope)
  })

  it.each([
    ['cluster Evidence', (envelope: MutableEnvelope) => { envelope.data.clusters[0].evidenceId = 'missing-evidence' }],
    ['capability Evidence', (envelope: MutableEnvelope) => { envelope.data.clusters[0].capabilities[0].evidenceId = 'missing-evidence' }],
    ['placement Evidence', (envelope: MutableEnvelope) => { envelope.data.placements[0].evidenceId = 'missing-evidence' }],
    ['Evidence cluster', (envelope: MutableEnvelope) => { envelope.data.evidence[0].clusterId = 'missing-cluster' }],
    ['placement target cluster', (envelope: MutableEnvelope) => { envelope.data.placements[0].targetClusterId = 'missing-cluster' }],
  ])('rejects a dangling %s reference', async (_label, mutate) => {
    const envelope = await observedEnvelope() as unknown as MutableEnvelope
    mutate(envelope)
    await expectContractFailure(envelope)
  })

  it.each([
    ['capability and parent cluster', (envelope: MutableEnvelope) => { (envelope.data.clusters[0].capabilities[0].ownership as JsonRecord).tenantId = 'other-tenant' }],
    ['cluster and referenced Evidence', (envelope: MutableEnvelope) => {
      assignClusterTenant(envelope, 'cluster-ok-ai', 'other-tenant')
      envelope.data.clusters[0].evidenceId = 'ev-ai-ready'
    }],
    ['capability and referenced Evidence', (envelope: MutableEnvelope) => {
      assignClusterTenant(envelope, 'cluster-ok-ai', 'other-tenant')
      envelope.data.clusters[0].capabilities[0].evidenceId = 'ev-ai-ready'
    }],
    ['Evidence and its cluster', (envelope: MutableEnvelope) => { (envelope.data.evidence[0].ownership as JsonRecord).tenantId = 'other-tenant' }],
    ['placement and target cluster', (envelope: MutableEnvelope) => { (envelope.data.placements[0].ownership as JsonRecord).tenantId = 'other-tenant' }],
    ['placement and referenced Evidence', (envelope: MutableEnvelope) => {
      assignClusterTenant(envelope, 'cluster-ok-ai', 'other-tenant')
      envelope.data.placements[0].evidenceId = 'ev-mgmt-ready'
    }],
  ])('rejects cross-owner references between %s', async (_label, mutate) => {
    const envelope = await observedEnvelope() as unknown as MutableEnvelope
    mutate(envelope)
    await expectContractFailure(envelope)
  })

  it.each([
    ['missing ownership', (envelope: MutableEnvelope) => { delete envelope.data.clusters[1].capabilities[0].ownership }],
    ['dangling Evidence cluster', (envelope: MutableEnvelope) => { envelope.data.evidence[1].clusterId = 'hidden-missing-cluster' }],
  ])('rejects hidden tenant corruption before authorization filtering: %s', async (_label, mutate) => {
    const envelope = await observedEnvelope() as unknown as MutableEnvelope
    for (const cluster of envelope.data.clusters) assignClusterTenant(envelope, cluster.id as string, 'A')
    assignClusterTenant(envelope, 'cluster-ok-ai', 'B')
    envelope.data.metrics[0].ownership = { environmentId: envelope.data.environment.id, tenantId: 'A' }
    envelope.data.metrics.push({ ...structuredClone(envelope.data.metrics[0]), ownership: { environmentId: envelope.data.environment.id, tenantId: 'B' } })
    mutate(envelope)
    const scopedAuthorizer = async (request: Parameters<typeof prototypeAuthorizer>[0]) => ({
      ...(await prototypeAuthorizer(request)),
      scope: { environmentId: envelope.data.environment.id, tenantIds: ['A'] },
    })

    await expectContractFailure(envelope, scopedAuthorizer)
  })

  it('derives stale and partial semantics without forwarding backend diagnostics', async () => {
    const queryUrl = await startQuery(await observedEnvelope({
      observedAt: '2026-08-21T17:50:00Z',
      partial: true,
      diagnostics: 'kubeconfig and private backend details',
    }))
    const source = new OpenKubesObservedStateAdapter({
      url: queryUrl,
      staleAfterMs: 5 * 60 * 1_000,
      now: () => new Date('2026-08-21T18:01:00Z'),
    })
    const bffUrl = await startBff(source)
    const response = await fetch(`${bffUrl}/api/console/v0/overview`)
    const body = await response.json()
    const serialized = JSON.stringify(body)

    expect(body).toMatchObject({
      meta: {
        freshness: 'Stale',
        warnings: [{ code: 'SOURCE_STALE' }, { code: 'PARTIAL_DATA' }, { code: 'REDACTED' }],
      },
    })
    expect(serialized).not.toContain('kubeconfig')
    expect(serialized).not.toContain('private backend details')
  })

  it('accepts the contract-authorized Evidence variants from the real source', async () => {
    const envelope = await observedEnvelope()
    envelope.data.evidence[0] = {
      ...envelope.data.evidence[0],
      type: 'Authorization',
      outcome: 'Approved',
    }
    const queryUrl = await startQuery(envelope)
    const snapshot = await new OpenKubesObservedStateAdapter({ url: queryUrl }).readSnapshot()
    expect(snapshot.evidence[0]).toMatchObject({ type: 'Authorization', outcome: 'Approved' })
  })

  it('redacts credential-shaped Evidence summary fragments at the source boundary', async () => {
    const envelope = await observedEnvelope()
    envelope.data.evidence[0] = {
      ...envelope.data.evidence[0],
      summary: 'provider token=super-secret and password: hunter2',
    }
    const queryUrl = await startQuery(envelope)
    const source = new OpenKubesObservedStateAdapter({ url: queryUrl })
    const snapshot = await source.readSnapshot()
    expect(snapshot.evidence[0].summary).toBe('Evidence summary withheld by the Console redaction boundary.')
    expect(snapshot.evidence[0].summary).not.toContain('super-secret')
    expect(snapshot.sourceHealth.warnings).toContainEqual({ code: 'REDACTED', message: expect.any(String) })
  })

  it.each([
    ['lifecycle detail', (envelope: MutableEnvelope) => { envelope.data.clusters[0].lifecycle[0].detail = 'Authorization: Bearer redaction-negative-proof' }],
    ['provider scalar', (envelope: MutableEnvelope) => { envelope.data.clusters[0].provider = 'password=redaction-negative-proof' }],
  ])('redacts credential-shaped %s at the source boundary', async (_label, mutate) => {
    const envelope = await observedEnvelope()
    mutate(envelope as unknown as MutableEnvelope)
    const snapshot = await new OpenKubesObservedStateAdapter({ url: await startQuery(envelope) }).readSnapshot()
    expect(JSON.stringify(snapshot)).not.toContain('redaction-negative-proof')
    expect(JSON.stringify(snapshot)).toContain('Value withheld by the Console redaction boundary.')
  })

  it('rejects malformed partial semantics instead of silently treating them as complete', async () => {
    const envelope = await observedEnvelope()
    envelope.metadata.partial = 'true'
    await expect(new OpenKubesObservedStateAdapter({ url: await startQuery(envelope) }).readSnapshot())
      .rejects.toThrow('$.metadata.partial must be a boolean when present.')
  })

  it.each(['observed.openkubes.io/v0alpha1', 'observed.openkubes.io/v9'])('turns incompatible %s real source data into a bounded BFF failure', async (apiVersion) => {
    const envelope = await observedEnvelope()
    envelope.apiVersion = apiVersion
    const queryUrl = await startQuery(envelope)
    const bffUrl = await startBff(new OpenKubesObservedStateAdapter({ url: queryUrl }))
    const response = await fetch(`${bffUrl}/api/console/v0/clusters`)
    const body = await response.json()

    expect(response.status).toBe(502)
    expect(body).toMatchObject({ kind: 'Error', error: { code: 'CONTRACT_INCOMPATIBLE', retryable: false } })
    expect(JSON.stringify(body)).not.toContain(apiVersion)
  })

  it.each([
    'application/json',
    'application/json; profile="observed.openkubes.io/v0alpha1"',
  ])('rejects an incompatible response content profile: %s', async (contentType) => {
    const envelope = await observedEnvelope()
    const queryUrl = await startQuery(envelope, { contentType })
    const bffUrl = await startBff(new OpenKubesObservedStateAdapter({ url: queryUrl }))
    const response = await fetch(`${bffUrl}/api/console/v0/overview`)
    const body = await response.json()

    expect(response.status).toBe(502)
    expect(body).toMatchObject({ kind: 'Error', error: { code: 'CONTRACT_INCOMPATIBLE', retryable: false } })
    expect(JSON.stringify(body)).not.toContain(contentType)
  })

  it('turns an unavailable upstream query into a bounded BFF failure', async () => {
    const queryUrl = await startQuery({ diagnostics: 'private upstream outage detail' }, { status: 503 })
    const bffUrl = await startBff(new OpenKubesObservedStateAdapter({ url: queryUrl }))
    const response = await fetch(`${bffUrl}/api/console/v0/overview`)
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).toMatchObject({ kind: 'Error', error: { code: 'SOURCE_UNAVAILABLE', retryable: true } })
    expect(JSON.stringify(body)).not.toContain('private upstream outage detail')
  })

  it('requires an explicit source mode and supports deterministic fixture rollback', () => {
    expect(createObservedStateSource({})).toBeInstanceOf(FixtureObservedStateAdapter)
    expect(() => createObservedStateSource({ OK_CONSOLE_OBSERVED_STATE_MODE: 'openkubes' })).toThrow('OK_CONSOLE_OBSERVED_STATE_URL')
    expect(() => createObservedStateSource({ OK_CONSOLE_OBSERVED_STATE_MODE: 'automatic' })).toThrow('fixture or openkubes')
  })

  it('rejects plaintext non-loopback query endpoints', () => {
    expect(() => new OpenKubesObservedStateAdapter({ url: 'http://platform.example.test/observed-state' })).toThrow('must use HTTPS')
    expect(() => new OpenKubesObservedStateAdapter({ url: 'https://user:password@platform.example.test/observed-state' })).toThrow('must not contain credentials')
  })
})
