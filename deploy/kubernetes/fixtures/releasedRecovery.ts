import { execFile } from 'node:child_process'
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const kubernetesDir = fileURLToPath(new URL('../', import.meta.url))
export const renderer = join(kubernetesDir, 'render-ok-shared-recovery.mjs')
// Synthetic offline identity only; never a publication or registry reference.
export const releasedProvenance = {
  authMode: 'bootstrap', dataMode: 'bff', releaseTag: 'dev-v0.1.0-rc.9', revision: 'c'.repeat(40),
}
export const releasedEntry = {
  image: `ghcr.io/openkubes/ok-console@sha256:${'ab'.repeat(32)}`,
  platforms: { 'linux/amd64': `sha256:${'1'.repeat(64)}`, 'linux/arm64': `sha256:${'2'.repeat(64)}` },
  provenance: releasedProvenance,
}
export const releaseRecord = (record: Record<string, unknown>) => ({ ...record, 'ok-shared-bootstrap-recovery': structuredClone(releasedEntry) })

/** Stage a coordinated synthetic release on a temporary tree, never an override. */
export const recoveryTree = async () => {
  const root = await mkdtemp(join(tmpdir(), 'ok-console-recovery-tree-'))
  const target = join(root, 'deploy', 'kubernetes')
  for (const path of ['base', 'overlays', 'recovery-image.mjs', 'render-ok-shared-recovery.mjs', 'verify-recovery-image.sh']) {
    await cp(join(kubernetesDir, path), join(target, path), { recursive: true })
  }
  const file = join(target, 'overlays', 'expected-digests.json')
  await writeFile(file, JSON.stringify(releaseRecord(JSON.parse(await readFile(file, 'utf8')))))
  const pin = join(target, 'overlays', 'ok-shared-bootstrap-recovery', 'kustomization.yaml')
  await writeFile(pin, (await readFile(pin, 'utf8')).replace(/digest: sha256:[a-f0-9]{64}/, `digest: ${releasedEntry.image.split('@')[1]}`))
  return root
}
export const runRenderer = (root: string, output: string) => exec('node', [join(root, 'deploy/kubernetes/render-ok-shared-recovery.mjs'), output], { cwd: root })
