// @vitest-environment node

import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  kind: string
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

// Every ownership-bearing kind uses the same whole-envelope rejection boundary.
const ownershipTargets: Array<[string, (envelope: MutableEnvelope) => JsonRecord]> = [
  ['cluster', (envelope) => envelope.data.clusters[0]],
  ['capability', (envelope) => envelope.data.clusters[0].capabilities[0]],
  ['placement', (envelope) => envelope.data.placements[0]],
  ['evidence', (envelope) => envelope.data.evidence[0]],
  ['metric bucket', (envelope) => envelope.data.metrics[0]],
]

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
  expect(body).not.toHaveProperty('data')
  expect(body).not.toHaveProperty('items')
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

  it.each(ownershipTargets.flatMap(([kind, target]) => [
    ['null', null], ['number', 7], ['string', 'platform'], ['array', []], ['empty object', {}],
  ].map(([shape, value]) => [kind, shape, target, value] as const)))(
    'rejects malformed %s ownership: %s', async (_kind, _shape, target, value) => {
      const envelope = await observedEnvelope() as unknown as MutableEnvelope
      target(envelope).ownership = value
      await expectContractFailure(envelope)
    },
  )

  it.each(ownershipTargets)('rejects extra fields in %s ownership', async (_kind, target) => {
    const envelope = await observedEnvelope() as unknown as MutableEnvelope
    ;(target(envelope).ownership as JsonRecord).role = 'admin'
    await expectContractFailure(envelope)
  })

  it('rejects an envelope kind mismatch', async () => {
    const envelope = await observedEnvelope()
    envelope.kind = 'AnotherObservedState'
    await expectContractFailure(envelope)
  })

  it.each(ownershipTargets.flatMap(([kind, target]) => [
    ['numeric tenant', 'tenantId', 7],
    ['object tenant', 'tenantId', {}],
    ['empty environment', 'environmentId', ''],
    ['whitespace environment', 'environmentId', '   '],
    ['empty tenant', 'tenantId', ''],
    ['whitespace tenant', 'tenantId', ' team-a '],
    ['control character', 'tenantId', 'team\na'],
    ['oversize tenant', 'tenantId', 't'.repeat(257)],
    ['non-string environment', 'environmentId', 7],
  ].map(([label, field, value]) => [kind, label, target, field as string, value] as const)))(
    'rejects invalid ownership strings: %s / %s', async (_kind, _label, target, field, value) => {
      const envelope = await observedEnvelope() as unknown as MutableEnvelope
      ;(target(envelope).ownership as JsonRecord)[field] = value
      await expectContractFailure(envelope)
    },
  )

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
    ...['ls0tls1crudjt://admin:hunter2@db', 'B3BLBNNZAC1RZXKTDJE://admin:hunter2@db', 'b3blbnnzac1rzxktdje-eyJhbGciOiJub25lIn0.eA.'].map((value) => [value, value]),
    ...['cluster-', 'build_', 'x', '1', 'x\u200B'].map((prefix) =>
      [`prefixed JWT ${prefix}`, `${prefix}eyJhbGciOiJub25lIn0.eA.`]),
    ...['1-postgres://', '1.https://', '2https://', '-redis://', String.raw`https:/\/`, String.raw`https:\//`]
      .map((scheme) => [`userinfo ${scheme}`, `${scheme}app:pw@db`]),
    ...['https://Sam:hunter2@db', 'https://S@db', String.raw`https:\/\/Svc:pw@db`]
      .map((value) => [value, value]),
    ['base64 PEM alignment 1', 'tLS0tQkVHSU4 redaction-negative-proof'],
    ['base64 PEM alignment 2', 'LS0tLUJFR0lO redaction-negative-proof'],
    ['OpenSSH body', 'b3BlbnNzaC1rZXktdjE redaction-negative-proof'],
    ['PuTTY marker', 'PuTTY-User-Key-File-3: redaction-negative-proof'],
    ['padded JWT', 'eyJhbGciOiJIUzI1NiJ9=.eA==.eA== redaction-negative-proof'],
    ['JSON escaped userinfo', String.raw`https:\/\/app:redaction-negative-proof@db/app`],
    ['YAML httpHeaders', 'name: Authorization\n  value: Basic x redaction-negative-proof'],
    ['JSON httpHeaders', '{"name":"Authorization","value":"Basic x redaction-negative-proof"}'],
    ['Authorization vendor token', 'Authorization: ghp_redaction-negative-proof'],
    ...['Negotiate', 'NTLM', 'Digest'].map((scheme) =>
      [`Authorization ${scheme}`, `Authorization: ${scheme} redaction-negative-proof`]),
    // Isolate the scheme alternative from the colon/equal assignment alternative.
    ...['bearer', 'basic', 'negotiate', 'ntlm', 'digest'].map((scheme) =>
      [`header pair ${scheme}`, `Authorization","value":"${scheme} x redaction-negative-proof`]),
    ...['DB_PASS=', 'pass:', 'AUTH_KEY=', 'SIGNING_KEY=', 'ENCRYPTION_KEY=', 'sig=', 'JSESSIONID=', 'session=', 'key=']
      .map((assignment) => [assignment, `${assignment}redaction-negative-proof`]),
    ...['pass', 'key', 'sig', 'session', 'sessionid'].map((key) =>
      [`quoted ${key}`, `{"${key}" : "redaction-negative-proof"}`]),
    ...['\u034F', '\uFE0F', '\u180B', '\u17B4', '\u3164'].map((ignorable) =>
      [`ignorable U+${ignorable.codePointAt(0)!.toString(16)}`, `pass${ignorable}word=redaction-negative-proof`]),
    ['base64 PEM', 'LS0tLS1CRUdJT redaction-negative-proof'],
    ['unsigned JWT', 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJhIn0. redaction-negative-proof'],
    ['passphrase keyword', 'passphrase redaction-negative-proof'],
    ['kubeconfig keyword', 'kubeconfig redaction-negative-proof'],
    ['private key keyword', 'private_key redaction-negative-proof'],
    ['passwd keyword', 'passwd: redaction-negative-proof'],
    ['pwd keyword', 'pwd=redaction-negative-proof'],
    ['credential keyword', 'credential: redaction-negative-proof'],
    ['credentials keyword', 'credentials: redaction-negative-proof'],
    ['access key keyword', 'access_key=redaction-negative-proof'],
    ['prose access key', 'access key redaction-negative-proof'],
    ['Cookie header', 'Cookie: redaction-negative-proof'],
    ['docker auth', 'auth: redaction-negative-proof'],
    ['docker JSON auth', '{"auth":"redaction-negative-proof"}'],
    ['URL userinfo', 'postgres://app:redaction-negative-proof@db:5432/app'],
    ['prefixed Bearer assignment', 'HTTP_BEARER=redaction-negative-proof'],
    ['prefixed bare Bearer', 'x_Bearer redaction-negative-proof'],
    ['prefixed Authorization assignment', 'HTTP_AUTHORIZATION=Basic redaction-negative-proof'],
    ['camel-case Authorization JSON', '{"proxyAuthorization":"Basic redaction-negative-proof"}'],
    ['underscore header separator', 'Authorization_Basic redaction-negative-proof'],
    ['encoded header separator', 'Authorization%20Basic redaction-negative-proof'],
    ['literal header separator', String.raw`Authorization\tBasic redaction-negative-proof`],
    ['token-only URL userinfo', 'https://redaction-negative-proof@db/app'],
    ...['%20', String.raw`\t`, '+', '=', ':', '\u200B', '_', '']
      .map((separator) => [`Basic ${separator}`, `Authorization: Basic${separator}redaction-negative-proof`]),
    ['JSON Authorization', '{"Authorization":"Basic redaction-negative-proof"}'],
    ['Authorization assignment', 'authorization=Basic redaction-negative-proof'],
    ['Authorization arbitrary separator', 'Authorization---Basic redaction-negative-proof'],
    ['zero-width keyword', 'pass\u200Bword=redaction-negative-proof'],
    ['full-width keyword', 'ｐａｓｓｗｏｒｄ=redaction-negative-proof'],
    ...['SECRET_KEY=x', 'AWS_SECRET_ACCESS_KEY=x', 'token_value: x', 'passwords: x', 'secretKey=x', 'passwordHash=x']
      .map((value) => [value, `${value} redaction-negative-proof`]),
    ...['%20', String.raw`\t`, '+', '=', ':', '\u200B']
      .map((separator) => [`legacy Bearer ${separator}`, `Authorization: Bearer${separator}redaction-negative-proof`]),
    ...['%20', String.raw`\t`, '+', '=', ':', '\u200B']
      .map((separator) => [`bare Bearer ${separator}`, `Bearer${separator}redaction-negative-proof`]),
    ['PEM private key', '-----BEGIN PRIVATE KEY----- redaction-negative-proof'],
    ['PEM certificate', '-----BEGIN CERTIFICATE----- redaction-negative-proof'],
    ['PEM case and whitespace', 'before -----  begin   PUBLIC KEY----- redaction-negative-proof after'],
    ['bare JWT', 'eyJhbGciOiJSUzI1NiJ9.x.redaction-negative-proof'],
    ['embedded JWS', 'before:eyJ0eXAiOiJKV1QifQ.eA.redaction-negative-proof  after'],
    ['prose password', 'the password is redaction-negative-proof'],
    ['prose token', 'token redaction-negative-proof'],
    ['prose secret', 'secret: redaction-negative-proof'],
    ['prose API key', 'api key redaction-negative-proof'],
    ['keyword case and whitespace', 'before API  KEY   redaction-negative-proof after'],
    ['kubeconfig client key', 'client-key-data redaction-negative-proof'],
    ['kubeconfig certificate', 'client-certificate-data=redaction-negative-proof'],
    ['kubeconfig token', 'ToKeN\t:\tredaction-negative-proof'],
    ['kubeconfig auth provider', 'before AUTH-PROVIDER  redaction-negative-proof after'],
    ['kubeconfig password', 'PASSWORD\t=\tredaction-negative-proof'],
    ['kubeconfig quoted JSON key', '{"client-certificate-data":"redaction-negative-proof"}'],
    ['kubeconfig underscore separator', 'client_key_data=redaction-negative-proof'],
    ['kubeconfig space separator', 'client certificate data redaction-negative-proof'],
    ['Basic authorization', 'Authorization: Basic redaction-negative-proof'],
    ['authorization case and whitespace', 'before aUtHoRiZaTiOn  :  bAsIc\tredaction-negative-proof after'],
    ['bare Bearer', 'Bearer redaction-negative-proof'],
    ['Bearer case and whitespace', 'before bEaReR\t redaction-negative-proof after'],
    ['embedded legacy assignment', 'clientSecret=redaction-negative-proof'],
    ['bare credential keyword', 'redaction-negative-proof Token'],
  ])('redacts credential-shaped display text: %s', async (_label, value) => {
    const envelope = await observedEnvelope()
    envelope.data.clusters[0].provider = value
    const snapshot = normalizeOpenKubesObservedState(envelope)
    expect(snapshot.clusters[0].provider).toBe('Value withheld by the Console redaction boundary.')
    expect(JSON.stringify(snapshot)).not.toContain('redaction-negative-proof')
  })

  it.each(['Infrastructure plane'])('accepts the current producer role: %s', async (role) => {
    const envelope = await observedEnvelope()
    envelope.data.clusters[1].role = role
    expect(normalizeOpenKubesObservedState(envelope).clusters[1].role).toBe(role)
  })

  it.each(['Authorization: Bearer', 'Authorization: Basic'])('withholds headers without a following value: %s', async (value) => {
    const envelope = await observedEnvelope()
    envelope.data.clusters[0].provider = value
    expect(normalizeOpenKubesObservedState(envelope).clusters[0].provider).toBe('Value withheld by the Console redaction boundary.')
  })

  it.each([
    ['token-0', 'token-1'],
    ['secret-store', 'token-exchange'],
    ...[
      'bearer', 'cluster-bearer-1', 'pallbearer', 'torchbearer', 'bearer-pool',
      'standard-bearer-01', 'oidc-bearer-auth', 'cluster-authorization-basic', 'bearer-token-auth',
    ].map((name) => [name, `${name}-other`]),
  ])('keeps keyword identifiers distinct: %s / %s', async (first, second) => {
    const envelope = await observedEnvelope()
    const clusterIds = new Map(envelope.data.clusters.map((item, index) => [item.id, index === 0 ? first : index === 1 ? second : item.id]))
    const evidenceIds = new Map(envelope.data.evidence.map((item, index) => [item.id, `ev-${first}-${index}-claim-readiness`]))
    for (const cluster of envelope.data.clusters) {
      cluster.id = clusterIds.get(cluster.id)!
      cluster.provider = 'kubevirt'
      cluster.evidenceId = evidenceIds.get(cluster.evidenceId)!
      cluster.capabilities.forEach((item, index) => {
        item.id = index === 0 ? first : `${first}-capability-${index}`
        item.evidenceId = evidenceIds.get(item.evidenceId)!
      })
    }
    envelope.data.placements.forEach((item, index) => {
      item.id = `token-placement-${index}`
      item.targetClusterId = clusterIds.get(item.targetClusterId)!
      item.evidenceId = evidenceIds.get(item.evidenceId)!
    })
    for (const item of envelope.data.evidence) {
      item.id = evidenceIds.get(item.id)!
      item.clusterId = clusterIds.get(item.clusterId)!
    }
    const snapshot = normalizeOpenKubesObservedState(envelope)
    expect(snapshot.clusters).toEqual(envelope.data.clusters)
    expect(snapshot.placements).toEqual(envelope.data.placements)
    expect(snapshot.evidence).toEqual(envelope.data.evidence)
  })

  it.each(['evidenceId', 'clusterId', 'targetClusterId'])('rejects keyword-named dangling %s on raw values', async (field) => {
    const envelope = await observedEnvelope()
    // An existing keyword ID must never act as a wildcard for a different keyword ID.
    if (field === 'evidenceId') {
      const previous = envelope.data.evidence[0].id
      envelope.data.evidence[0].id = 'secret-store'
      for (const cluster of envelope.data.clusters) {
        if (cluster.evidenceId === previous) cluster.evidenceId = 'secret-store'
        for (const item of cluster.capabilities) if (item.evidenceId === previous) item.evidenceId = 'secret-store'
      }
      for (const item of envelope.data.placements) if (item.evidenceId === previous) item.evidenceId = 'secret-store'
      envelope.data.clusters[0].evidenceId = 'token-missing'
    } else {
      const previous = envelope.data.clusters[0].id
      envelope.data.clusters[0].id = 'secret-store'
      for (const item of envelope.data.evidence) if (item.clusterId === previous) item.clusterId = 'secret-store'
      for (const item of envelope.data.placements) if (item.targetClusterId === previous) item.targetClusterId = 'secret-store'
      if (field === 'clusterId') envelope.data.evidence[0].clusterId = 'token-missing'
      else envelope.data.placements[0].targetClusterId = 'token-missing'
    }
    expect(() => normalizeOpenKubesObservedState(envelope)).toThrow(field === 'evidenceId'
      ? 'unresolved Evidence reference' : field === 'clusterId'
        ? 'unresolved Evidence cluster reference' : 'unresolved placement target cluster reference')
  })

  it.each(['secret-team', 'bearer-co', 'bearer-team', 'Bearer Services', 'Bearer Telecommunications', 'Torchbearer Internationalization', 'Bearer Professional-Services', 'bearer infrastructure-team'])('accepts keyword ownership: %s', async (tenant) => {
    const envelope = await observedEnvelope()
    envelope.data.environment.id = 'secret-environment'
    for (const cluster of envelope.data.clusters) assignClusterTenant(envelope, cluster.id, tenant)
    for (const bucket of envelope.data.metrics) bucket.ownership = { environmentId: 'secret-environment', tenantId: tenant }
    const snapshot = normalizeOpenKubesObservedState(envelope)
    expect(snapshot.environment.id).toBe('secret-environment')
    expect(snapshot.clusters[0].ownership.tenantId).toBe(tenant)
  })

  it.each([
    'ls0tls1crudjt://admin:hunter2@db', 'B3BLBNNZAC1RZXKTDJE://admin:hunter2@db',
    'b3blbnnzac1rzxktdje-eyJhbGciOiJub25lIn0.eA.',
    ...['cluster-', 'build_', 'x', '1', 'x\u200B'].map((prefix) => `${prefix}eyJhbGciOiJub25lIn0.eA.`),
    ...['1-postgres://', '1.https://', '2https://', '-redis://', String.raw`https:/\/`, String.raw`https:\//`]
      .map((scheme) => `${scheme}admin:hunter2@db`),
    'authorization%3A%20Bearer%20ghp_abcdefghijklmnop',
    'authorization=Bearer+ghp_abcdefghijklmnop', String.raw`Authorization: Bearer\tghp_abcdefghijklmnop`,
    ...['.', '_', '~', '+', '/', '='].map((punctuation) => `Bearer abcdefghijklmnop${punctuation}`),
    'https://Sam:hunter2@db', 'https://S@db', String.raw`https:\/\/Svc:pw@db`,
    '-----BEGIN CERTIFICATE-----', 'LS0tLS1CRUdJT', 'tLS0tQkVHSU4', 'LS0tLUJFR0lO',
    'b3BlbnNzaC1rZXktdjE', 'PuTTY-User-Key-File-3',
    'eyJhbGciOiJub25lIn0.eA.', 'eyJhbGciOiJIUzI1NiJ9=.eA==.eA==',
    'Authorization=Basic abcdefgh', 'Bearer abcdefghijklmno1',
    'postgres://app:x@db/app', 'https://x@db/app', String.raw`https:\/\/app:x@db/app`,
    'HTTP_AUTHORIZATION=Basic abcdefgh', '{"proxyAuthorization":"Basic abcdefgh"}',
    'Authorization_Basic abcdefgh', 'Authorization%20Basic abcdefgh', String.raw`Authorization\tBasic abcdefgh`,
    'Ａｕｔｈｏｒｉｚａｔｉｏｎ: Basic abcdefgh', 'Bea\u200Brer abcdefghijklmno1',
  ])('rejects credential value shapes in identifiers and ownership: %s', async (value) => {
    const original = await observedEnvelope()
    const paths = [
      ['clusters', '0', 'id'], ['clusters', '0', 'evidenceId'],
      ['clusters', '0', 'capabilities', '0', 'id'], ['clusters', '0', 'capabilities', '0', 'evidenceId'],
      ['placements', '0', 'id'], ['placements', '0', 'evidenceId'], ['placements', '0', 'targetClusterId'],
      ['evidence', '0', 'id'], ['evidence', '0', 'clusterId'], ['environment', 'id'],
      ...['clusters', 'placements', 'evidence', 'metrics'].flatMap((collection) =>
        ['tenantId', 'environmentId'].map((field) => [collection, '0', 'ownership', field])),
      ['clusters', '0', 'capabilities', '0', 'ownership', 'tenantId'],
      ['clusters', '0', 'capabilities', '0', 'ownership', 'environmentId'],
    ]
    for (const path of paths) {
      const envelope = structuredClone(original)
      let parent = envelope.data as unknown as JsonRecord
      for (const key of path.slice(0, -1)) parent = parent[key] as JsonRecord
      parent[path[path.length - 1]] = value
      expect(() => normalizeOpenKubesObservedState(envelope), path.join('.')).toThrow(
        path.includes('ownership') || path[0] === 'environment'
          ? 'must be a valid non-empty bounded string.' : 'must not contain a credential value.',
      )
    }
  })

  it.each([
    'KubeVirt cluster claim', 'KubeVirtClusterClaim/v1alpha1', 'platform.openkubes.ai/v1alpha1',
    'OpenKubes management-plane Kubernetes API', 'resourceVersion:7',
    'The OpenKubes cluster Claim reports Ready=True.', 'Basic profile',
    'openkubes-query:84', `sha256:${'a'.repeat(64)}`,
    'ls0tls1crudjt', 'B3BLBNNZAC1RZXKTDJE', 'privateSkey', 'clientSkeySdata',
    'https://db?user=a@b', 'https://db#contact=a@b',
  ])('preserves benign Claim text and source revisions: %s', async (value) => {
    const envelope = await observedEnvelope({ sourceRevision: value })
    envelope.data.clusters[0].profile = value
    envelope.data.evidence[0].source = value
    const snapshot = normalizeOpenKubesObservedState(envelope)
    expect(snapshot.sourceRevision).toBe(value)
    expect(snapshot.clusters[0].profile).toBe(value)
    expect(snapshot.evidence[0].source).toBe(value)
  })

  it('preserves benign fixture and hosting-cluster values without over-redacting', async () => {
    const envelope = await observedEnvelope()
    // Read raw values so normalization cannot hide accidental fixture redaction.
    const raw = JSON.parse(await readFile(new URL('./fixtures/observed-state.json', import.meta.url), 'utf8'))
    for (const field of ['environment', 'clusters', 'placements', 'evidence'] as const) {
      envelope.data[field] = raw[field]
    }
    for (const item of envelope.data.evidence) {
      item.summary = 'Evidence summary withheld by the Console redaction boundary.'
      item.redacted = true
    }
    Object.assign(envelope.data.clusters[0], {
      provider: 'Talos', region: 'fra-dc1', revision: `sha256:${'a'.repeat(64)}`,
      contractVersion: 'kubernetes.io/core+apps/v1',
    })
    envelope.data.clusters[1].provider = 'kubevirt'
    envelope.data.clusters[0].lifecycle[0].detail = 'The bounded read-only Kubernetes API queries completed.'
    envelope.data.clusters[0].lifecycle[1].detail = 'Ready: 3; not ready: 0; unknown: 0.'
    envelope.data.evidence[0].title = 'Management plane outside hosting source'
    envelope.data.evidence[0].source = 'Bounded Kubernetes API projection'
    const snapshot = await new OpenKubesObservedStateAdapter({ url: await startQuery(envelope) }).readSnapshot()
    for (const field of ['environment', 'clusters', 'placements', 'evidence'] as const) {
      expect(snapshot[field]).toEqual(envelope.data[field])
    }
  })

  it('rejects a parseable metadata timestamp carrying a credential', async () => {
    const observedAt = 'Oct 21 2026 (password hunter2)'
    expect(Number.isFinite(Date.parse(observedAt))).toBe(true)
    const envelope = await observedEnvelope({ observedAt })
    expect(() => normalizeOpenKubesObservedState(envelope)).toThrow('$.metadata.observedAt must be an ISO timestamp.')
  })

  it('withholds or rejects credential values in every input string scalar', async () => {
    const original = await observedEnvelope()
    const paths: string[][] = []
    const visit = (value: unknown, path: string[] = []) => {
      if (typeof value === 'string') paths.push(path)
      else if (value && typeof value === 'object') {
        Object.entries(value).forEach(([key, child]) => visit(child, [...path, key]))
      }
    }
    visit(original)
    for (const path of paths) {
      const envelope = structuredClone(original)
      let parent = envelope as unknown as JsonRecord
      for (const key of path.slice(0, -1)) parent = parent[key] as JsonRecord
      parent[path[path.length - 1]] = 'Authorization: Bearer redaction-negative-proof'
      let serialized: string
      try {
        serialized = JSON.stringify(normalizeOpenKubesObservedState(envelope))
      } catch (error) {
        const leaf = path[path.length - 1]
        const reason = path.includes('ownership') || path.join('.') === 'data.environment.id'
          ? 'must be a valid non-empty bounded string.'
          : ['id', 'evidenceId', 'clusterId', 'targetClusterId'].includes(leaf)
            ? 'must not contain a credential value.'
            : ['apiVersion', 'kind'].includes(leaf)
              ? 'Observed-state query contract is incompatible.'
              : path.join('.') === 'metadata.observedAt'
                ? 'must be an ISO timestamp.'
                : 'is not supported.'
        expect((error as Error).message, path.join('.')).toContain(reason)
        expect((error as Error).message, path.join('.')).not.toContain('redaction-negative-proof')
        continue
      }
      expect(serialized, path.join('.')).not.toContain('redaction-negative-proof')
      expect(serialized, path.join('.')).toContain(path[path.length - 1] === 'summary'
        ? 'Evidence summary withheld by the Console redaction boundary.'
        : 'Value withheld by the Console redaction boundary.')
    }
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
