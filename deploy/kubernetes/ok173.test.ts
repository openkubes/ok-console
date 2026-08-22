// @vitest-environment node

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const exec = promisify(execFile)
const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8')

describe('OK-173 break-glass deployment candidate', () => {
  it('pins the reviewed break-glass image and authentication boundary', async () => {
    const overlay = await read('./overlays/ok-shared-breakglass/kustomization.yaml')
    const deployment = await read('./overlays/ok-shared-breakglass/deployment-breakglass.yaml')
    const policy = await read('./overlays/ok-shared-breakglass/network-policy-breakglass.yaml')

    expect(overlay).toContain('sha256:20860b2f87ffd9454c5925aba4fac83dc1c6f4787ec89b935fbcb76fc68600f3')
    expect(deployment).toContain('OK_CONSOLE_OIDC_ENABLED')
    expect(deployment).toContain('value: "true"')
    expect(deployment).toContain('value: breakglass')
    expect(deployment).toContain('https://keycloak.ok-shared.internal/realms/openkubes')
    expect(deployment).toContain('secretName: ok-console-oidc')
    expect(deployment).toContain('secretName: ok-console-oidc-ca')
    expect(deployment).toContain('NODE_EXTRA_CA_CERTS')
    expect(deployment).toContain('ip: 192.168.100.207')
    expect(deployment).toContain('keycloak.ok-shared.internal')
    expect(policy).toContain('kubernetes.io/metadata.name: ingress')
    expect(policy).toContain('kubernetes.io/metadata.name: kube-system')
    expect(policy).toContain('cidr: 192.168.100.207/32')
    expect(policy).toContain('port: 443')
  })

  it('renders a valid candidate manifest with the immutable image', async () => {
    const { stdout } = await exec('kubectl', ['kustomize', 'deploy/kubernetes/overlays/ok-shared-breakglass'])
    expect(stdout).toContain('image: ghcr.io/openkubes/ok-console@sha256:20860b2f87ffd9454c5925aba4fac83dc1c6f4787ec89b935fbcb76fc68600f3')
    expect(stdout).toContain('secretName: ok-console-oidc')
    expect(stdout).toContain('secretName: ok-console-oidc-ca')
  })
})
