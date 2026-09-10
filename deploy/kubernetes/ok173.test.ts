// @vitest-environment node

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const exec = promisify(execFile)
const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8')
const digest = 'sha256:705edc32be35c935d25414c790cc648649ab3aa3ace24f42423510e3a9e8ccbc'

const generatedRecovery = async () => {
  const parent = await mkdtemp(join(tmpdir(), 'ok-console-recovery-test-'))
  const output = join(parent, 'generated')
  await exec('node', ['deploy/kubernetes/render-ok-shared-recovery.mjs', output])
  return {
    parent,
    restored: await readFile(join(output, 'post-recovery.yaml'), 'utf8'),
  }
}

describe('OK-173 break-glass deployment candidate', () => {
  it('pins the reviewed image and keeps recovery identifiers unresolved in the template', async () => {
    const overlay = await read('./overlays/ok-shared-breakglass/kustomization.yaml')
    const deployment = await read('./overlays/ok-shared-breakglass/deployment-breakglass.yaml')
    const policy = await read('./overlays/ok-shared-breakglass/network-policy-breakglass.yaml')

    expect(overlay).toContain(digest)
    expect(deployment).toContain('REPLACE_POST_RECOVERY_EPOCH')
    expect(deployment).toContain('REPLACE_POST_RECOVERY_AUTHORIZATION_REVISION')
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

  it('generates a server-valid post-recovery manifest with fresh identifiers', async () => {
    const generated = await generatedRecovery()
    try {
      expect(generated.restored).toContain(`image: ghcr.io/openkubes/ok-console@${digest}`)
      expect(generated.restored).toContain('secretName: ok-console-oidc')
      expect(generated.restored).toContain('secretName: ok-console-oidc-ca')
      expect(generated.restored).toMatch(/value: ok-shared-post-recovery-[0-9a-f-]{36}/)
      expect(generated.restored).toMatch(/value: ok-shared-breakglass-[0-9a-f-]{36}/)
      expect(generated.restored).not.toMatch(/REPLACE_(?:BOOTSTRAP|POST_RECOVERY)_/)
    } finally {
      await rm(generated.parent, { recursive: true, force: true })
    }
  }, 15_000)
})
