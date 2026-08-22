// @vitest-environment node

import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const load = async (name: string) => JSON.parse(await readFile(new URL(`./base/${name}`, import.meta.url), 'utf8'))

describe('OK-166 Kubernetes security invariants', () => {
  it('contains no Secret values and defaults Console traffic to deny', async () => {
    const names = ['service-account.json', 'service.json', 'deployment.json', 'pod-disruption-budget.json', 'network-policy-default-deny.json']
    const resources = await Promise.all(names.map(load))
    expect(resources.map((item) => item.kind)).not.toContain('Secret')
    const policy = resources.find((item) => item.kind === 'NetworkPolicy')
    expect(policy.spec).toEqual({
      podSelector: { matchLabels: { 'app.kubernetes.io/name': 'ok-console' } },
      policyTypes: ['Ingress', 'Egress'],
    })
  })

  it('runs a digest-pinned restricted workload without a service-account token', async () => {
    const deployment = await load('deployment.json')
    const pod = deployment.spec.template.spec
    const container = pod.containers[0]
    expect(container.image).toMatch(/^ghcr\.io\/openkubes\/ok-console@sha256:[a-f0-9]{64}$/)
    expect(pod).toMatchObject({
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      securityContext: { runAsNonRoot: true, runAsUser: 1000, seccompProfile: { type: 'RuntimeDefault' } },
    })
    expect(container.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ['ALL'] },
    })
    expect(container.resources.requests).toEqual({ cpu: '250m', memory: '256Mi' })
    expect(container.resources.limits).toEqual({ cpu: '2', memory: '768Mi' })
  })

  it('binds probes to dependency-aware readiness and independent liveness', async () => {
    const deployment = await load('deployment.json')
    const container = deployment.spec.template.spec.containers[0]
    expect(container.startupProbe.httpGet.path).toBe('/health/live')
    expect(container.livenessProbe.httpGet.path).toBe('/health/live')
    expect(container.readinessProbe.httpGet.path).toBe('/health/ready')
    expect(deployment.spec.replicas).toBeGreaterThanOrEqual(2)
    expect(deployment.spec.template.spec.topologySpreadConstraints).toHaveLength(1)
    expect((await load('pod-disruption-budget.json')).spec.minAvailable).toBe(1)
  })

  it('mounts credential contracts read-only instead of putting values in environment variables', async () => {
    const deployment = await load('deployment.json')
    const pod = deployment.spec.template.spec
    const container = pod.containers[0]
    expect(container.volumeMounts.every((mount: { readOnly?: boolean }) => mount.readOnly === true)).toBe(true)
    expect(pod.volumes.every((volume: { secret?: { defaultMode?: number } }) => volume.secret?.defaultMode === 256)).toBe(true)
    const env = Object.fromEntries(container.env.map((item: { name: string, value: string }) => [item.name, item.value]))
    for (const name of ['OK_CONSOLE_POSTGRES_URL_FILE', 'OK_CONSOLE_SESSION_ENVELOPE_KEYS_FILE', 'OK_CONSOLE_OIDC_CLIENT_SECRET_FILE', 'OK_CONSOLE_LOCAL_ACCESS_PEPPER_FILE', 'OK_CONSOLE_OBSERVED_STATE_CA_FILE', 'OK_CONSOLE_OBSERVED_STATE_CLIENT_CERT_FILE', 'OK_CONSOLE_OBSERVED_STATE_CLIENT_KEY_FILE']) {
      expect(env[name]).toMatch(/^\/run\/secrets\/ok-console\//)
    }
    expect(JSON.stringify(deployment)).not.toMatch(/postgresql:\/\/|BEGIN PRIVATE KEY|client-secret-value|password=/i)
  })

  it('pins the build base and leaves the runtime as a non-root process', async () => {
    const dockerfile = await readFile(new URL('../../Dockerfile', import.meta.url), 'utf8')
    expect(dockerfile).toMatch(/FROM --platform=\$\{BUILDPLATFORM\} node:22\.19\.0-alpine3\.22@sha256:[a-f0-9]{64} AS build/)
    expect(dockerfile).toMatch(/FROM --platform=\$\{TARGETPLATFORM\} node:22\.19\.0-alpine3\.22@sha256:[a-f0-9]{64} AS runtime/)
    expect(dockerfile).toContain('pnpm prune --prod')
    expect(dockerfile).toContain("find node_modules -type f -name '*.node'")
    expect(dockerfile).toContain('USER node')
    expect(dockerfile).not.toMatch(/FROM .*:latest|USER root/)
  })
})
