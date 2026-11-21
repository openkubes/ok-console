import { execFile } from 'node:child_process'
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

// OK-173 test fixture: a temporary copy of deploy/kubernetes/{base,overlays} in which the
// bootstrap-recovery overlay and its image-provenance.json record a released bootstrap build,
// as a reviewed release change would. The renderer runs against that copy, never with an override.
const exec = promisify(execFile)
const kubernetesDir = fileURLToPath(new URL('../', import.meta.url))
export const renderer = join(kubernetesDir, 'render-ok-shared-recovery.mjs')
const UNRELEASED = `sha256:${'0'.repeat(64)}`

export const releasedProvenance = {
  image: 'ghcr.io/openkubes/ok-console',
  authMode: 'bootstrap',
  dataMode: 'bff',
  releaseTag: 'dev-v0.1.0-rc.9',
  revision: 'c'.repeat(40),
  digest: `sha256:${'ab'.repeat(32)}`,
}

/** Copies the overlays into a temp root; `provenance` and `overlayDigest` default to a consistent release. */
export const recoveryTree = async ({ provenance = releasedProvenance as unknown, overlayDigest = releasedProvenance.digest } = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'ok-console-recovery-tree-'))
  const target = join(root, 'deploy', 'kubernetes')
  await cp(join(kubernetesDir, 'base'), join(target, 'base'), { recursive: true })
  await cp(join(kubernetesDir, 'overlays'), join(target, 'overlays'), { recursive: true })
  const recovery = join(target, 'overlays', 'ok-shared-bootstrap-recovery')
  const kustomization = await readFile(join(recovery, 'kustomization.yaml'), 'utf8')
  if (!kustomization.includes(`digest: ${UNRELEASED}`)) throw new Error('fixture expects the unreleased overlay sentinel')
  await writeFile(join(recovery, 'kustomization.yaml'), kustomization.replace(`digest: ${UNRELEASED}`, `digest: ${overlayDigest}`))
  await writeFile(join(recovery, 'image-provenance.json'), typeof provenance === 'string' ? provenance : JSON.stringify(provenance))
  return root
}

export const runRenderer = (root: string, output: string) => exec('node', [renderer, output], { cwd: root })
