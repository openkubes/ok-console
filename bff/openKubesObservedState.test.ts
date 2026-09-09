// @vitest-environment node

import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { validateConsoleResponse } from '../src/domain/presentationContract'
import { OpenKubesObservedStateAdapter } from './adapters/openKubesObservedState.mjs'
import { FixtureObservedStateAdapter } from './adapters/fixtureObservedState.mjs'
import { createConsoleBffHandler } from './app.mjs'
import { createObservedStateSource } from './source.mjs'

type JsonRecord = Record<string, unknown>

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
    apiVersion: 'observed.openkubes.io/v0alpha1',
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

const startQuery = async (payload: unknown, { status = 200, contentType = 'application/json' } = {}) => listen(createServer((_request, response) => {
  response.writeHead(status, { 'Content-Type': contentType })
  response.end(JSON.stringify(payload))
}))

const startBff = async (source: OpenKubesObservedStateAdapter) => listen(createServer(createConsoleBffHandler({
  source,
  now: () => new Date('2026-08-21T18:01:00Z'),
  correlationId: () => 'corr-openkubes-integration',
})))

describe('OpenKubes observed-state query adapter', () => {
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
        warnings: [{ code: 'SOURCE_STALE' }, { code: 'PARTIAL_DATA' }],
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

  it('turns incompatible real source data into a bounded BFF failure', async () => {
    const envelope = await observedEnvelope()
    envelope.apiVersion = 'observed.openkubes.io/v9'
    const queryUrl = await startQuery(envelope)
    const bffUrl = await startBff(new OpenKubesObservedStateAdapter({ url: queryUrl }))
    const response = await fetch(`${bffUrl}/api/console/v0/clusters`)
    const body = await response.json()

    expect(response.status).toBe(502)
    expect(body).toMatchObject({ kind: 'Error', error: { code: 'CONTRACT_INCOMPATIBLE', retryable: false } })
    expect(JSON.stringify(body)).not.toContain('observed.openkubes.io/v9')
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
