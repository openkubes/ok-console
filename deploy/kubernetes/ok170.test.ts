// @vitest-environment node

import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8')

describe('OK-170 ok-shared preview invariants', () => {
  it('pins the accepted immutable candidate and keeps live dependencies disabled', async () => {
    const overlay = await read('./overlays/ok-shared-preview/kustomization.yaml')
    expect(overlay).toContain('digest: sha256:04e5541fe9af040b1ca330ce632a74b20fab58489619c16a41db9f8b2d28441d')
    expect(overlay).toContain('value: fixture')
    expect(overlay).toContain('value: disabled')
    expect(overlay).toContain('OK_CONSOLE_OIDC_ENABLED')
    expect(overlay).toContain('value: "false"')
    expect(overlay).toContain('path: /spec/template/spec/containers/0/volumeMounts')
    expect(overlay).toContain('path: /spec/template/spec/volumes')
    expect(overlay).not.toMatch(/REPLACE_|\.invalid/i)
  })

  it('owns an isolated restricted namespace and permits no external ingress', async () => {
    const namespace = JSON.parse(await read('./overlays/ok-shared-preview/namespace.json'))
    expect(namespace.metadata.name).toBe('openkubes-console')
    expect(namespace.metadata.labels['openkubes.io/managed-by']).toBe('ok-170')
    expect(namespace.metadata.labels['pod-security.kubernetes.io/enforce']).toBe('restricted')

    const ingress = JSON.parse(await read('./overlays/ok-shared-preview/network-policy-preview-ingress.json'))
    expect(ingress.spec.ingress[0].from).toEqual([{
      namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'openkubes-console' } },
    }])
    expect(ingress.spec.ingress[0].ports).toEqual([{ protocol: 'TCP', port: 8787 }])
  })

  it('requires exact context and explicit apply while verifying identity and security', async () => {
    const verifier = await read('./verify-ok-shared-preview.sh')
    expect(verifier).toContain('ok-shared-admin@ok-shared')
    expect(verifier).toContain('openkubes.io/managed-by=ok-170')
    expect(verifier).toContain('OK_CONSOLE_APPLY:-false')
    expect(verifier).toContain('kubectl apply --server-side --field-manager=ok-170-preview')
    expect(verifier).toContain('false true false ALL')
    expect(verifier).toContain('/health/live')
    expect(verifier).toContain('/health/ready')
    expect(verifier).not.toMatch(/kubectl delete|BEGIN PRIVATE KEY|client-secret/i)
  })
})
