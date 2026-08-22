// @vitest-environment node

import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8')

describe('OK-169 development candidate invariants', () => {
  it('publishes only trusted dev tags with bounded authority and pinned actions', async () => {
    const workflow = await read('../../.github/workflows/publish-dev-image.yaml')
    expect(workflow).toContain("tags:\n      - 'dev-v*'")
    expect(workflow).not.toMatch(/pull_request:|workflow_dispatch:/)
    expect(workflow).toContain('packages: write')
    expect(workflow).toContain('id-token: write')
    expect(workflow).toContain('attestations: write')
    expect(workflow).not.toContain('contents: write')
    expect(workflow).toContain('git merge-base --is-ancestor "${GITHUB_SHA}" origin/main')
    expect(workflow).toContain('${{ env.IMAGE_NAME }}@${{ steps.build.outputs.digest }}')
    expect(workflow).toContain('severity: CRITICAL,HIGH')
    expect(workflow).toContain('cosign verify')
    for (const action of workflow.matchAll(/uses: ([^\s#]+)/g)) {
      expect(action[1]).toMatch(/@[a-f0-9]{40}$/)
    }
  })

  it('keeps the local overlay isolated, read-only and credential-free', async () => {
    const overlay = await read('./overlays/local-kind/kustomization.yaml')
    expect(overlay).toContain('- ../../base')
    expect(overlay).toContain('value: fixture')
    expect(overlay).toContain('value: disabled')
    expect(overlay).toContain('path: /spec/template/spec/containers/0/volumeMounts')
    expect(overlay).toContain('path: /spec/template/spec/volumes')
    expect(overlay).not.toMatch(/postgres|client-secret|tls\.key|REPLACE_|\.invalid/i)

    const namespace = JSON.parse(await read('./overlays/local-kind/namespace.json'))
    expect(namespace.metadata.labels['pod-security.kubernetes.io/enforce']).toBe('restricted')
    const ingress = JSON.parse(await read('./overlays/local-kind/network-policy-local-ingress.json'))
    expect(ingress.spec.ingress[0].ports).toEqual([{ protocol: 'TCP', port: 8787 }])
  })

  it('requires immutable GHCR references and verifies the deployed identity', async () => {
    const verifier = await read('./verify-local-kind.sh')
    expect(verifier).toContain('GHCR candidates must be selected by immutable sha256 digest.')
    expect(verifier).toContain('org.opencontainers.image.revision')
    expect(verifier).toContain('does not match expected revision')
    expect(verifier).toContain('dirty worktree')
    expect(verifier).toContain('if [[ "${candidate_image}" != ghcr.io/* ]]')
    expect(verifier).toContain('refusing to modify an unowned cluster')
    expect(verifier).toContain("[[ \"${deployed_image}\" == \"${candidate_image}\" ]]")
    expect(verifier).toContain("[[ \"${runtime_security}\" == 'false true true false ALL' ]]")
    expect(verifier).toContain('rollout restart deployment/ok-console')
    expect(verifier).toContain('/health/live')
    expect(verifier).toContain('/health/ready')
    expect(verifier).toContain('sha256:0{64}')
    expect(verifier).toContain('secretName:')
  })
})
