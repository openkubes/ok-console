// @vitest-environment node

import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { AUTHENTICATION_WRITES, DeploymentPolicyError, deploymentPolicyAllows, deploymentPolicyDocument, resolveDeploymentPolicy } from './deploymentPolicy.mjs'
import { createConsoleServer } from './server.mjs'
import { createObservedStateSource } from './source.mjs'

const problemsOf = (env: Record<string, string>) => {
  try { resolveDeploymentPolicy(env) } catch (error) { expect(error).toBeInstanceOf(DeploymentPolicyError); return (error as DeploymentPolicyError).problems }
  throw new Error('expected DeploymentPolicyError')
}

describe('deployment policy configuration', () => {
  it('leaves the built-in behaviour unchanged when unset', () => {
    expect(resolveDeploymentPolicy({})).toBeNull()
    expect(deploymentPolicyDocument(null)).toEqual({ schema: 'openkubes.console.deployment-policy/v1', policy: 'default', clusterLifecycle: true })
  })

  it('resolves fixture-read-only to a frozen read-only policy', () => {
    const policy = resolveDeploymentPolicy({ OK_CONSOLE_DEPLOYMENT_POLICY: 'fixture-read-only', OK_CONSOLE_OBSERVED_STATE_MODE: 'fixture' })
    expect(policy).toEqual({ name: 'fixture-read-only', clusterLifecycle: false, liveClusterAccess: false, writeApis: false })
    expect(Object.isFrozen(policy)).toBe(true)
    expect(deploymentPolicyDocument(policy)).toEqual({ schema: 'openkubes.console.deployment-policy/v1', policy: 'fixture-read-only', clusterLifecycle: false })
  })

  it.each(['', 'read-only', 'FIXTURE-READ-ONLY', 'fixture-read-only ', 'default', 'true'])('rejects the unknown value %j', (value) => {
    expect(problemsOf({ OK_CONSOLE_DEPLOYMENT_POLICY: value }).join()).toMatch(/must be unset or "fixture-read-only"/)
  })

  it('rejects live cluster access and a dry-run runner under the policy, listing every contradiction', () => {
    const problems = problemsOf({ OK_CONSOLE_DEPLOYMENT_POLICY: 'fixture-read-only', OK_CONSOLE_OBSERVED_STATE_MODE: 'openkubes', OK_CONSOLE_DRY_RUN_URL: 'https://runner.invalid/dry-run' })
    expect(problems).toHaveLength(2)
    expect(problems.join()).toMatch(/OBSERVED_STATE_MODE must be "fixture"/)
    expect(problems.join()).toMatch(/DRY_RUN_URL must not be set/)
    expect(problemsOf({ OK_CONSOLE_DEPLOYMENT_POLICY: 'fixture-read-only', OK_CONSOLE_DRY_RUN_URL: '' })).toHaveLength(1)
  })

  it('never reads branding', () => {
    expect(resolveDeploymentPolicy({ OK_CONSOLE_BRANDING_DIR: '/etc/branding' })).toBeNull()
  })
})

describe('deployment policy enforcement', () => {
  const policy = resolveDeploymentPolicy({ OK_CONSOLE_DEPLOYMENT_POLICY: 'fixture-read-only' })

  it.each([
    // Reads
    ['GET', '/api/console/v0/overview', true],
    ['HEAD', '/api/console/v0/clusters', true],
    ['GET', '/api/console/v0/session', true],
    ['GET', '/api/console/v0/auth/session', true],
    ['GET', '/api/console/v0/auth/oidc/start', true],
    ['GET', '/api/console/v0/auth/oidc/callback', true],
    ['GET', '/api/console/v0/local-identity/list', true],
    // The four allowed authentication writes, exact method and path
    ['POST', '/api/console/v0/auth/local', true],
    ['POST', '/api/console/v0/local-identity/login', true],
    ['POST', '/api/console/v0/auth/session/rotate', true],
    ['DELETE', '/api/console/v0/auth/session', true],
    // Wrong method on an allowed path
    ['POST', '/api/console/v0/auth/session', false],
    ['PUT', '/api/console/v0/auth/session/rotate', false],
    ['DELETE', '/api/console/v0/auth/local', false],
    ['PATCH', '/api/console/v0/local-identity/login', false],
    // Variants of allowed paths
    ['POST', '/api/console/v0/auth/local/', false],
    ['POST', '/api/console/v0/AUTH/local', false],
    ['POST', '/api/console/v0/auth/%6Cocal', false],
    ['POST', '/api/console/v0/auth/session/rotate/extra', false],
    // Existing auth and identity writes outside the allowlist
    ['POST', '/api/console/v0/auth/oidc/start', false],
    ['POST', '/api/console/v0/auth/oidc/callback', false],
    ['POST', '/api/console/v0/local-identity/initialize', false],
    ['POST', '/api/console/v0/local-identity/create', false],
    ['POST', '/api/console/v0/local-identity/disable', false],
    ['POST', '/api/console/v0/local-identity/recover', false],
    // Unknown or future auth writes are refused by default
    ['POST', '/api/console/v0/auth/register', false],
    ['POST', '/api/console/v0/auth/session/impersonate', false],
    ['PUT', '/api/console/v0/auth/oidc/config', false],
    ['DELETE', '/api/console/v0/auth/local', false],
    ['POST', '/api/console/v0/auth/tokens', false],
    // Cluster operations, any method or spelling
    ['POST', '/api/console/v0/operations/create-cluster/dry-run', false],
    ['GET', '/api/console/v0/operations/create-cluster/dry-run', false],
    ['HEAD', '/api/console/v0/operations', false],
    ['POST', '/api/console/v0/%6Fperations/create-cluster/dry-run', false],
    ['POST', '/api/console/v0/OPERATIONS/create-cluster/dry-run', false],
    ['GET', '/api/console/v0/clusters/x/operations/register', false],
    // Other writes
    ['PUT', '/api/console/v0/clusters', false],
    ['PATCH', '/api/console/v0/clusters/ok-mgmt', false],
    ['DELETE', '/api/console/v0/clusters/ok-mgmt', false],
    ['POST', '/api/console/v0/evidence/ev-1', false],
    ['POST', '/api/console/v0/%E0%A4%A', false],
  ])('%s %s → allowed %s', (method, path, allowed) => {
    expect(deploymentPolicyAllows(policy, method, path)).toBe(allowed)
  })

  it('allows everything without a policy, as before', () => {
    expect(deploymentPolicyAllows(null, 'POST', '/api/console/v0/operations/create-cluster/dry-run')).toBe(true)
    expect(deploymentPolicyAllows(null, 'POST', '/api/console/v0/local-identity/create')).toBe(true)
  })

  it('lists only routes that really exist, with the method they are routed for', () => {
    const security = ['httpSession.mjs', 'localAccessHttp.mjs', 'localIdentityHttp.mjs']
      .map((file) => readFileSync(new URL(`./security/${file}`, import.meta.url), 'utf8')).join('\n')
    expect(AUTHENTICATION_WRITES.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'POST /api/console/v0/auth/local',
      'POST /api/console/v0/local-identity/login',
      'POST /api/console/v0/auth/session/rotate',
      'DELETE /api/console/v0/auth/session',
    ])
    expect(security).toContain("const PATH = '/api/console/v0/auth/local'")
    expect(security).toContain("const ROOT = '/api/console/v0/local-identity'")
    expect(security).toContain("const operation = pathname.slice(ROOT.length + 1)")
    expect(security).toContain("const SESSION_PATH = '/api/console/v0/auth/session'")
    expect(security).toContain('const ROTATE_PATH = `${SESSION_PATH}/rotate`')
    expect(security).toContain("pathname === ROTATE_PATH && request.method === 'POST'")
    expect(security).toContain("pathname === SESSION_PATH && request.method === 'DELETE'")
    expect(Object.isFrozen(AUTHENTICATION_WRITES)).toBe(true)
  })
})

describe('GET routes under fixture-read-only (real BFF)', () => {
  it('only ever read the source snapshot and never reach a cluster operation', async () => {
    const calls: string[] = []
    const sourceFactory = (env: Record<string, string | undefined>) => {
      const real = createObservedStateSource(env) as unknown as Record<string, unknown>
      return new Proxy(real, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver)
          if (typeof value === 'function') return (...args: unknown[]) => { calls.push(String(property)); return (value as (...a: unknown[]) => unknown).apply(target, args) }
          return value
        },
      })
    }
    const dryRunFactory = vi.fn()
    const runtime = await createConsoleServer({
      env: { OK_CONSOLE_DEV_PROTOTYPE_ENABLED: 'true', OK_CONSOLE_DEPLOYMENT_POLICY: 'fixture-read-only' },
      sourceFactory: sourceFactory as never,
      dryRunFactory: dryRunFactory as never,
    })
    await new Promise<void>((resolve) => runtime.server.listen(0, '127.0.0.1', resolve))
    const { port } = runtime.server.address() as AddressInfo
    const base = `http://127.0.0.1:${port}/api/console/v0`
    try {
      const overview = await (await fetch(`${base}/overview`)).json()
      const clusterId = overview.data?.clusters?.[0]?.id ?? (await (await fetch(`${base}/clusters`)).json()).data?.clusters?.[0]?.id
      const evidenceId = overview.data?.evidence?.[0]?.id ?? 'unknown'
      const paths = ['/session', '/overview', '/clusters', `/clusters/${clusterId}`, `/evidence/${evidenceId}`, '/auth/session', '/operations/create-cluster/dry-run']
      for (const path of paths) {
        const response = await fetch(`${base}${path}`)
        if (path.startsWith('/operations')) expect(response.status).toBe(403)
        else expect(response.status, path).not.toBe(500)
      }
      expect(new Set(calls)).toEqual(new Set(['readSnapshot']))
      expect(dryRunFactory).not.toHaveBeenCalled()
    } finally {
      await new Promise<void>((resolve) => runtime.server.close(() => resolve()))
    }
  })
})
