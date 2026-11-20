// @vitest-environment node

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const exec = promisify(execFile)
const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8')
import expectedDigests from './overlays/expected-digests.json'

const digest = expectedDigests['ok-shared-breakglass'].image.split('@')[1]
const bootstrapDigest = expectedDigests['ok-shared-bootstrap-recovery'].image.split('@')[1]
const envValue = (manifest: string, name: string) => {
  const match = manifest.match(new RegExp(`- name: ${name}\\n\\s+value: ([^\\s]+)`))
  if (!match) throw new Error(`${name} is missing from the rendered Deployment.`)
  return match[1]
}

const generate = async () => {
  const parent = await mkdtemp(join(tmpdir(), 'ok-console-recovery-test-'))
  const output = join(parent, 'generated')
  await exec('node', ['deploy/kubernetes/render-ok-shared-recovery.mjs', output])
  return {
    parent,
    bootstrap: await readFile(join(output, 'bootstrap.yaml'), 'utf8'),
    restored: await readFile(join(output, 'post-recovery.yaml'), 'utf8'),
    evidence: JSON.parse(await readFile(join(output, 'recovery-evidence.json'), 'utf8')) as Record<string, unknown>,
  }
}

describe('bootstrap recovery profile', () => {
  it('keeps single-use identifiers unresolved in both checked-in templates', async () => {
    const bootstrapOverlay = await read('./overlays/ok-shared-bootstrap-recovery/kustomization.yaml')
    const bootstrapPatch = await read('./overlays/ok-shared-bootstrap-recovery/deployment-bootstrap-recovery.yaml')
    const restoredPatch = await read('./overlays/ok-shared-breakglass/deployment-breakglass.yaml')

    expect(bootstrapOverlay).toContain(bootstrapDigest)
    expect(bootstrapPatch).toContain('value: "false"')
    expect(bootstrapPatch).toContain('value: bootstrap')
    expect(bootstrapPatch).toContain('REPLACE_BOOTSTRAP_RECOVERY_EPOCH')
    expect(bootstrapPatch).toContain('REPLACE_BOOTSTRAP_AUTHORIZATION_REVISION')
    expect(restoredPatch).toContain('REPLACE_POST_RECOVERY_EPOCH')
    expect(restoredPatch).toContain('REPLACE_POST_RECOVERY_AUTHORIZATION_REVISION')
  })

  it('refuses to overwrite an existing recovery bundle', async () => {
    const generated = await generate()
    try {
      const output = join(generated.parent, 'generated')
      await expect(exec('node', ['deploy/kubernetes/render-ok-shared-recovery.mjs', output]))
        .rejects.toMatchObject({ code: 1 })
    } finally {
      await rm(generated.parent, { recursive: true, force: true })
    }
  }, 15_000)

  it('generates distinct single-use identifiers on every render', async () => {
    const first = await generate()
    const second = await generate()
    try {
      const firstValues = [
        envValue(first.bootstrap, 'OK_CONSOLE_SESSION_EPOCH'),
        envValue(first.bootstrap, 'OK_CONSOLE_AUTHORIZATION_REVISION'),
        envValue(first.restored, 'OK_CONSOLE_SESSION_EPOCH'),
        envValue(first.restored, 'OK_CONSOLE_AUTHORIZATION_REVISION'),
      ]
      const secondValues = [
        envValue(second.bootstrap, 'OK_CONSOLE_SESSION_EPOCH'),
        envValue(second.bootstrap, 'OK_CONSOLE_AUTHORIZATION_REVISION'),
        envValue(second.restored, 'OK_CONSOLE_SESSION_EPOCH'),
        envValue(second.restored, 'OK_CONSOLE_AUTHORIZATION_REVISION'),
      ]

      expect(new Set(firstValues).size).toBe(4)
      expect(new Set([...firstValues, ...secondValues]).size).toBe(8)
      expect(first.bootstrap).toContain(`image: ghcr.io/openkubes/ok-console@${bootstrapDigest}`)
      expect(first.restored).toContain(`image: ghcr.io/openkubes/ok-console@${digest}`)
      expect(`${first.bootstrap}${first.restored}`).not.toMatch(/REPLACE_(?:BOOTSTRAP|POST_RECOVERY)_/)
      expect(first.evidence).toMatchObject({ singleUse: true, imageDigests: {
        bootstrap: { overlay: 'ok-shared-bootstrap-recovery', image: expectedDigests['ok-shared-bootstrap-recovery'].image, platforms: expectedDigests['ok-shared-bootstrap-recovery'].platforms },
        postRecovery: { overlay: 'ok-shared-breakglass', image: expectedDigests['ok-shared-breakglass'].image, platforms: expectedDigests['ok-shared-breakglass'].platforms },
      } })
      expect(first.evidence).not.toHaveProperty('imageDigest')
    } finally {
      await Promise.all([
        rm(first.parent, { recursive: true, force: true }),
        rm(second.parent, { recursive: true, force: true }),
      ])
    }
  }, 30_000)
})
