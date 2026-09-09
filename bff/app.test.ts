// @vitest-environment node

import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { validateConsoleResponse } from '../src/domain/presentationContract'
import { FixtureObservedStateAdapter } from './adapters/fixtureObservedState.mjs'
import { createConsoleBffHandler } from './app.mjs'

type JsonRecord = Record<string, unknown>

const fixtureSource = new FixtureObservedStateAdapter()
let server: Server
let baseUrl: string

const startBff = async (options: Parameters<typeof createConsoleBffHandler>[0] = { source: fixtureSource }) => {
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
    enableFailureInjection: true,
    now: () => new Date('2026-08-21T18:00:00Z'),
    correlationId: () => 'corr-provider-test',
  })
})

afterEach(async () => {
  await stopBff()
})

describe('read-only Console BFF provider', () => {
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
    await startBff({ source, correlationId: () => 'corr-redaction-test' })

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
        environment: { ...raw.environment, id: { token: 'credential-material-123' } },
      }),
    }
    const authorizer = async () => ({
      allowed: true,
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

    expect(stale.body).toMatchObject({ meta: { freshness: 'Stale', warnings: [{ code: 'SOURCE_STALE' }] } })
    expect(degraded.body).toMatchObject({ meta: { warnings: [{ code: 'PARTIAL_DATA' }] } })
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
