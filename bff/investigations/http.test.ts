// @vitest-environment node

import dns from 'node:dns'
import http, { createServer, type Server } from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createConsoleBffHandler, prototypeAuthorizer } from '../app.mjs'
import { createConsoleServer } from '../server.mjs'
import { sha256Digest } from './canonical.mjs'
import { loadInvestigationPacks } from './pack.mjs'
import { createInvestigationService } from './service.mjs'

const PACKS_DIR = fileURLToPath(new URL('./test-fixtures/', import.meta.url))
const API = '/api/console/v0'
const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
  vi.restoreAllMocks()
})

const listen = async (server: Server) => {
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const consoleServer = async (env: Record<string, string> = {}) => {
  const runtime = await createConsoleServer({ env: { OK_CONSOLE_DEV_PROTOTYPE_ENABLED: 'true', OK_CONSOLE_INVESTIGATION_PACKS_DIR: PACKS_DIR, ...env } })
  return listen(runtime.server)
}

const start = (base: string, body: unknown = { scenarioId: 'example-crashloop' }, headers: Record<string, string> = {}) =>
  fetch(`${base}${API}/investigations`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })

describe('fixture investigation API under fixture-read-only', () => {
  it('lists scenarios, starts an investigation, returns the result and its evidence', async () => {
    const base = await consoleServer({ OK_CONSOLE_DEPLOYMENT_POLICY: 'fixture-read-only' })

    const list = await (await fetch(`${base}${API}/investigations/scenarios`)).json()
    expect(list.kind).toBe('InvestigationScenarioList')
    expect(list.data.scenarios).toEqual([expect.objectContaining({ id: 'example-crashloop', synthetic: true, fixture: 'example-crashloop@1', packDigest: expect.stringMatching(/^sha256:/) })])
    expect(list.meta.warnings).toEqual([expect.objectContaining({ code: 'SYNTHETIC_FIXTURE' })])
    expect(list.meta).toMatchObject({ freshness: 'Unknown', observedAt: '2026-01-01T00:00:00Z' })

    const started = await start(base)
    expect(started.status).toBe(201)
    const created = await started.json()
    expect(created.kind).toBe('InvestigationResult')
    const result = created.data
    expect(result).toMatchObject({
      correlationId: created.meta.correlationId,
      scenario: { id: 'example-crashloop', synthetic: true },
      source: { kind: 'fixture', liveClusterAccess: false },
      analysis: { kind: 'recorded', liveModel: false },
      verification: { basis: 'established', assessment: 'fully_supported' },
      outcome: 'completed',
    })
    expect(result.recommendations.every((recommendation: { executionStatus: string }) => recommendation.executionStatus === 'not_executed')).toBe(true)

    // Fixture time, response time and freshness are kept apart.
    expect(created.meta).toMatchObject({ observedAt: '2026-01-01T00:00:00Z', freshness: 'Unknown' })
    expect(result.source).toMatchObject({ observedAt: '2026-01-01T00:00:00Z', freshness: 'Unknown' })
    expect(Date.parse(result.startedAt)).toBeGreaterThan(Date.parse(result.source.observedAt))

    const fetched = await (await fetch(`${base}${API}/investigations/${result.investigationId}`)).json()
    expect(fetched.data).toEqual(result)
    expect(fetched.meta).toMatchObject({ observedAt: '2026-01-01T00:00:00Z', freshness: 'Unknown' })

    const evidenceRef = result.evidence[0]
    const evidence = await (await fetch(`${base}${evidenceRef.href}`)).json()
    expect(evidence.kind).toBe('InvestigationEvidence')
    expect(evidence.data).toMatchObject({ id: evidenceRef.id, digest: evidenceRef.digest, integrity: 'verified', synthetic: true })
    expect(sha256Digest(evidence.data.data)).toBe(evidenceRef.digest)
    expect(evidence.meta).toMatchObject({ observedAt: evidenceRef.collectedAt, freshness: 'Unknown' })
  })

  it('offers no way to act on an eligible recommendation', async () => {
    const policyBase = await consoleServer({ OK_CONSOLE_DEPLOYMENT_POLICY: 'fixture-read-only' })
    const plainBase = await consoleServer()
    for (const base of [policyBase, plainBase]) {
      const { data } = await (await start(base)).json()
      const recommendation = data.recommendations.find((candidate: { eligible: boolean }) => candidate.eligible)
      expect(recommendation).toMatchObject({ eligible: true, executionStatus: 'not_executed' })
      for (const suffix of [`/recommendations/${recommendation.id}`, `/recommendations/${recommendation.id}/execute`, '/execute']) {
        const response = await fetch(`${base}${API}/investigations/${data.investigationId}${suffix}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        expect([403, 405], `${base} ${suffix}`).toContain(response.status)
      }
      const again = await (await fetch(`${base}${API}/investigations/${data.investigationId}`)).json()
      expect(again.data.recommendations.every((candidate: { executionStatus: string }) => candidate.executionStatus === 'not_executed')).toBe(true)
    }
  })

  it('starts reproducibly: different ids, same result digest', async () => {
    const base = await consoleServer({ OK_CONSOLE_DEPLOYMENT_POLICY: 'fixture-read-only' })
    const [a, b] = [await (await start(base)).json(), await (await start(base)).json()]
    expect(a.data.investigationId).not.toBe(b.data.investigationId)
    expect(a.data.reproducibility.resultDigest).toBe(b.data.reproducibility.resultDigest)
  })

  it.each([
    ['an unknown scenario', { scenarioId: 'does-not-exist' }, {}, 404],
    ['an extra field', { scenarioId: 'example-crashloop', cluster: 'prod-cluster' }, {}, 400],
    ['a kubeconfig in the body', { scenarioId: 'example-crashloop', kubeconfig: 'apiVersion: v1' }, {}, 400],
    ['a malformed scenario id', { scenarioId: '../etc/passwd' }, {}, 400],
    ['invalid JSON', '{"scenarioId":', {}, 400],
    ['a list body', ['example-crashloop'], {}, 400],
    ['a wrong content type', '{"scenarioId":"example-crashloop"}', { 'content-type': 'text/plain' }, 415],
    ['an oversized body', JSON.stringify({ scenarioId: 'example-crashloop', pad: 'x'.repeat(8 * 1024) }), {}, 413],
  ])('rejects a start with %s', async (_name, body, headers, status) => {
    const base = await consoleServer({ OK_CONSOLE_DEPLOYMENT_POLICY: 'fixture-read-only' })
    expect((await start(base, body, headers)).status).toBe(status)
  })

  it.each([
    ['PUT', `${API}/investigations`],
    ['PATCH', `${API}/investigations`],
    ['DELETE', `${API}/investigations`],
    ['POST', `${API}/investigations/`],
    ['POST', `${API}/investigations/scenarios`],
    ['POST', `${API}/investigations/inv-00000000-0000-4000-8000-000000000000`],
    ['POST', `${API}/investigations/inv-00000000-0000-4000-8000-000000000000/evidence/ev-status`],
    ['DELETE', `${API}/investigations/inv-00000000-0000-4000-8000-000000000000`],
    ['POST', `${API}/%69nvestigations`],
    ['POST', `${API}/INVESTIGATIONS`],
    ['POST', `${API}/investigations?scenarioId=example-crashloop&execute=true`.replace('?', '/run?')],
    ['POST', `${API}/operations/create-cluster/dry-run`],
  ])('the policy refuses %s %s before any handler runs', async (method, path) => {
    const base = await consoleServer({ OK_CONSOLE_DEPLOYMENT_POLICY: 'fixture-read-only' })
    const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'DELETE' ? undefined : '{"scenarioId":"example-crashloop"}' })
    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe('DEPLOYMENT_POLICY_READ_ONLY')
  })

  it('answers GET on the start path with 405 and unknown ids with 404', async () => {
    const base = await consoleServer({ OK_CONSOLE_DEPLOYMENT_POLICY: 'fixture-read-only' })
    expect((await fetch(`${base}${API}/investigations`)).status).toBe(405)
    expect((await fetch(`${base}${API}/investigations/inv-00000000-0000-4000-8000-000000000000`)).status).toBe(404)
    expect((await fetch(`${base}${API}/investigations/not-an-id`)).status).toBe(404)
    const { data } = await (await start(base)).json()
    expect((await fetch(`${base}${API}/investigations/${data.investigationId}/evidence/ev-unknown`)).status).toBe(404)
  })

  it('keeps the routes absent when no packs are configured', async () => {
    const runtime = await createConsoleServer({ env: { OK_CONSOLE_DEV_PROTOTYPE_ENABLED: 'true' } })
    const base = await listen(runtime.server)
    expect((await fetch(`${base}${API}/investigations/scenarios`)).status).toBe(404)
    expect((await start(base)).status).toBe(405)
  })

  it('refuses to start with an invalid pack directory', async () => {
    await expect(createConsoleServer({ env: { OK_CONSOLE_DEV_PROTOTYPE_ENABLED: 'true', OK_CONSOLE_INVESTIGATION_PACKS_DIR: 'relative/packs' } })).rejects.toThrow('Invalid investigation pack configuration')
  })
})

describe('fixture investigation authorization', () => {
  const handlerServer = async (options: Record<string, unknown>) => {
    const packs = await loadInvestigationPacks(PACKS_DIR)
    const handler = createConsoleBffHandler({ source: { readSnapshot: vi.fn() }, investigationService: createInvestigationService({ packs: packs! }), ...options } as never)
    return listen(createServer((request, response) => { void handler(request, response) }))
  }

  it('requires the Console origin for a start when the BFF runs with sessions', async () => {
    const base = await handlerServer({ authorizer: prototypeAuthorizer, expectedOrigin: 'https://console.example.test' })
    expect((await start(base)).status).toBe(403)
    expect((await start(base, undefined, { origin: 'https://attacker.example' })).status).toBe(403)
    expect((await start(base, undefined, { origin: 'https://console.example.test' })).status).toBe(201)
  })

  it('refuses identities without the required permission', async () => {
    const base = await handlerServer({ authorizer: async () => ({ allowed: false }) })
    expect((await start(base)).status).toBe(403)
    expect((await fetch(`${base}${API}/investigations/scenarios`)).status).toBe(403)
  })
})

describe('fixture investigation start has no outside effects', () => {
  it('opens no network connection, resolves no name and never touches a dry-run runner', async () => {
    const packs = await loadInvestigationPacks(PACKS_DIR)
    const service = createInvestigationService({ packs: packs! })
    const spies = [
      vi.spyOn(globalThis, 'fetch'),
      vi.spyOn(http, 'request'), vi.spyOn(http, 'get'),
      vi.spyOn(https, 'request'), vi.spyOn(https, 'get'),
      vi.spyOn(net, 'connect'), vi.spyOn(net, 'createConnection'), vi.spyOn(tls, 'connect'),
      vi.spyOn(dns, 'lookup'),
    ]
    const result = service.start({ scenarioId: 'example-crashloop', correlationId: 'corr-offline' })
    expect(result?.outcome).toBe('completed')
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })

  it('keeps stored results bounded and returns copies', async () => {
    const packs = await loadInvestigationPacks(PACKS_DIR)
    const service = createInvestigationService({ packs: packs!, maxStored: 2 })
    const ids = [1, 2, 3].map(() => service.start({ scenarioId: 'example-crashloop', correlationId: 'c' })!.investigationId)
    expect(service.get(ids[0])).toBeNull()
    const kept = service.get(ids[2])!
    kept.outcome = 'aborted_error'
    expect(service.get(ids[2])!.outcome).toBe('completed')
  })
})
