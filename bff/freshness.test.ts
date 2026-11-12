// @vitest-environment node
import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { afterEach, expect, it } from 'vitest'
import { normalizeOpenKubesObservedState } from './adapters/openKubesObservedState.mjs'
import { createConsoleBffHandler, prototypeAuthorizer } from './app.mjs'
import { createObservedStateSource } from './source.mjs'

const NOW = Date.parse('2026-10-22T12:00:00Z')
const now = () => new Date(NOW)
const envelope = async () => {
  const data = JSON.parse(await readFile(new URL('./fixtures/observed-state.json', import.meta.url), 'utf8'))
  for (const item of data.evidence) {
    item.observedAt = now().toISOString()
    item.classification = 'Current'
  }
  for (const cluster of data.clusters) {
    cluster.readiness = 'Ready'
    for (const capability of cluster.capabilities) capability.readiness = 'Ready'
  }
  for (const placement of data.placements) placement.readiness = 'Ready'
  return { apiVersion: 'observed.openkubes.io/v0alpha2', kind: 'ConsoleObservedState',
    metadata: { observedAt: now().toISOString(), sourceRevision: data.sourceRevision }, data }
}
const normalize = (payload: Awaited<ReturnType<typeof envelope>>) => normalizeOpenKubesObservedState(payload, { now })
const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
const serve = async (payload: Awaited<ReturnType<typeof envelope>>, tenantIds = ['platform'], clock = now, transform = (snapshot: ReturnType<typeof normalize>) => snapshot) => {
  const server = createServer(createConsoleBffHandler({
    source: { readSnapshot: async () => transform(normalizeOpenKubesObservedState(payload, { now: clock })) }, now: clock, enableFailureInjection: true,
    authorizer: async (...args: Parameters<typeof prototypeAuthorizer>) => ({
      ...await prototypeAuthorizer(...args),
      scope: { environmentId: payload.data.environment.id, tenantIds },
    }),
  }))
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No TCP address')
  return async (path: string) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/console/v0/${path}`)
    return { status: response.status, body: await response.json() }
  }
}

it.each(['Ready', 'Failed', 'Pending', 'Unknown'])('old Current Evidence downgrades %s and lifecycle while fresh siblings remain Ready', async readiness => {
  const payload = await envelope()
  const cluster = payload.data.clusters[0]
  const evidence = payload.data.evidence.find((item: { id: string }) => item.id === cluster.evidenceId)
  evidence.observedAt = new Date(NOW - 15 * 60 * 60 * 1000).toISOString()
  cluster.readiness = readiness
  const placement = payload.data.placements[0]
  placement.evidenceId = evidence.id
  placement.readiness = readiness
  cluster.capabilities[0].evidenceId = evidence.id
  cluster.capabilities[0].readiness = readiness
  const result = normalize(payload)
  expect(result.clusters[0]).toMatchObject({ id: cluster.id, name: cluster.name, readiness: 'Unknown' })
  expect(result.clusters[0].lifecycle.every((stage: { state: string }) => stage.state === 'Unknown')).toBe(true)
  expect(result.clusters[0].capabilities[0].readiness).toBe('Unknown')
  expect(result.placements.find((item: { id: string }) => item.id === placement.id).readiness).toBe('Unknown')
  expect(result.clusters[1].readiness).toBe('Ready')
  expect(result.clusters).toHaveLength(payload.data.clusters.length)
  expect(result.placements).toHaveLength(payload.data.placements.length)
})

it.each([
  [300000, 'Current', 'Ready'], [300001, 'Stale', 'Unknown'],
  [-61000, 'Stale', 'Unknown'], [-59000, 'Current', 'Ready'],
])('Current Evidence age %i has verdict %s and readiness %s', async (age, freshness, readiness) => {
  const payload = await envelope()
  const item = payload.data.evidence.find((item: { id: string }) => item.id === payload.data.clusters[0].evidenceId)
  item.observedAt = new Date(NOW - age).toISOString()
  const result = normalize(payload)
  expect(result.sourceHealth.freshness).toBe('Current')
  expect(result.evidence.find((e: { id: string }) => e.id === item.id).freshness).toBe(freshness)
  expect(result.clusters[0].readiness).toBe(readiness)
})

it('Immutable Evidence 30 days old keeps readiness; fresh Unknown stays Unknown', async () => {
  const payload = await envelope()
  const item = payload.data.evidence.find((item: { id: string }) => item.id === payload.data.clusters[0].evidenceId)
  item.observedAt = new Date(NOW - 30 * 86400000).toISOString()
  item.classification = 'Immutable'
  payload.data.clusters[1].readiness = 'Unknown'
  const result = normalize(payload)
  expect(result.clusters[0].readiness).toBe('Ready')
  expect(result.evidence.find((e: { id: string }) => e.id === item.id).freshness).toBe('Current')
  expect(result.clusters[1].readiness).toBe('Unknown')
})

it('stale envelope downgrades every readiness and lifecycle even with fresh or Immutable Evidence', async () => {
  const payload = await envelope()
  payload.metadata.observedAt = new Date(NOW - 300001).toISOString()
  payload.data.evidence[0].classification = 'Immutable'
  const result = normalize(payload)
  expect(result.sourceHealth.freshness).toBe('Stale')
  for (const cluster of result.clusters) {
    expect(cluster.readiness).toBe('Unknown')
    for (const stage of cluster.lifecycle) expect(stage.state).toBe('Unknown')
    for (const capability of cluster.capabilities) expect(capability.readiness).toBe('Unknown')
  }
  for (const placement of result.placements) expect(placement.readiness).toBe('Unknown')
  expect(result.evidence.every((item: { freshness: string }) => item.freshness === 'Stale')).toBe(true)
})

it.each(['bad-time', null, 123, '', '2026-02-30T12:00:00Z'])('invalid Evidence timestamp %s drops only Evidence and downgrades references', async observedAt => {
  const payload = await envelope()
  const cluster = payload.data.clusters[0]
  const item = payload.data.evidence.find((item: { id: string }) => item.id === cluster.evidenceId)
  item.observedAt = observedAt
  cluster.capabilities[0].evidenceId = item.id
  payload.data.placements[0].evidenceId = item.id
  const result = normalize(payload)
  expect(result.evidence.some((e: { id: string }) => e.id === item.id)).toBe(false)
  expect(result.clusters[0].readiness).toBe('Unknown')
  expect(result.clusters[0].lifecycle.every((stage: { state: string }) => stage.state === 'Unknown')).toBe(true)
  expect(result.clusters[0].capabilities[0].readiness).toBe('Unknown')
  expect(result.placements[0].readiness).toBe('Unknown')
  expect(result.clusters[1].readiness).toBe('Ready')
  const get = await serve(payload)
  expect((await get(`evidence/${item.id}`)).status).toBe(404)
})

it('Evidence endpoint returns item verdict and stale warning while preserving historical outcome', async () => {
  const payload = await envelope()
  const item = payload.data.evidence[0]
  item.observedAt = new Date(NOW - 15 * 3600000).toISOString()
  const get = await serve(payload)
  const stale = await get(`evidence/${item.id}`)
  expect(stale.status).toBe(200)
  expect(stale.body.meta.freshness).toBe('Stale')
  expect(stale.body.meta.warnings).toContainEqual(expect.objectContaining({ code: 'SOURCE_STALE' }))
  expect(stale.body.data.outcome).toBe(item.outcome)
  for (const classification of ['Current', 'Immutable']) {
    const fresh = payload.data.evidence[1]
    fresh.classification = classification
    if (classification === 'Immutable') fresh.observedAt = new Date(NOW - 30 * 86400000).toISOString()
    const response = await get(`evidence/${fresh.id}`)
    expect(response.body.meta.freshness).toBe('Current')
    expect((await get(`evidence/${fresh.id}?failure=stale`)).body.meta.freshness).toBe('Stale')
    expect(response.body.meta.warnings.some((warning: { code: string }) => warning.code === 'SOURCE_STALE')).toBe(false)
  }
  payload.metadata.observedAt = new Date(NOW - 300001).toISOString()
  expect((await get(`evidence/${payload.data.evidence[1].id}`)).body.meta.freshness).toBe('Stale')
})

it('tenant A responses are identical when hidden tenant B Evidence becomes stale', async () => {
  const payload = await envelope()
  const hidden = payload.data.clusters[1]
  hidden.ownership.tenantId = 'tenant-b'
  for (const capability of hidden.capabilities) capability.ownership.tenantId = 'tenant-b'
  const hiddenEvidence = payload.data.evidence.filter((item: { clusterId: string }) => item.clusterId === hidden.id)
  for (const item of hiddenEvidence) item.ownership.tenantId = 'tenant-b'
  for (const item of payload.data.placements) if (item.targetClusterId === hidden.id) item.ownership.tenantId = 'tenant-b'
  const get = await serve(payload)
  const paths = ['overview', 'clusters', `evidence/${payload.data.clusters[0].evidenceId}`]
  const before = await Promise.all(paths.map(get))
  for (const item of hiddenEvidence) item.observedAt = new Date(NOW - 15 * 3600000).toISOString()
  const after = await Promise.all(paths.map(get))
  for (let index = 0; index < paths.length; index++) {
    expect(after[index].status).toBe(200)
    delete before[index].body.meta.correlationId
    delete after[index].body.meta.correlationId
    expect(after[index].body).toEqual(before[index].body)
    expect(after[index].body.meta.warnings.some((warning: { code: string }) => warning.code === 'SOURCE_STALE')).toBe(false)
    expect(JSON.stringify(after[index].body)).not.toContain(hidden.id)
  }
  expect((await get(`evidence/${hiddenEvidence[0].id}`)).status).toBe(404)
})

it.each(['300000junk', '', '-1', '1e6', ' 300000', '300000\n', '0'])('source rejects invalid stale threshold %j at startup', value => {
  expect(() => createObservedStateSource({ OK_CONSOLE_OBSERVED_STATE_MODE: 'openkubes',
    OK_CONSOLE_OBSERVED_STATE_URL: 'http://127.0.0.1:12345', OK_CONSOLE_OBSERVED_STATE_STALE_AFTER_MS: value,
  })).toThrow('OK_CONSOLE_OBSERVED_STATE_STALE_AFTER_MS must be a positive integer.')
})
it('source accepts digits-only stale threshold and default', () => {
  const environment = { OK_CONSOLE_OBSERVED_STATE_MODE: 'openkubes', OK_CONSOLE_OBSERVED_STATE_URL: 'http://127.0.0.1:12345' }
  expect(createObservedStateSource({ ...environment, OK_CONSOLE_OBSERVED_STATE_STALE_AFTER_MS: '300000' }).staleAfterMs).toBe(300000)
  expect(createObservedStateSource(environment).staleAfterMs).toBe(300000)
})

const expectUnknownMetrics = (metrics: Record<string, Record<string, unknown>>) => {
  for (const category of ['capabilities', 'workloadClaims']) {
    for (const field of ['ready', 'pending', 'failed', 'unknown']) expect(metrics[category][field]).toBeNull()
  }
  expect(metrics.openFindings.total).toBeNull()
  expect(metrics.openFindings.critical).toBeNull()
}

it('G1 stale envelope clears metric verdict leaves in every bucket and overview', async () => {
  const payload = await envelope()
  for (const item of payload.data.evidence) item.classification = 'Immutable'
  payload.metadata.observedAt = new Date(NOW - 300001).toISOString()
  const result = normalize(payload)
  for (const bucket of result.metrics) expectUnknownMetrics(bucket)
  const get = await serve(payload)
  expectUnknownMetrics((await get('overview')).body.data)
})

it.each(['old', 'missing', 'null', 'wrong-type', 'invalid'])('G1 %s Current Evidence clears only its tenant metric buckets', async kind => {
  const payload = await envelope()
  const original = structuredClone(payload.data.metrics[0])
  payload.data.metrics.push({ ...structuredClone(original), ownership: { ...original.ownership, tenantId: 'unaffected' } })
  const item = payload.data.evidence[0]
  if (kind === 'missing') delete item.observedAt
  else item.observedAt = kind === 'old' ? new Date(NOW - 300001).toISOString() : kind === 'null' ? null : kind === 'wrong-type' ? 5 : 'bad'
  const result = normalize(payload)
  expectUnknownMetrics(result.metrics[0])
  expect(result.metrics[1]).toEqual(payload.data.metrics[1])
  const affected = await serve(payload)
  expectUnknownMetrics((await affected('overview')).body.data)
  const unaffected = await serve(payload, ['unaffected'])
  const overview = (await unaffected('overview')).body.data
  expect(overview.capabilities).toEqual(original.capabilities)
  expect(overview.workloadClaims).toEqual(original.workloadClaims)
})

it('G4 stale injector clears readiness, lifecycle and metric verdicts without changing the next request', async () => {
  const payload = await envelope()
  const get = await serve(payload)
  const injected = (await get('overview?failure=stale')).body
  expect(injected.data.clusters).toMatchObject({ ready: 0, pending: 0, failed: 0, unknown: payload.data.clusters.length })
  expectUnknownMetrics(injected.data)
  for (const item of injected.data.recentPlacements) expect(item.readiness).toBe('Unknown')
  const list = (await get('clusters?failure=stale')).body.data.items
  expect(list.every((item: { readiness: string }) => item.readiness === 'Unknown')).toBe(true)
  const detail = (await get(`clusters/${payload.data.clusters[0].id}?failure=stale`)).body.data
  expect(detail.readiness).toBe('Unknown')
  for (const item of detail.capabilities) expect(item.readiness).toBe('Unknown')
  for (const item of detail.lifecycle) expect(item.state).toBe('Unknown')
  expect((await get('overview')).body.data.capabilities).toEqual(payload.data.metrics[0].capabilities)
})

it.each([false, true])('G5 exactly one stale warning for stale envelope (injected=%s)', async injected => {
  const payload = await envelope()
  if (!injected) payload.metadata.observedAt = new Date(NOW - 300001).toISOString()
  const get = await serve(payload)
  const response = (await get(`evidence/${payload.data.evidence[0].id}${injected ? '?failure=stale' : ''}`)).body
  expect(response.meta.freshness).toBe('Stale')
  expect(response.meta.warnings.filter((item: { code: string }) => item.code === 'SOURCE_STALE')).toHaveLength(1)
})

it.each(['TIMEOUT', 'STALE_AFTER'])('G6 bounds %s at signed 32-bit maximum', name => {
  const key = `OK_CONSOLE_OBSERVED_STATE_${name}_MS`
  const environment = { OK_CONSOLE_OBSERVED_STATE_MODE: 'openkubes', OK_CONSOLE_OBSERVED_STATE_URL: 'http://127.0.0.1:1' }
  const source = createObservedStateSource({ ...environment, [key]: '2147483647' })
  expect(name === 'TIMEOUT' ? source.timeoutMs : source.staleAfterMs).toBe(2147483647)
  for (const value of ['2147483648', '99999999999999999999']) {
    expect(() => createObservedStateSource({ ...environment, [key]: value })).toThrow(`${key} must be at most 2147483647.`)
  }
})

it.each([[-60000, 'Current', 'Ready'], [-60001, 'Stale', 'Unknown']])('G7 Immutable age %s has verdict %s and dependents %s', async (age, freshness, readiness) => {
  const payload = await envelope()
  const cluster = payload.data.clusters[0]
  const item = payload.data.evidence.find((item: { id: string }) => item.id === cluster.evidenceId)
  item.classification = 'Immutable'
  item.observedAt = new Date(NOW - Number(age)).toISOString()
  cluster.capabilities[0].evidenceId = item.id
  payload.data.placements[0].evidenceId = item.id
  const result = normalize(payload)
  expect(result.evidence.find((e: { id: string }) => e.id === item.id).freshness).toBe(freshness)
  expect(result.clusters[0].readiness).toBe(readiness)
  expect(result.clusters[0].capabilities[0].readiness).toBe(readiness)
  expect(result.placements[0].readiness).toBe(readiness)
  for (const stage of result.clusters[0].lifecycle) expect(stage.state).toBe(freshness === 'Stale' ? 'Unknown' : cluster.lifecycle.find((s: { label: string }) => s.label === stage.label).state)
})

it('old Immutable Evidence leaves fresh-envelope metric buckets unchanged', async () => {
  const payload = await envelope()
  payload.data.evidence[0].classification = 'Immutable'
  payload.data.evidence[0].observedAt = new Date(NOW - 30 * 86400000).toISOString()
  expect(normalize(payload).metrics).toEqual(payload.data.metrics)
})

it('G4 injection does not mutate a reused source snapshot', async () => {
  const snapshot = normalize(await envelope())
  const original = structuredClone(snapshot)
  const server = createServer(createConsoleBffHandler({
    source: { readSnapshot: async () => snapshot }, now, enableFailureInjection: true, authorizer: prototypeAuthorizer,
  }))
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No TCP address')
  const response = await fetch(`http://127.0.0.1:${address.port}/api/console/v0/overview?failure=stale`)
  expect((await response.json()).data.clusters.ready).toBe(0)
  expect(snapshot).toEqual(original)
})

it.each([
  ['Current', new Date(NOW + 60001).toISOString()], ['Current', 'invalid-time'],
  ['Immutable', new Date(NOW + 60001).toISOString()], ['Immutable', 'invalid-time'],
])('H2 %s Evidence timestamp %s clears only its owning tenant metrics', async (classification, observedAt) => {
  const payload = await envelope()
  const original = structuredClone(payload.data.metrics[0])
  payload.data.metrics.push({ ...structuredClone(original), ownership: { ...original.ownership, tenantId: 'unaffected' } })
  const item = payload.data.evidence[0]
  item.classification = classification
  item.observedAt = observedAt
  const result = normalize(payload)
  expectUnknownMetrics(result.metrics[0])
  expect(result.metrics[0].capabilities.total).toBe(original.capabilities.total)
  expect(result.metrics[0].workloadClaims.total).toBe(original.workloadClaims.total)
  expect(result.metrics[1]).toEqual(payload.data.metrics[1])
  const get = await serve(payload)
  expectUnknownMetrics((await get('overview')).body.data)
})

it.each(['item', 'envelope', 'injection'])('H3 %s staleness clears every current count but preserves inventory totals', async kind => {
  const payload = await envelope()
  const original = structuredClone(payload.data.metrics[0])
  if (kind === 'item') payload.data.evidence[0].observedAt = new Date(NOW - 300001).toISOString()
  if (kind !== 'injection') payload.metadata.observedAt = new Date(NOW - 300001).toISOString()
  const get = await serve(payload)
  const overview = (await get(`overview${kind === 'injection' ? '?failure=stale' : ''}`)).body.data
  expectUnknownMetrics(overview)
  expect(overview.capabilities.total).toBe(original.capabilities.total)
  expect(overview.workloadClaims.total).toBe(original.workloadClaims.total)
})


const expectFreshness = (body: { meta: { freshness: string, warnings?: { code: string }[] } }, freshness: string) => {
  expect(body.meta.freshness).toBe(freshness)
  expect((body.meta.warnings ?? []).filter(item => item.code === 'SOURCE_STALE')).toHaveLength(freshness === 'Stale' ? 1 : 0)
}

it('R1 stale-only tenant B and fresh tenant A get authorized freshness on all three routes', async () => {
  const payload = await envelope()
  const hidden = payload.data.clusters[1]
  hidden.ownership.tenantId = 'tenant-b'
  for (const capability of hidden.capabilities) capability.ownership.tenantId = 'tenant-b'
  for (const item of payload.data.placements) if (item.targetClusterId === hidden.id) item.ownership.tenantId = 'tenant-b'
  for (const item of payload.data.evidence) if (item.clusterId === hidden.id) {
    item.ownership.tenantId = 'tenant-b'
    item.observedAt = new Date(NOW - 300001).toISOString()
  }
  expect(normalize(payload).sourceHealth.freshness).toBe('Current')
  for (const [tenant, cluster, freshness] of [
    ['tenant-b', hidden.id, 'Stale'], ['platform', payload.data.clusters[0].id, 'Current'],
  ]) {
    const get = await serve(payload, [tenant])
    for (const path of ['overview', 'clusters', `clusters/${cluster}`]) {
      const response = await get(path)
      expect(response.status).toBe(200)
      expectFreshness(response.body, freshness)
    }
  }
})

it('R2 mixed list matches the stale contract example and detail counts only its cluster', async () => {
  const payload = await envelope()
  const staleCluster = payload.data.clusters[1]
  for (const item of payload.data.evidence) if (item.clusterId === staleCluster.id) item.observedAt = new Date(NOW - 300001).toISOString()
  const get = await serve(payload)
  const example = JSON.parse(await readFile(new URL('../contracts/presentation/v0alpha1/examples/cluster-list.json', import.meta.url), 'utf8'))
  const list = await get('clusters')
  expect(list.status).toBe(200)
  expect(list.body.meta.freshness).toBe(example.meta.freshness)
  expectFreshness(list.body, 'Stale')
  expect(list.body.data.items).toHaveLength(payload.data.clusters.length)
  for (const cluster of payload.data.clusters) {
    const detail = await get(`clusters/${cluster.id}`)
    expect(detail.status).toBe(200)
    expectFreshness(detail.body, cluster.id === staleCluster.id ? 'Stale' : 'Current')
  }
})

it('R3 real hosting-external producer golden ClusterList is Stale', async () => {
  const fixtures = JSON.parse(await readFile(new URL('./openKubesObservedState.fixtures.json', import.meta.url), 'utf8'))
  expect(fixtures.producerRevision).toBe('1b0739f')
  expect(fixtures.producerSha256).toBe('e798f2dca87405ef9dfc93dd81c519396d5252f2ff678602304788261c8ccf39')
  const payload = fixtures.snapshots['hosting-external']
  const clock = () => new Date('2026-10-22T14:01:34+02:00')
  expect(normalizeOpenKubesObservedState(payload, { now: clock }).sourceHealth.freshness).toBe('Current')
  const get = await serve(payload, ['platform'], clock)
  const response = await get('clusters')
  expect(response.status).toBe(200)
  expectFreshness(response.body, 'Stale')
  expect(response.body.data.items.filter((item: { readiness: string }) => item.readiness === 'Unknown')).toHaveLength(3)
})

it('R4 stale envelope clears metrics for a tenant with no Evidence', async () => {
  const payload = await envelope()
  const bucket = structuredClone(payload.data.metrics[0])
  bucket.ownership.tenantId = 'metrics-only'
  payload.data.metrics.push(bucket)
  payload.metadata.observedAt = new Date(NOW - 300001).toISOString()
  const get = await serve(payload, ['metrics-only'])
  const response = await get('overview')
  expect(response.status).toBe(200)
  expectUnknownMetrics(response.body.data)
  expect(response.body.data.capabilities.total).toBe(bucket.capabilities.total)
  expectFreshness(response.body, 'Stale')
})

it.each(['bad-time', null, 123, '', undefined])('R5 invalid Evidence timestamp %s yields Unknown on covered routes', async observedAt => {
  const payload = await envelope()
  const cluster = payload.data.clusters[0]
  payload.data.evidence.find((item: { id: string }) => item.id === cluster.evidenceId).observedAt = observedAt
  const get = await serve(payload)
  for (const path of ['overview', 'clusters', `clusters/${cluster.id}`]) {
    const response = await get(path)
    expect(response.status).toBe(200)
    expectFreshness(response.body, 'Unknown')
  }
  expectFreshness((await get(`clusters/${payload.data.clusters[1].id}`)).body, 'Current')
})

it.each([undefined, null, 'Unknown', 'foreign'])('R6 invalid verdict %s is Unknown; Stale takes precedence', async verdict => {
  const payload = await envelope()
  const cluster = payload.data.clusters[0]
  const get = await serve(payload, ['platform'], now, snapshot => {
    snapshot.evidence.find((item: { id: string }) => item.id === cluster.evidenceId).freshness = verdict
    return snapshot
  })
  for (const path of ['overview', 'clusters', `clusters/${cluster.id}`]) expectFreshness((await get(path)).body, 'Unknown')
  payload.data.evidence.find((item: { id: string }) => item.id === payload.data.clusters[1].evidenceId).observedAt = new Date(NOW - 300001).toISOString()
  for (const path of ['overview', 'clusters']) expectFreshness((await get(path)).body, 'Stale')
  expectFreshness((await get(`clusters/${cluster.id}`)).body, 'Unknown')
})

it.each(['envelope', 'injection', 'both'])('R7 %s yields exactly one SOURCE_STALE on all three routes', async kind => {
  const payload = await envelope()
  if (kind !== 'injection') payload.metadata.observedAt = new Date(NOW - 300001).toISOString()
  const get = await serve(payload)
  for (const path of ['overview', 'clusters', `clusters/${payload.data.clusters[0].id}`]) {
    const response = await get(`${path}${kind !== 'envelope' ? '?failure=stale' : ''}`)
    expect(response.status).toBe(200)
    expectFreshness(response.body, 'Stale')
  }
})


it.each(['capability', 'placement'])('R8 missing %s Evidence makes covered responses Unknown', async kind => {
  const payload = await envelope()
  const cluster = payload.data.clusters[0]
  const item = kind === 'capability' ? cluster.capabilities[0] : payload.data.placements[0]
  // Use a distinct Evidence reference so the parent cluster remains current.
  const evidence = structuredClone(payload.data.evidence.find((entry: { id: string }) => entry.id === cluster.evidenceId))
  evidence.id = 'evidence-missing-observation'
  evidence.observedAt = 'bad-time'
  payload.data.evidence.push(evidence)
  item.evidenceId = evidence.id
  if (kind === 'placement') item.targetClusterId = cluster.id
  const get = await serve(payload)
  expectFreshness((await get('overview')).body, 'Unknown')
  for (const path of ['clusters', `clusters/${cluster.id}`]) expectFreshness((await get(path)).body, kind === 'capability' ? 'Unknown' : 'Current')
})

it('R9 unknown envelope verdict cannot become Current', async () => {
  const payload = await envelope()
  const get = await serve(payload, ['platform'], now, snapshot => {
    snapshot.sourceHealth.freshness = 'Unknown'
    return snapshot
  })
  for (const path of ['overview', 'clusters', `clusters/${payload.data.clusters[0].id}`]) expectFreshness((await get(path)).body, 'Unknown')
})


it.each([
  ['Current', 'Current', 'Current'],
  ['Current', 'Stale', 'Stale'],
  ['Stale', 'Current', 'Stale'],
  ['Stale', 'Stale', 'Stale'],
  ['Unknown', 'Stale', 'Stale'],
  ['Stale', 'Unknown', 'Stale'],
  ['Unknown', 'Unknown', 'Unknown'],
  ...[undefined, null, 'Unknown', 'foreign', 123].flatMap(verdict => [
    [verdict, 'Current', 'Unknown'],
    ['Current', verdict, 'Unknown'],
  ]),
])('Evidence route envelope %s and item %s yield %s', async (envelopeVerdict, itemVerdict, expected) => {
  const payload = await envelope()
  const item = payload.data.evidence[0]
  const get = await serve(payload, ['platform'], now, snapshot => {
    snapshot.sourceHealth.freshness = envelopeVerdict
    snapshot.evidence.find((evidence: { id: string }) => evidence.id === item.id).freshness = itemVerdict
    return snapshot
  })
  const response = await get(`evidence/${item.id}`)
  expect(response.status).toBe(200)
  expect(response.body.meta.freshness).toBe(expected)
  expect(response.body.data.outcome).toBe(item.outcome)
  expect(response.body.meta.warnings).toContainEqual(expect.objectContaining({ code: 'REDACTED' }))
})


it('degraded injector keeps PARTIAL_DATA first when source warnings already exist', async () => {
  const payload = await envelope()
  const sourceWarning = { code: 'SOURCE_STALE', message: 'The source observation is stale.' }
  const get = await serve(payload, ['platform'], now, snapshot => {
    snapshot.sourceHealth.freshness = 'Stale'
    snapshot.sourceHealth.warnings = [sourceWarning]
    return snapshot
  })
  const response = await get('overview?failure=degraded')
  expect(response.status).toBe(200)
  expect(response.body.meta.freshness).toBe('Stale')
  expect(response.body.meta.warnings).toEqual([
    { code: 'PARTIAL_DATA', message: 'The local failure injector omitted non-essential source data.' },
    sourceWarning,
  ])
})
