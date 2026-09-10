// @vitest-environment node

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const exec = promisify(execFile)
const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8')

describe('bootstrap recovery profile', () => {
  it('pins rc.3 and fails closed to bootstrap with a new epoch', async () => {
    const overlay = await read('./overlays/ok-shared-bootstrap-recovery/kustomization.yaml')
    const patch = await read('./overlays/ok-shared-bootstrap-recovery/deployment-bootstrap-recovery.yaml')
    expect(overlay).toContain('sha256:705edc32be35c935d25414c790cc648649ab3aa3ace24f42423510e3a9e8ccbc')
    expect(patch).toContain('value: "false"')
    expect(patch).toContain('value: bootstrap')
    expect(patch).toContain('ok-shared-bootstrap-recovery-v1')
  })

  it('renders without unresolved placeholders', async () => {
    const { stdout } = await exec('kubectl', ['kustomize', 'deploy/kubernetes/overlays/ok-shared-bootstrap-recovery'])
    expect(stdout).toContain('OK_CONSOLE_LOCAL_ACCESS_MODE')
    expect(stdout).toContain('image: ghcr.io/openkubes/ok-console@sha256:705edc32be35c935d25414c790cc648649ab3aa3ace24f42423510e3a9e8ccbc')
    expect(stdout).not.toContain('REPLACE_DEPLOYMENT_EPOCH')
  }, 15_000)
})
