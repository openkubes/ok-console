// @vitest-environment node

import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { validateConsoleResponse } from '../src/domain/presentationContract'
import { FixtureObservedStateAdapter } from './adapters/fixtureObservedState.mjs'
import authorizationContext from '../contracts/security/v0alpha1/examples/authorization-context.json'
import { authorizeSecurityContext } from './security/authorization.mjs'
import { createConsoleBffHandler, prototypeAuthorizer } from './app.mjs'

type JsonRecord = Record<string, unknown>

const fixtureSource = new FixtureObservedStateAdapter()
let server: Server
let baseUrl: string

const startBff = async (options: Parameters<typeof createConsoleBffHandler>[0] = { source: fixtureSource, authorizer: prototypeAuthorizer }) => {
  server = createServer(createConsoleBffHandler(options))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test BFF did not expose a TCP address.')
  baseUrl = `http://127.0.0.1:${address.port}`
}

const stopBff = async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

const getJson = async (path: string, init?: RequestInit) => {
  const response = await fetch(`${baseUrl}${path}`, init)
  return { response, body: await response.json() as JsonRecord }
}

beforeEach(async () => {
  await startBff({
    source: fixtureSource,
    authorizer: prototypeAuthorizer,
    enableFailureInjection: true,
    now: () => new Date('2026-08-21T18:00:00Z'),
    correlationId: () => 'corr-provider-test',
  })
})

afterEach(async () => {
  await stopBff()
})

describe('read-only Console BFF provider', () => {
  it('requires an explicit callable authorizer at handler construction', () => {
    expect(() => createConsoleBffHandler({ source: fixtureSource } as Parameters<typeof createConsoleBffHandler>[0]))
      .toThrow('requires an explicit callable authorizer')
    expect(() => createConsoleBffHandler({ source: fixtureSource, authorizer: null } as unknown as Parameters<typeof createConsoleBffHandler>[0]))
      .toThrow('requires an explicit callable authorizer')
  })

  it.each([
    ['/api/console/v0/session', 'SessionContext'],
    ['/api/console/v0/overview', 'PlatformOverview'],
    ['/api/console/v0/clusters', 'ClusterList'],
    ['/api/console/v0/clusters/cluster-ok-mgmt', 'ClusterDetail'],
    ['/api/console/v0/evidence/ev-mgmt-ready', 'EvidenceReference'],
  ])('serves a valid %s projection', async (path, kind) => {
    const { response, body } = await getJson(path, {
      headers: { Accept: 'application/json; profile="console.openkubes.io/v0alpha1"' },
    })

    expect(response.status).toBe(200)
    expect(body.kind).toBe(kind)
    expect(validateConsoleResponse(body)).toEqual({ valid: true, errors: [] })
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-correlation-id')).toBe('corr-provider-test')
  })

  it('keeps management plane first and returns complete cluster detail', async () => {
    const list = await getJson('/api/console/v0/clusters')
    const detail = await getJson('/api/console/v0/clusters/cluster-ok-mgmt')
    const items = (list.body.data as { items: Array<{ name: string }> }).items
    const cluster = detail.body.data as { name: string; capabilityCount: number; lifecycle: unknown[] }

    expect(items.map((item) => item.name)).toEqual(['ok-mgmt', 'ok-ai', 'ok-shared', 'edge-07'])
    expect(cluster).toMatchObject({ name: 'ok-mgmt', capabilityCount: 4 })
    expect(cluster.lifecycle).toHaveLength(4)
  })

  it('projects only allowlisted fields from the observed backend model', async () => {
    const raw = await fixtureSource.readSnapshot()
    const source = {
      readSnapshot: async () => ({
        ...raw,
        clusters: raw.clusters.map((cluster: JsonRecord, index: number) => index === 0
          ? { ...cluster, token: 'must-not-cross-the-boundary', rawKubernetesObject: { kind: 'Secret' } }
          : cluster),
      }),
    }
    await stopBff()
    await startBff({ source, authorizer: prototypeAuthorizer, correlationId: () => 'corr-redaction-test' })

    const { body } = await getJson('/api/console/v0/clusters/cluster-ok-mgmt')
    const serialized = JSON.stringify(body)

    expect(validateConsoleResponse(body)).toEqual({ valid: true, errors: [] })
    expect(serialized).not.toContain('must-not-cross-the-boundary')
    expect(serialized).not.toContain('rawKubernetesObject')
    expect(serialized).not.toContain('Secret')
  })

  it('fails closed if a presentation response contains a forbidden credential field', async () => {
    const raw = await fixtureSource.readSnapshot()
    const source = {
      readSnapshot: async () => ({
        ...raw,
        environment: { ...raw.environment, displayName: { token: 'credential-material-123' } },
      }),
    }
    const authorizer = async () => ({
      allowed: true,
      scope: { environmentId: 'community-preview', tenantIds: ['platform'] },
      identity: {
        id: 'test',
        displayName: 'Test',
        identitySource: 'OIDC',
        assurance: 'Federated',
        permissions: ['platform.read'],
      },
    })
    await stopBff()
    await startBff({ source, authorizer, correlationId: () => 'corr-safety-test' })

    const { response, body } = await getJson('/api/console/v0/session')

    expect(response.status).toBe(500)
    expect(body).toMatchObject({ kind: 'Error', error: { code: 'INTERNAL_ERROR', retryable: false } })
    expect(validateConsoleResponse(body)).toEqual({ valid: true, errors: [] })
    expect(JSON.stringify(body)).not.toContain('credential-material-123')
  })

  it.each([
    ['forbidden', 403, 'FORBIDDEN'],
    ['unavailable', 503, 'SOURCE_UNAVAILABLE'],
    ['incompatible', 502, 'CONTRACT_INCOMPATIBLE'],
  ])('provides a bounded %s failure', async (failure, status, code) => {
    const { response, body } = await getJson(`/api/console/v0/overview?failure=${failure}`)

    expect(response.status).toBe(status)
    expect(body).toMatchObject({ kind: 'Error', error: { code } })
    expect(validateConsoleResponse(body)).toEqual({ valid: true, errors: [] })
  })

  it('represents stale and degraded sources without inventing readiness', async () => {
    const stale = await getJson('/api/console/v0/overview?failure=stale')
    const degraded = await getJson('/api/console/v0/overview?failure=degraded')

    expect(stale.body).toMatchObject({ meta: { freshness: 'Stale', warnings: expect.arrayContaining([expect.objectContaining({ code: 'SOURCE_STALE' })]) } })
    expect(degraded.body).toMatchObject({ meta: { warnings: expect.arrayContaining([expect.objectContaining({ code: 'PARTIAL_DATA' })]) } })
    expect(validateConsoleResponse(stale.body)).toEqual({ valid: true, errors: [] })
    expect(validateConsoleResponse(degraded.body)).toEqual({ valid: true, errors: [] })
  })

  it('enforces the injected point-of-use authorization hook', async () => {
    await stopBff()
    await startBff({
      source: fixtureSource,
      authorizer: async () => ({ allowed: false, identity: null }),
      correlationId: () => 'corr-denied-test',
    })

    const { response, body } = await getJson('/api/console/v0/clusters')

    expect(response.status).toBe(403)
    expect(body).toMatchObject({ kind: 'Error', error: { code: 'FORBIDDEN', retryable: false } })
  })

  it('rejects mutation methods and arbitrary proxy paths', async () => {
    const mutation = await getJson('/api/console/v0/clusters', { method: 'POST' })
    const proxy = await getJson('/api/console/v0/api/v1/secrets')

    expect(mutation.response.status).toBe(405)
    expect(mutation.body).toMatchObject({ kind: 'Error', error: { code: 'FORBIDDEN' } })
    expect(proxy.response.status).toBe(404)
    expect(proxy.body).toMatchObject({ kind: 'Error', error: { code: 'NOT_FOUND' } })
  })

  it('executes an authenticated CreateCluster dry-run through the injected runner boundary', async () => {
    await stopBff()
    await startBff({
      source: fixtureSource,
      authorizer: prototypeAuthorizer,
      dryRunExecutor: async ({ contract, identity, correlationId }) => ({
        format: 'ok147-create-plan/v1',
        operation: 'CreateCluster',
        contractIdentity: contract.metadata?.name ?? 'unknown',
        mutationAllowed: false,
        actor: identity.id,
        correlationId,
      }),
    })
    const response = await fetch(`${baseUrl}/api/console/v0/operations/create-cluster/dry-run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contract: { apiVersion: 'clusters.openkubes.io/v1alpha1', metadata: { name: 'demo' } } }),
    })
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.kind).toBe('CreateClusterDryRun')
    expect(body.data.mutationAllowed).toBe(false)
    expect(body.data.operation).toBe('CreateCluster')
  })

  it('rejects unsupported Presentation Contract profiles', async () => {
    const { response, body } = await getJson('/api/console/v0/overview', {
      headers: { Accept: 'application/json; profile="console.openkubes.io/v9"' },
    })

    expect(response.status).toBe(406)
    expect(body).toMatchObject({ kind: 'Error', error: { code: 'CONTRACT_INCOMPATIBLE' } })
  })

  it('turns adapter failure into a retryable, redaction-safe source error', async () => {
    await stopBff()
    await startBff({
      source: { readSnapshot: async () => { throw new Error('backend details must stay private') } },
      authorizer: prototypeAuthorizer,
      correlationId: () => 'corr-source-test',
    })

    const { response, body } = await getJson('/api/console/v0/overview')

    expect(response.status).toBe(503)
    expect(body).toMatchObject({ kind: 'Error', error: { code: 'SOURCE_UNAVAILABLE', retryable: true } })
    expect(JSON.stringify(body)).not.toContain('backend details')
  })

  it.each([
    ['Bootstrap', 'Local', 'Break glass'],
    ['BreakGlass', 'Local', 'Break glass'],
  ])('projects %s security identities into the coarse SessionContext contract', async (method, identitySource, assurance) => {
    await stopBff()
    await startBff({
      source: fixtureSource,
      authorizer: async () => ({
        allowed: true,
        scope: { environmentId: 'community-preview', tenantIds: ['platform'] },
        identity: {
          id: 'local-test', displayName: 'Local Test', identitySource: method, assurance,
          permissions: ['platform.read'],
        },
      }),
      correlationId: () => 'corr-session-method-test',
    })
    const { response, body } = await getJson('/api/console/v0/session')
    expect(response.status).toBe(200)
    expect(body).toMatchObject({ data: { subject: { identitySource, assurance } } })
    expect(validateConsoleResponse(body)).toEqual({ valid: true, errors: [] })
  })
})

// Exercise authorization before every projection with a valid, mixed-owner graph.
const mixedSnapshot = async () => {
  const raw = await fixtureSource.readSnapshot()
  const environmentId = raw.environment.id
  const clusters = raw.clusters.map((cluster: { id: string; capabilities: JsonRecord[] }) => {
    const ownership = { environmentId, tenantId: cluster.id === 'cluster-ok-ai' ? 'A' : 'B' }
    return { ...cluster, ownership, capabilities: cluster.capabilities.map((capability) => ({ ...capability, ownership })) }
  })
  const ownerFor = (id: string) => clusters.find((cluster: { id: string }) => cluster.id === id)!.ownership
  const counts = (total: number) => ({ total, ready: total, pending: 0, failed: 0, unknown: 0 })
  return {
    ...raw,
    clusters,
    evidence: raw.evidence.map((item: { clusterId: string }) => ({ ...item, ownership: ownerFor(item.clusterId) })),
    placements: raw.placements.map((item: { targetCluster: string }) => {
      const targetClusterId = `cluster-${item.targetCluster}`
      return { ...item, targetClusterId, ownership: ownerFor(targetClusterId) }
    }),
    metrics: ['A', 'B'].map((tenantId, index) => ({
      ownership: { environmentId, tenantId },
      capabilities: counts(index ? 90 : 3), workloadClaims: counts(index ? 80 : 1),
      openFindings: { total: index ? 70 : 2, critical: 0 },
    })),
  }
}

const startMixed = async (snapshot: Awaited<ReturnType<typeof mixedSnapshot>>, allowed = true) => {
  await stopBff()
  await startBff({
    source: { readSnapshot: async () => snapshot },
    authorizer: async ({ permission }) => authorizeSecurityContext({
      ...structuredClone(authorizationContext),
      scope: { environmentId: snapshot.environment.id, tenantIds: ['A', 'B'] },
      permissions: allowed ? ['platform.read', 'clusters.read', 'evidence.read'] : [],
    }, { permission, environmentId: snapshot.environment.id, tenantId: 'A' }, () => new Date('2026-08-21T19:05:00Z')),
    correlationId: () => 'corr-object-auth',
  })
}

describe('OK-173 object authorization', () => {
  it('filters lists, capabilities, overview counts, metrics and recent placements before projection', async () => {
    await startMixed(await mixedSnapshot())
    const list = await getJson('/api/console/v0/clusters')
    expect(list.response.status).toBe(200)
    expect(list.body).toMatchObject({ data: { items: [{ id: 'cluster-ok-ai', capabilityCount: 3 }] } })
    expect((list.body.data as { items: unknown[] }).items).toHaveLength(1)
    const overview = await getJson('/api/console/v0/overview')
    expect(overview.body).toMatchObject({ data: {
      clusters: { total: 1, ready: 1, pending: 0, failed: 0, unknown: 0 },
      capabilities: { total: 3 }, workloadClaims: { total: 1 }, openFindings: { total: 2 },
      managementPlane: null, recentPlacements: [{ id: 'claim-private-ai' }],
    } })
    expect((overview.body.data as { recentPlacements: unknown[] }).recentPlacements).toHaveLength(1)
    const detail = await getJson('/api/console/v0/clusters/cluster-ok-ai')
    expect(detail.response.status).toBe(200)
    expect((detail.body.data as { capabilities: unknown[] }).capabilities).toHaveLength(3)
    const evidence = await getJson('/api/console/v0/evidence/ev-ai-ready')
    expect(evidence.response.status).toBe(200)
    const session = await getJson('/api/console/v0/session')
    expect(session.response.status).toBe(200)
    expect(validateConsoleResponse(session.body)).toEqual({ valid: true, errors: [] })
    expect(JSON.stringify(session.body)).not.toContain('tenantIds')
  })

  it.each([
    ['clusters', 'cluster-ok-mgmt'], ['evidence', 'ev-mgmt-ready'],
  ])('makes foreign %s indistinguishable from missing ids', async (route, foreignId) => {
    await startMixed(await mixedSnapshot())
    const foreign = await getJson(`/api/console/v0/${route}/${foreignId}`)
    const missing = await getJson(`/api/console/v0/${route}/random-missing-id`)
    expect(foreign.response.status).toBe(404)
    expect(missing.response.status).toBe(404)
    expect(foreign.body).toEqual(missing.body)
  })

  it('denies route permission before reading or looking up an object', async () => {
    await stopBff()
    await startBff({ source: { readSnapshot: async () => { throw new Error('lookup must not run') } },
      authorizer: async () => ({ allowed: false, identity: null }) })
    expect((await getJson('/api/console/v0/clusters/cluster-ok-ai')).response.status).toBe(403)
  })

  it('fails closed without an authorized scope', async () => {
    await stopBff()
    await startBff({ source: fixtureSource, authorizer: async () => ({ ...(await prototypeAuthorizer({ permission: 'platform.read' })), scope: undefined }) })
    expect((await getJson('/api/console/v0/overview')).response.status).toBe(403)
  })

  it('keeps unavailable visible metric leaves unavailable and ignores unavailable hidden buckets', async () => {
    const raw = await mixedSnapshot()
    raw.metrics[1].capabilities.total = null
    await startMixed(raw)
    expect((await getJson('/api/console/v0/overview')).body).toMatchObject({ data: { capabilities: { total: 3 } } })
    raw.metrics[0].capabilities.total = null
    raw.metrics[0].openFindings.total = null
    const overview = await getJson('/api/console/v0/overview')
    expect(overview.body).toMatchObject({ data: { capabilities: { total: null, ready: 3 }, openFindings: { total: null } } })
    expect(validateConsoleResponse(overview.body)).toEqual({ valid: true, errors: [] })
  })
})

it('sums all visible metric buckets while unavailable wins and an empty scope yields no objects', async () => {
  const raw = await mixedSnapshot()
  raw.metrics.push({ ...structuredClone(raw.metrics[0]), capabilities: { total: 4, ready: 4, pending: 0, failed: 0, unknown: 0 } })
  await startMixed(raw)
  expect((await getJson('/api/console/v0/overview')).body).toMatchObject({ data: { capabilities: { total: 7, ready: 7 } } })
  raw.metrics[2].capabilities.total = null
  expect((await getJson('/api/console/v0/overview')).body).toMatchObject({ data: { capabilities: { total: null, ready: 7 } } })
  await stopBff()
  await startBff({ source: { readSnapshot: async () => raw }, authorizer: async () => ({
    ...(await prototypeAuthorizer({ permission: 'platform.read' })), scope: { environmentId: raw.environment.id, tenantIds: [] },
  }) })
  const overview = await getJson('/api/console/v0/overview')
  expect(overview.body).toMatchObject({ data: { clusters: { total: 0 }, capabilities: { total: 0 }, managementPlane: null, recentPlacements: [] } })
})


it('rejects a session scope for another environment before projection', async () => {
  const snapshot = await mixedSnapshot()
  await stopBff()
  await startBff({ source: { readSnapshot: async () => snapshot }, authorizer: async () => ({
    ...(await prototypeAuthorizer({ permission: 'platform.read' })),
    scope: { environmentId: 'another-environment', tenantIds: ['A'] },
  }) })
  expect((await getJson('/api/console/v0/overview')).response.status).toBe(403)
})

it('does not reveal hidden evidence through object-derived metadata on overview or session', async () => {
  const raw = await mixedSnapshot()
  for (const cluster of raw.clusters) {
    cluster.ownership.tenantId = 'B'
    for (const capability of cluster.capabilities) capability.ownership.tenantId = 'B'
  }
  for (const item of [...raw.evidence, ...raw.placements, ...raw.metrics]) item.ownership.tenantId = 'B'
  // Keep the adapter's warning about redacted evidence; it must be scoped before projection.
  raw.sourceHealth = { freshness: 'Current', warnings: [{ code: 'REDACTED', message: 'Sensitive Evidence summary content was redacted at the Console source boundary.' }] }
  await startMixed(raw)
  for (const route of ['overview', 'session']) {
    const result = await getJson(`/api/console/v0/${route}`)
    expect(result.response.status).toBe(200)
    expect((result.body.meta as { warnings?: Array<{ code: string }> }).warnings ?? []).not.toEqual(expect.arrayContaining([expect.objectContaining({ code: 'REDACTED' })]))
    expect(validateConsoleResponse(result.body)).toEqual({ valid: true, errors: [] })
  }
})
