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
  // Internal consumer verdicts are not fields in the producer query contract.
  for (const item of fixture.evidence) delete item.freshness
  return {
    apiVersion: 'observed.openkubes.io/v0alpha2',
    kind: 'ConsoleObservedState',
    metadata: {
      observedAt: fixture.observedAt,
      sourceRevision: 'kubevirtclusterclaims:84',
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
      expect(body).toMatchObject({ meta: { sourceRevision: 'kubevirtclusterclaims:84' } })
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
    for (const item of envelope.data.evidence) item.observedAt = envelope.metadata.observedAt
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
    const snapshot = normalizeOpenKubesObservedState(envelope, { now: () => new Date(envelope.metadata.observedAt) })
    expect(snapshot.clusters).toEqual(envelope.data.clusters)
    expect(snapshot.placements).toEqual(envelope.data.placements)
    expect(snapshot.evidence).toEqual(envelope.data.evidence.map((item, index) => ({ ...item, freshness: index === 3 ? 'Stale' : 'Current' })))
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
        path.includes('ownership')
          ? 'must be a valid non-empty bounded string.' : 'must match the ID grammar.',
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
  ])('applies field grammars to formerly unrestricted benign text: %s', async (value) => {
    const envelope = await observedEnvelope({ sourceRevision: value })
    envelope.data.clusters[0].profile = value
    envelope.data.evidence[0].source = value
    const snapshot = normalizeOpenKubesObservedState(envelope)
    expect(snapshot.sourceRevision).toBe('Value withheld by the Console redaction boundary.')
    expect(snapshot.clusters[0].profile).toBe(/^[A-Za-z]+(?: [A-Za-z]+){0,5}$/.test(value) && value.length <= 64 ? value : 'Value withheld by the Console redaction boundary.')
    expect(snapshot.evidence[0].source).toBe(value === 'OpenKubes management-plane Kubernetes API' ? value : 'Value withheld by the Console redaction boundary.')
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
        const reason = path.includes('ownership')
          ? 'must be a valid non-empty bounded string.'
          : ['id', 'evidenceId', 'clusterId', 'targetClusterId'].includes(leaf)
            ? 'must match the ID grammar.'
            : ['apiVersion', 'kind'].includes(leaf)
              ? 'Observed-state query contract is incompatible.'
              : path.join('.') === 'metadata.observedAt'
                ? 'must be an ISO timestamp.'
                : leaf === 'name' && path[1] === 'clusters' ? 'must be a DNS subdomain.' : 'is not supported.'
        expect((error as Error).message, path.join('.')).toContain(reason)
        expect((error as Error).message, path.join('.')).not.toContain('redaction-negative-proof')
        continue
      }
      expect(serialized, path.join('.')).not.toContain('redaction-negative-proof')
      if (path[1] === 'evidence' && path.at(-1) === 'observedAt') {
        const item = envelope.data.evidence[Number(path[2])]
        expect(JSON.parse(serialized).evidence.some((evidence: JsonRecord) => evidence.id === item.id)).toBe(false)
        continue
      }
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

const withheld = 'Value withheld by the Console redaction boundary.'
const startGoldenBff = (source: OpenKubesObservedStateAdapter) => startBff(source, async (request) => ({
  ...await prototypeAuthorizer(request),
  scope: { environmentId: 'openkubes-management', tenantIds: ['platform'] },
}))
const golden = async (mode = 'hosting-external') => {
  const fixtures = JSON.parse(await readFile(new URL('./openKubesObservedState.fixtures.json', import.meta.url), 'utf8'))
  expect(fixtures.producerRevision).toBe('1b0739f')
  expect(fixtures.producerSha256).toBe('e798f2dca87405ef9dfc93dd81c519396d5252f2ff678602304788261c8ccf39')
  return structuredClone(fixtures.snapshots[mode])
}
const parentAt = (object: JsonRecord, path: string) => {
  const keys = path.split('.')
  let parent = object
  for (const key of keys.slice(0, -1)) parent = parent[key] as JsonRecord
  return { parent, key: keys.at(-1)! }
}
const at = (object: JsonRecord, path: string) => {
  const { parent, key } = parentAt(object, path)
  return parent[key]
}

// Every display grammar has a canonical value, an own-bound violation, and
// foreign text. Display scalar/type/global-size errors remain structural failures;
// Evidence timestamps deliberately isolate missing/type errors to their item.
const displayCases = [
  ['environment.displayName', 'Other sovereign environment', 'a'.repeat(65), 'Vendor9'],
  ['clusters.0.provider', 'OtherCloud', 'a'.repeat(65), 'cloud://vendor'],
  ['clusters.0.profile', 'West regional hosting cluster', 'one two three four five six seven', 'profile_v2'],
  ['clusters.0.region', 'moon-west-2', 'a'.repeat(64), 'us/west'],
  ['clusters.0.kubernetesVersion', 'v01.034.005-rc.01+rke2r1', 'v1.2.3+' + 'a'.repeat(33), 'v1.2.3 arbitrary'],
  ['clusters.0.contractVersion', 'kubernetes.io/core+apps/v1', 'x'.repeat(100), 'platform.openkubes.io/v9'],
  ['clusters.0.lifecycle.0.label', 'External observation', 'x'.repeat(100), 'Foreign stage'],
  ['clusters.0.lifecycle.0.detail', 'Ready: 3; not ready: 0; unknown: 1.', 'Ready: 9007199254740992; not ready: 0; unknown: 1.', 'Ready: 3; not ready: 0; unknown: 1. tail'],
  ['evidence.0.title', 'ok-mgmt external cluster observation', 'x'.repeat(300), 'other external cluster observation'],
  ['evidence.0.contract', 'Kubernetes core/apps v1', 'x'.repeat(100), 'Other/v1'],
  ['evidence.0.source', 'Operator-provided read-only observation bundle', 'x'.repeat(100), 'Other read only bundle'],
  ['evidence.0.revision', 'external-observation', 'x'.repeat(150), 'sha256:' + 'a'.repeat(64)],
  ['clusters.0.revision', 'external-observation', 'x'.repeat(150), 'resourceVersion:12'],
  ['placements.0.name', 'openkubes-console/ok-console', 'n'.repeat(64) + '/ok-console', 'other:deployment'],
  ['placements.0.targetCluster', 'ok-shared', 'a'.repeat(254), 'bad/name'],
] as const

describe('typed producer output contract', () => {
  it('G3 real producer hosting-external output ages external Evidence at the default threshold with an offset clock', async () => {
    const envelope = await golden('hosting-external')
    // 90 seconds after the producer finished, expressed with a real UTC offset.
    const snapshot = normalizeOpenKubesObservedState(envelope, { now: () => new Date('2026-10-22T14:01:34+02:00') })
    expect(snapshot.sourceHealth.freshness).toBe('Current')
    // Synthetic read-start times from test-fixtures/regenerate-observed-state.py's 2 s step clock.
    expect(snapshot.observedAt).toBe('2026-10-22T12:00:04Z')
    expect(snapshot.evidence.filter((item: JsonRecord) => item.clusterId === 'cluster-ok-shared')
      .map((item: JsonRecord) => item.observedAt)).toEqual(['2026-10-22T12:00:00Z', '2026-10-22T12:00:02Z'])
    expect(snapshot.clusters.map((item: JsonRecord) => [item.name, item.readiness])).toEqual([
      ['ok-mgmt', 'Unknown'], ['ok-shared', 'Ready'], ['ok-ai', 'Unknown'], ['ok-infra', 'Unknown'],
    ])
    expect(snapshot.evidence.filter((item: JsonRecord) => item.source === 'Operator-provided read-only observation bundle')
      .map((item: JsonRecord) => item.freshness)).toEqual(['Stale', 'Stale', 'Stale'])
    expect(snapshot.placements[0].readiness).toBe('Ready')
  })

  it.each(['hosting-cluster', 'hosting-external', 'kubevirt-claims'])('accepts pinned producer %s with no grammar withholding', async (mode) => {
    const envelope = await golden(mode)
    const snapshot = normalizeOpenKubesObservedState(envelope, { now: () => new Date(envelope.metadata.observedAt), staleAfterMs: 30 * 86400000 })
    expect(JSON.stringify(snapshot)).not.toContain(withheld)
    expect(snapshot.evidence).toHaveLength(envelope.data.evidence.length)
    for (const field of ['clusters', 'placements', 'environment'] as const) expect(snapshot[field]).toEqual(envelope.data[field])
    for (const [index, evidence] of snapshot.evidence.entries()) {
      expect(evidence).toEqual({ ...envelope.data.evidence[index], summary: 'Evidence summary withheld by the Console redaction boundary.', redacted: true, freshness: 'Current' })
    }
    const bff = await startGoldenBff(new OpenKubesObservedStateAdapter({ url: await startQuery(envelope), now: () => new Date(envelope.metadata.observedAt) }))
    for (const path of ['session', 'overview', 'clusters', ...snapshot.evidence.map((item: JsonRecord) => `evidence/${item.id}`)]) {
      const response = await fetch(`${bff}/api/console/v0/${path}`)
      expect(response.status, path).toBe(200)
      const body = await response.json()
      expect(validateConsoleResponse(body), path).toEqual({ valid: true, errors: [] })
      expect(JSON.stringify(body), path).not.toContain(withheld)
    }
  })

  it.each(displayCases)('validates display grammar %s', async (path, valid, ownBound, foreign) => {
    for (const value of [valid, ownBound, foreign, '', ' ', ' leading', 'trailing ', 'double  spaces', 'value\n', 'value\t', 'ｖａｌｕｅ', `${valid} tail!`, `${valid}\n`]) {
      const envelope = await golden()
      const { parent, key } = parentAt(envelope.data, path)
      parent[key] = value
      if (value === '') {
        expect(() => normalizeOpenKubesObservedState(envelope), path).toThrow('non-empty bounded string')
      } else {
        const snapshot = normalizeOpenKubesObservedState(envelope)
        expect(at(snapshot, path), `${path}: ${JSON.stringify(value)}`).toBe(value === valid ? valid : withheld)
      }
    }
    for (const value of [undefined, null, 7, {}, [], 'x'.repeat(513)]) {
      const envelope = await golden()
      const { parent, key } = parentAt(envelope.data, path)
      if (value === undefined) delete parent[key]
      else parent[key] = value
      expect(() => normalizeOpenKubesObservedState(envelope), path).toThrow('non-empty bounded string')
    }
  })

  it('withholds capability names outside the words grammar', async () => {
    for (const value of [' ', '\n', 'ｘ', 'a'.repeat(65), 'Identity9', 'two  words', 'one two three four five six seven', 'token']) {
      const envelope = await golden()
      const cluster = envelope.data.clusters[0]
      cluster.capabilities.push({ id: 'cap-identity', name: value, readiness: 'Ready', evidenceId: cluster.evidenceId, ownership: cluster.ownership })
      expect(normalizeOpenKubesObservedState(envelope).clusters[0].capabilities[0].name).toBe(withheld)
    }
    for (const value of [undefined, null, 7, '', 'a'.repeat(513)]) {
      const envelope = await golden()
      const cluster = envelope.data.clusters[0]
      cluster.capabilities.push({ id: 'cap-identity', name: value, readiness: 'Ready', evidenceId: cluster.evidenceId, ownership: cluster.ownership })
      expect(() => normalizeOpenKubesObservedState(envelope)).toThrow()
    }
  })

  it('checks all identifier leaves before joins, without narrowing the 512-character ID grammar', async () => {
    const envelope = await golden()
    const cluster = envelope.data.clusters[0]
    cluster.capabilities.push({ id: 'a'.repeat(512), name: 'Future', readiness: 'Ready', evidenceId: cluster.evidenceId, ownership: cluster.ownership })
    for (const id of ['a', 'a..b', 'a.-b', 'a'.repeat(512)]) {
      cluster.capabilities[0].id = id
      expect(normalizeOpenKubesObservedState(envelope).clusters[0].capabilities[0].id).toBe(id)
    }
    const paths = ['clusters.0.id', 'clusters.0.evidenceId', 'clusters.0.capabilities.0.id', 'clusters.0.capabilities.0.evidenceId', 'evidence.0.id', 'evidence.0.clusterId', 'placements.0.id', 'placements.0.evidenceId', 'placements.0.targetClusterId']
    for (const path of paths) for (const value of [undefined, null, {}, '', 'a'.repeat(513), ' leading', 'trailing ', 'a\n', 'a\t', 'ａ', 'A', '-a', 'a-', 'a/path', 'foreign value']) {
      const copy = structuredClone(envelope)
      const { parent, key } = parentAt(copy.data, path)
      if (value === undefined) delete parent[key]
      else parent[key] = value
      expect(() => normalizeOpenKubesObservedState(copy), `${path}: ${JSON.stringify(value)}`).toThrow()
    }
  })

  it.each(['a'.repeat(63) + '.' + 'b'.repeat(63) + '.' + 'c'.repeat(63) + '.' + 'd'.repeat(61), 'a'.repeat(63) + '.west', 'dns-label'])('accepts DNS subdomain cluster name %s', async (name) => {
    const envelope = await golden()
    envelope.data.clusters[0].name = name
    expect(normalizeOpenKubesObservedState(envelope).clusters[0].name).toBe(name)
  })
  it.each([undefined, null, 7, '', 'a'.repeat(64), 'a'.repeat(254), 'a'.repeat(513), '-a', 'a-', 'A', 'a..b', ' leading', 'a\n', 'a\t', 'ａ', 'name extra'])('rejects invalid cluster names %s', async (value) => {
    const envelope = await golden()
    envelope.data.clusters[0].name = value
    expect(() => normalizeOpenKubesObservedState(envelope)).toThrow()
  })

  it.each(['Ready: 0; not ready: 9007199254740991; unknown: 1.', 'Available replicas: unknown of 2.', 'Available replicas: 0 of unknown.'])('regenerates numeric lifecycle detail %s', async (detail) => {
    const envelope = await golden()
    envelope.data.clusters[0].lifecycle[0].detail = detail
    expect(normalizeOpenKubesObservedState(envelope).clusters[0].lifecycle[0].detail).toBe(detail)
  })
  it.each(['Ready: 01; not ready: 0; unknown: 0.', 'Available replicas: 01 of 2.', 'Available replicas: None of 2.', 'Available replicas: 9007199254740992 of 2.'])('withholds invalid numeric lifecycle detail %s', async (detail) => {
    const envelope = await golden()
    envelope.data.clusters[0].lifecycle[0].detail = detail
    expect(normalizeOpenKubesObservedState(envelope).clusters[0].lifecycle[0].detail).toBe(withheld)
  })

  it.each(['unknown', '1.2', 'v1.2.3', '01.002.0003-01+00', 'v1.35.5+rke2r1', 'v1.2.3+ghp-abcdefghijk', 'v1.2.3+dXNlcjpwYXNz', 'v1.2.3+a8F3k7J9m2P4q6R1', 'v1.2.3+AKIA123456789012', 'v1.2.3+xoxb-123456789', 'v1.2.3+sk-abcdefghijk'])('accepts version grammar including known credential-shaped limits: %s', async (version) => {
    const envelope = await golden('kubevirt-claims')
    envelope.data.clusters[1].kubernetesVersion = version
    expect(normalizeOpenKubesObservedState(envelope).clusters[1].kubernetesVersion).toBe(version)
  })
  it.each(['v1.2.3+' + 'x'.repeat(93), 'v1.2.3+abcdefghijklmnopq', 'v1.2.3-a.b.c.d.e', 'v1.2.3+a.b.c.d.e', 'v1.2.3+' + 'abcd.'.repeat(6) + 'abcd', 'v1.2.3+JWT.eyJ4IjoxfQ.eA', 'v12345678901.2.3', 'v1', 'v1.2.3.4', 'v1.2.3+'])('withholds invalid or deny-listed version %s', async (version) => {
    const envelope = await golden('kubevirt-claims')
    envelope.data.clusters[1].kubernetesVersion = version
    const snapshot = normalizeOpenKubesObservedState(envelope)
    expect(snapshot.clusters[1].kubernetesVersion).toBe(withheld)
    expect(snapshot.clusters).toHaveLength(2)
  })

  it.each(['2024-02-29T23:59:59.123456789+05:30', '2026-10-22T12:00:00Z'])('accepts strict RFC 3339 %s', async (observedAt) => {
    const envelope = await golden()
    envelope.metadata.observedAt = observedAt
    envelope.data.evidence[0].observedAt = observedAt
    const snapshot = normalizeOpenKubesObservedState(envelope)
    expect(snapshot.observedAt).toBe(observedAt)
    expect(snapshot.evidence[0].observedAt).toBe(observedAt)
  })
  it.each([undefined, null, 7, '', {}, [], '2026-02-29T12:00:00Z', '2026-04-31T12:00:00Z', '2026-10-22', '2026-10-22T12:00:00', '2026-10-22T24:00:00Z', '2026-10-22T12:60:00Z', '2026-10-22T12:00:60Z', '2026-10-22T12:00:00+24:00', '2026-10-22T12:00:00+00:60', '2026-10-22T12:00:00.1234567890Z', '2026-10-22T12:00:00Z\n', 'ｘ', ' timestamp '])('rejects metadata but isolates Evidence timestamp %s', async (observedAt) => {
    const envelope = await golden()
    envelope.metadata.observedAt = observedAt
    expect(() => normalizeOpenKubesObservedState(envelope)).toThrow()
    envelope.metadata.observedAt = '2026-10-22T12:00:00Z'
    envelope.data.evidence[0].observedAt = observedAt
    const snapshot = normalizeOpenKubesObservedState(envelope)
    expect(snapshot.evidence).toHaveLength(envelope.data.evidence.length - 1)
    expect(snapshot.evidence.some((item: JsonRecord) => item.id === envelope.data.evidence[0].id)).toBe(false)
    expect(snapshot.clusters[0].evidenceId).toBe(envelope.data.evidence[0].id)
  })

  it('isolates bad external Evidence time through HTTP and still checks its ownership and references', async () => {
    const envelope = await golden()
    const badId = envelope.data.evidence[0].id
    envelope.data.evidence[0].observedAt = '2026-02-30T12:00:00Z'
    const source = new OpenKubesObservedStateAdapter({ url: await startQuery(envelope) })
    const bff = await startGoldenBff(source)
    for (const path of ['session', 'overview', 'clusters']) {
      const response = await fetch(`${bff}/api/console/v0/${path}`)
      expect(response.status).toBe(200)
      expect(validateConsoleResponse(await response.json())).toEqual({ valid: true, errors: [] })
    }
    expect((await fetch(`${bff}/api/console/v0/evidence/${badId}`)).status).toBe(404)
    envelope.data.evidence[0].ownership.tenantId = 'foreign'
    expect(() => normalizeOpenKubesObservedState(envelope)).toThrow('ownership')
    envelope.data.evidence[0].ownership.tenantId = 'platform'
    envelope.data.evidence[0].clusterId = 'missing-cluster'
    expect(() => normalizeOpenKubesObservedState(envelope)).toThrow('unresolved Evidence cluster reference')
  })

  it('retains valid unregistered tenant objects and hides them from another tenant', async () => {
    const envelope = await golden()
    assignClusterTenant(envelope, 'cluster-ok-ai', 'Unregistered Tenant')
    expect(normalizeOpenKubesObservedState(envelope).clusters.find((item: JsonRecord) => item.id === 'cluster-ok-ai')).toBeDefined()
    const bff = await startGoldenBff(new OpenKubesObservedStateAdapter({ url: await startQuery(envelope) }))
    for (const path of ['session', 'overview', 'clusters']) {
      const response = await fetch(`${bff}/api/console/v0/${path}`)
      expect(response.status).toBe(200)
      expect(JSON.stringify(await response.json())).not.toContain('cluster-ok-ai')
    }
  })

  it('derives placement target from the resolved cluster identity', async () => {
    const envelope = await golden()
    envelope.data.placements[0].targetCluster = 'foreign-cluster'
    const bff = await startGoldenBff(new OpenKubesObservedStateAdapter({ url: await startQuery(envelope) }))
    const response = await fetch(`${bff}/api/console/v0/overview`)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.data.recentPlacements[0].targetCluster).toBe('ok-shared')
    expect(JSON.stringify(body)).not.toContain('foreign-cluster')
  })

  it('pins the live overlay to the grammar-accepted external producer fixture', async () => {
    const yaml = await readFile(new URL('../deploy/kubernetes/overlays/ok-shared-live/producer-cluster-observations.yaml', import.meta.url), 'utf8')
    const observations = JSON.parse(yaml.split('observations.json: |\n')[1])
    const envelope = await golden()
    const snapshot = normalizeOpenKubesObservedState(envelope, { now: () => new Date(envelope.metadata.observedAt), staleAfterMs: 30 * 86400000 })
    for (const item of observations.clusters) {
      expect(item).not.toHaveProperty('revision')
      const cluster = snapshot.clusters.find((cluster: JsonRecord) => cluster.name === item.name)
      for (const field of ['provider', 'kubernetesVersion', 'region', 'readiness']) expect(cluster[field]).toBe(item[field])
      if (item.name === 'ok-mgmt') expect(item).not.toHaveProperty('profile')
      else expect(cluster.profile).toBe(item.profile)
      expect(cluster.revision).toBe('external-observation')
    }
  })
})

describe('source-specific revision grammars', () => {
  it.each([
    ['OpenKubes hosting-cluster source boundary', 'not-observed-by-hosting-source'],
    ['Bounded Kubernetes API projection', 'nodes:unknown;deployment:00012'],
    ['OpenKubes observed-state producer', 'claimListResourceVersion:12'],
    ['OpenKubes management-plane Kubernetes API', 'resourceVersion:00012'],
    ['Operator-provided read-only observation bundle', 'external-observation'],
  ])('accepts the closed revision for %s', async (source, revision) => {
    for (const value of [revision, `${revision} tail`, `${revision}\n`, 'foreign', 'sha256:' + 'a'.repeat(64), '0'.repeat(129), 'x'.repeat(512)]) {
      const envelope = await golden()
      envelope.data.evidence[0].source = source
      envelope.data.evidence[0].revision = value
      envelope.data.clusters[0].revision = value
      const snapshot = normalizeOpenKubesObservedState(envelope)
      expect(snapshot.clusters[0].revision).toBe(value === revision ? revision : withheld)
      expect(snapshot.evidence[0].revision).toBe(value === revision ? revision : withheld)
    }
  })
  it.each(['resourceVersion:12;replicas:2/2', 'resourceVersion:unknown;replicas:None/None', 'resourceVersion:' + '1'.repeat(128) + ';replicas:0/9007199254740991'])('accepts workload revision %s', async (revision) => {
    const envelope = await golden()
    const item = envelope.data.evidence.find((item: JsonRecord) => item.source === 'Authenticated hosting-cluster Kubernetes API')
    item.revision = revision
    expect(normalizeOpenKubesObservedState(envelope).evidence.find((evidence: JsonRecord) => evidence.id === item.id).revision).toBe(revision)
  })
  it.each(['resourceVersion:12;replicas:01/2', 'resourceVersion:12;replicas:9007199254740992/2', 'resourceVersion:' + '1'.repeat(129) + ';replicas:2/2', 'resourceVersion:12;replicas:unknown/2', 'resourceVersion:12;replicas:2/2 tail'])('withholds invalid workload revision %s', async (revision) => {
    const envelope = await golden()
    const item = envelope.data.evidence.find((item: JsonRecord) => item.source === 'Authenticated hosting-cluster Kubernetes API')
    item.revision = revision
    expect(normalizeOpenKubesObservedState(envelope).evidence.find((evidence: JsonRecord) => evidence.id === item.id).revision).toBe(withheld)
  })
  it('checks sourceRevision structure, size and scalar type', async () => {
    const valid = ['kubevirtclusterclaims:unknown', 'kubevirtclusterclaims:' + '1'.repeat(128), 'kubernetes:unknown;nodes:unknown;deployment:12', 'kubernetes:v1.35.5+rke2r1;nodes:12;deployment:13']
    for (const value of [...valid, 'kubevirtclusterclaims:' + '1'.repeat(129), 'kubernetes:v1.2.3+abcdefghijklmnopq;nodes:12;deployment:13', 'kubernetes:v1.2.3;nodes:1;deployment:2;tail', 'sha256:' + 'a'.repeat(64), ' ', 'ｘ', 'kubevirtclusterclaims:12\n', 'foreign', 'x'.repeat(512)]) {
      const envelope = await golden()
      envelope.metadata.sourceRevision = value
      expect(normalizeOpenKubesObservedState(envelope).sourceRevision).toBe(valid.includes(value) ? value : withheld)
    }
    for (const value of [undefined, null, [], 1, '', 'x'.repeat(513)]) {
      const envelope = await golden()
      envelope.metadata.sourceRevision = value
      expect(() => normalizeOpenKubesObservedState(envelope)).toThrow('non-empty bounded string')
    }
  })
})

describe('grammar boundary discriminators', () => {
  it.each([
    ['v1.2.3-' + 'a'.repeat(15) + '.' + 'b'.repeat(16) + '+' + 'c'.repeat(11) + '.' + 'd'.repeat(12), true],
    ['v1.2.3-' + 'a'.repeat(16) + '.' + 'b'.repeat(16), false],
    ['v1.2.3+' + 'a'.repeat(16) + '.' + 'b'.repeat(16), false],
    ['v1234567890.1234567890.1234567890-' + 'a'.repeat(15) + '.' + 'b'.repeat(16) + '+x', false],
  ])('checks independent version bounds %s', async (value, valid) => {
    const envelope = await golden()
    envelope.data.clusters[0].kubernetesVersion = value
    expect(normalizeOpenKubesObservedState(envelope).clusters[0].kubernetesVersion).toBe(valid ? value : withheld)
  })
  it('keeps the global Evidence timestamp size bound as an envelope failure', async () => {
    const envelope = await golden()
    envelope.data.evidence[0].observedAt = '1'.repeat(513)
    expect(() => normalizeOpenKubesObservedState(envelope)).toThrow('non-empty bounded string')
  })
  it('declares the producer Infrastructure plane role in the unchanged Presentation version', async () => {
    const schema = JSON.parse(await readFile(new URL('../contracts/presentation/v0alpha1/schema.json', import.meta.url), 'utf8'))
    expect(schema.$defs.clusterSummary.properties.role.enum).toContain('Infrastructure plane')
    expect(schema.$defs.apiVersion.const).toBe('console.openkubes.io/v0alpha1')
  })
})

describe('producer title and source bindings', () => {
  it.each([
    ['ok-ai external cluster observation', 'Operator-provided read-only observation bundle'],
    ['Deployment openkubes-console/ok-console', 'Authenticated hosting-cluster Kubernetes API'],
    ['ok-mgmt cluster Claim readiness', 'Operator-provided read-only observation bundle'],
  ])('withholds foreign identity or source title %s', async (title, source) => {
    const envelope = await golden()
    envelope.data.evidence[0].title = title
    envelope.data.evidence[0].source = source
    expect(normalizeOpenKubesObservedState(envelope).evidence[0].title).toBe(withheld)
  })
  it.each([
    ['Management plane outside hosting source', 'OpenKubes hosting-cluster source boundary'],
    ['Management plane observation boundary', 'OpenKubes observed-state producer'],
  ])('withholds management title on workload Evidence %s', async (title, source) => {
    const envelope = await golden()
    const evidence = envelope.data.evidence.find((item: JsonRecord) => item.clusterId === 'cluster-ok-shared')
    evidence.title = title
    evidence.source = source
    expect(normalizeOpenKubesObservedState(envelope).evidence.find((item: JsonRecord) => item.id === evidence.id).title).toBe(withheld)
  })
  it('selects the cluster revision grammar from its own Evidence source', async () => {
    const envelope = await golden()
    envelope.data.evidence[1].source = 'OpenKubes observed-state producer'
    envelope.data.clusters[0].revision = 'claimListResourceVersion:1'
    expect(normalizeOpenKubesObservedState(envelope).clusters[0].revision).toBe(withheld)
  })
})

describe('independent title binding discriminators', () => {
  it.each([
    ['Management plane outside hosting source', 'OpenKubes observed-state producer'],
    ['Management plane observation boundary', 'OpenKubes hosting-cluster source boundary'],
  ])('withholds management title with the wrong producer source %s', async (title, source) => {
    const envelope = await golden()
    envelope.data.evidence[0].title = title
    envelope.data.evidence[0].source = source
    expect(normalizeOpenKubesObservedState(envelope).evidence[0].title).toBe(withheld)
  })
  it('binds the Deployment title to its own Evidence ID even within one cluster', async () => {
    const envelope = await golden()
    const item = envelope.data.evidence.find((item: JsonRecord) => item.id === 'ev-ok-shared-hosting-state')
    item.title = 'Deployment openkubes-console/ok-console'
    item.source = 'Authenticated hosting-cluster Kubernetes API'
    expect(normalizeOpenKubesObservedState(envelope).evidence.find((evidence: JsonRecord) => evidence.id === item.id).title).toBe(withheld)
  })
  it('binds the Deployment title to its placement target cluster', async () => {
    const envelope = await golden()
    const item = envelope.data.evidence.find((item: JsonRecord) => item.id === 'ev-observed-deployment-openkubes-console-ok-console')
    item.clusterId = 'cluster-ok-ai'
    expect(normalizeOpenKubesObservedState(envelope).evidence.find((evidence: JsonRecord) => evidence.id === item.id).title).toBe(withheld)
  })
})

it('withholds a real Deployment title under a different producer source', async () => {
  const envelope = await golden()
  const item = envelope.data.evidence.find((item: JsonRecord) => item.id === 'ev-observed-deployment-openkubes-console-ok-console')
  item.source = 'OpenKubes observed-state producer'
  expect(normalizeOpenKubesObservedState(envelope).evidence.find((evidence: JsonRecord) => evidence.id === item.id).title).toBe(withheld)
})

it('retains the credential-shape check for a value that fits the ID grammar', async () => {
  const envelope = await golden()
  const cluster = envelope.data.clusters[0]
  cluster.capabilities.push({
    id: 'putty-user-key-file-3',
    name: 'Future capability',
    readiness: 'Ready',
    evidenceId: cluster.evidenceId,
    ownership: cluster.ownership,
  })
  expect(() => normalizeOpenKubesObservedState(envelope)).toThrow('must not contain a credential value.')
})

it.each(['password-cluster', 'prod-secret', 'tokenizer-1', 'credentials-svc', 'cookie-shop', 'my-api-key', 'aws-access-key', 'private-key-store', 'bearer-x'])('withholds keyword-only DNS-valid cluster name %s', async (name) => {
  const envelope = await golden()
  envelope.data.clusters[0].name = name
  expect(normalizeOpenKubesObservedState(envelope).clusters[0].name).toBe(withheld)
})

it('fixture mode withholds no values', async () => {
  const snapshot = await fixtureSource.readSnapshot()
  expect(JSON.stringify(snapshot)).not.toContain(withheld)
  expect(snapshot.clusters).toHaveLength(4)
  expect(snapshot.clusters[0].capabilities.map((item: JsonRecord) => item.name)).toEqual(['Identity', 'GitOps', 'Observability', 'Artifact Registry'])
})

it.each(['Identity', 'Networking', 'Foreign', 'Artifact Registry', 'a'.repeat(64)])('preserves words capability name %s', async (name) => {
  const envelope = await golden()
  const cluster = envelope.data.clusters[0]
  cluster.capabilities.push({ id: 'cap-name', name, readiness: 'Ready', evidenceId: cluster.evidenceId, ownership: cluster.ownership })
  expect(normalizeOpenKubesObservedState(envelope).clusters[0].capabilities[0].name).toBe(name)
})

it.each([undefined, null, 9, {}, [], '', 'UPPER', 'bad/id', 'bad id', 'a_', 'ａ', 'a\n', '-a', 'a-', 'a'.repeat(513), 'putty-user-key-file-3'])('rejects invalid environment identifier %s', async (id) => {
  const envelope = await golden()
  envelope.data.environment.id = id
  const updateOwnership = (value: unknown) => {
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      if (key === 'environmentId') (value as JsonRecord)[key] = id
      else updateOwnership(child)
    }
  }
  updateOwnership(envelope.data)
  expect(() => normalizeOpenKubesObservedState(envelope)).toThrow()
})

it('withholds a cluster revision whose Evidence has a foreign source', async () => {
  const envelope = await golden()
  envelope.data.evidence[0].source = 'Foreign observer'
  envelope.data.clusters[0].revision = 'arbitrary revision'
  const snapshot = normalizeOpenKubesObservedState(envelope)
  expect(snapshot.clusters[0].revision).toBe(withheld)
  expect(snapshot.evidence[0].source).toBe(withheld)
})

it.each(['token-lab', 'secret-lab', 'cookie-shop'])('isolates keyword-only Claim name %s across tenants without an outage', async (name) => {
  const envelope = await golden('kubevirt-claims')
  assignClusterTenant(envelope, 'cluster-worker-east', 'A')
  const foreign = structuredClone(envelope.data.clusters[1])
  foreign.id = `cluster-${name}`
  foreign.name = name
  foreign.evidenceId = `ev-${name}-claim-readiness`
  const evidence = structuredClone(envelope.data.evidence[1])
  evidence.id = foreign.evidenceId
  evidence.clusterId = foreign.id
  evidence.title = `${name} cluster Claim readiness`
  envelope.data.clusters.push(foreign)
  envelope.data.evidence.push(evidence)
  assignClusterTenant(envelope, foreign.id, 'B')
  const snapshot = normalizeOpenKubesObservedState(envelope)
  expect(snapshot.clusters.find((item: JsonRecord) => item.id === foreign.id).name).toBe(withheld)
  const query = await startQuery(envelope)
  const bff = await startBff(new OpenKubesObservedStateAdapter({ url: query, now: () => new Date(envelope.metadata.observedAt) }), async (request) => ({
    ...await prototypeAuthorizer(request),
    scope: { environmentId: envelope.data.environment.id, tenantIds: ['A'] },
  }))
  for (const path of ['session', 'overview', 'clusters']) {
    const response = await fetch(`${bff}/api/console/v0/${path}`)
    expect(response.status, path).toBe(200)
    const body = await response.json()
    expect(validateConsoleResponse(body), path).toEqual({ valid: true, errors: [] })
    expect(JSON.stringify(body)).not.toContain(foreign.id)
    if (path === 'clusters') expect(body.data.items.map((item: JsonRecord) => item.name)).toEqual(['worker-east'])
  }
  foreign.name = 'putty-user-key-file-3'
  expect(() => normalizeOpenKubesObservedState(envelope)).toThrow('must not contain a credential value')
})
