// @vitest-environment node
import { execFile } from 'node:child_process'
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { recoveryTree, releasedEntry, releasedProvenance as released } from './fixtures/releasedRecovery'
const exec = promisify(execFile)
const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8')

describe('OK-173 recovery image verifier', () => {
  const script = 'deploy/kubernetes/verify-recovery-image.sh'
  it('is valid bash and rejects bad usage before touching Docker', async () => {
    await exec('bash', ['-n', script])
    for (const args of [[], ['publish', 'x'], ['local'], ['registry'], ['registry', releasedEntry.image, 'override.json'], ['registry', 'ghcr.io/openkubes/ok-console:dev-v1'], ['registry', 'ghcr.io/openkubes/ok-console@sha256:705edc32']]) {
      await expect(exec('bash', [script, ...args]), args.join(' ')).rejects.toMatchObject({ code: 2 })
    }
  })

  // Registry mode against stubbed docker/gh: the release check reads only their output.
  const labels = { 'io.openkubes.console.auth-mode': 'bootstrap', 'io.openkubes.console.data-mode': 'bff', 'org.opencontainers.image.revision': released.revision }
  const metadataFor = (overrides = {}) => ({ 'linux/amd64': { config: { Labels: labels } }, 'linux/arm64': { config: { Labels: { ...labels, ...overrides } } } })
  const indexFor = () => ({ mediaType: 'application/vnd.oci.image.index.v1+json', manifests: Object.entries(releasedEntry.platforms).map(([platform, digest]) => {
    const [os, architecture] = platform.split('/')
    return { digest, platform: { os, architecture } }
  }) })
  const wrongIndex = (kind: string) => {
    const index = indexFor()
    if (kind === 'wrong') index.manifests[0].digest = `sha256:${'3'.repeat(64)}`
    if (kind === 'missing') index.manifests.pop()
    if (kind === 'extra') index.manifests.push({ digest: `sha256:${'3'.repeat(64)}`, platform: { os: 'linux', architecture: 's390x' } })
    if (kind === 'duplicate') index.manifests.push(index.manifests[0])
    return index
  }
  const attestationFor = ({ ref = `refs/tags/${released.releaseTag}`, commit = released.revision, repository = 'https://github.com/openkubes/ok-console' } = {}) => [{
    verificationResult: { statement: { predicate: { buildDefinition: {
      externalParameters: { workflow: { repository, ref } },
      resolvedDependencies: [{ uri: 'git+https://github.com/openkubes/ok-console', digest: { gitCommit: commit } }],
    } } } },
  }]
  const reference = releasedEntry.image
  const runRegistry = async ({ index = indexFor() as unknown, metadata = metadataFor() as unknown, attestation = attestationFor() as unknown, ghFails = false, ref = reference, stage = 'released' } = {}) => {
    const dir = await mkdtemp(join(tmpdir(), 'ok-console-registry-verify-'))
    try {
      await mkdir(join(dir, 'bin'))
      await writeFile(join(dir, 'index.json'), JSON.stringify(index))
      await writeFile(join(dir, 'metadata.json'), JSON.stringify(metadata))
      await writeFile(join(dir, 'attestation.json'), JSON.stringify(attestation))
      const staged = await recoveryTree()
      await cp(join(staged, 'deploy'), join(dir, 'deploy'), { recursive: true })
      await rm(staged, { recursive: true, force: true })
      if (stage === 'sentinel') {
        for (const file of ['overlays/expected-digests.json', 'overlays/ok-shared-bootstrap-recovery/kustomization.yaml']) {
          await writeFile(join(dir, 'deploy/kubernetes', file), await read('./' + file))
        }
      } else if (stage === 'overlap') {
        const file = join(dir, 'deploy/kubernetes/overlays/expected-digests.json')
        const record = JSON.parse(await readFile(file, 'utf8'))
        record['ok-shared-bootstrap-recovery'].platforms['linux/amd64'] = record['ok-shared-breakglass'].platforms['linux/amd64']
        await writeFile(file, JSON.stringify(record))
      } else if (stage === 'stale') {
        await writeFile(join(dir, 'deploy/kubernetes/overlays/ok-shared-bootstrap-recovery/kustomization.yaml'), await read('./overlays/ok-shared-bootstrap-recovery/kustomization.yaml'))
      }
      await writeFile(join(dir, 'bin', 'docker'), `#!/bin/sh\ncase "$*" in *--raw*) cat '${join(dir, 'index.json')}' ;; *) cat '${join(dir, 'metadata.json')}' ;; esac\n`)
      await writeFile(join(dir, 'bin', 'gh'), ghFails ? '#!/bin/sh\nexit 1\n' : `#!/bin/sh\ncat '${join(dir, 'attestation.json')}'\n`)
      await chmod(join(dir, 'bin', 'docker'), 0o755)
      await chmod(join(dir, 'bin', 'gh'), 0o755)
      return await exec('bash', [join(dir, script), 'registry', ref], { env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` } })
        .then((r) => ({ code: 0, out: r.stdout + r.stderr }), (e) => ({ code: e.code, out: String(e.stdout) + String(e.stderr) }))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  it('passes registry mode only for an attested bootstrap release matching the record', async () => {
    expect(await runRegistry()).toMatchObject({ code: 0, out: expect.stringContaining('PASS: linux/amd64, linux/arm64') })
  }, 60_000)

  it.each([
    ['registry-index rejects single manifest', { index: { mediaType: 'application/vnd.oci.image.manifest.v1+json' } }, 'index must be a manifest list'],
    ['registry-map rejects wrong child', { index: wrongIndex('wrong') }, 'index platform map does not equal'],
    ['registry-map rejects missing platform', { index: wrongIndex('missing') }, 'index platform map does not equal'],
    ['registry-map rejects extra platform', { index: wrongIndex('extra') }, 'index platform map does not equal'],
    ['registry-duplicate rejects duplicate platform', { index: wrongIndex('duplicate') }, 'duplicate runnable index platform'],
    ['registry-configs rejects missing configuration', { metadata: { 'linux/amd64': metadataFor()['linux/amd64'] } }, 'configuration platforms do not equal'],
    ['an unreleased staged tree', { stage: 'sentinel' }, 'No bootstrap-built recovery image has been released'],
    ['overlapping staged digests', { stage: 'overlap' }, 'must not overlap'],
    ['a stale staged pin', { stage: 'stale' }, 'does not pin the image'],
    ['a break-glass platform', { metadata: metadataFor({ 'io.openkubes.console.auth-mode': 'breakglass' }) }, 'auth-mode label is breakglass'],
    ['a fixture data mode', { metadata: metadataFor({ 'io.openkubes.console.data-mode': 'fixture' }) }, 'data-mode label'],
    ['another revision label', { metadata: metadataFor({ 'org.opencontainers.image.revision': 'd'.repeat(40) }) }, 'revision label does not match'],
    ['no platform configuration', { metadata: {} }, 'configuration platforms do not equal'],
    ['an attestation for another tag', { attestation: attestationFor({ ref: 'refs/tags/dev-breakglass-v0.1.0-rc.3' }) }, 'no attestation binds'],
    ['an attestation for another commit', { attestation: attestationFor({ commit: 'd'.repeat(40) }) }, 'no attestation binds'],
    ['an attestation from another repository', { attestation: attestationFor({ repository: 'https://github.com/example/ok-console' }) }, 'no attestation binds'],
    ['no attestation', { attestation: [] }, 'no attestation binds'],
    ['a failed attestation verification', { ghFails: true }, 'no valid publish-dev-image build-provenance attestation'],
    ['a reference to another digest', { ref: `ghcr.io/openkubes/ok-console@sha256:${'cd'.repeat(32)}` }, 'does not match the provenance'],
  ])('fails registry mode for %s', async (_case, options, message) => {
    const result = await runRegistry(options)
    expect(result.code).toBe(1)
    expect(result.out).toContain(message)
  }, 60_000)

  const descriptorFor = (os: string, architecture: string, annotated = true) => ({
    digest: `sha256:${'4'.repeat(64)}`, platform: { os, architecture },
    ...(annotated ? { annotations: { 'vnd.docker.reference.type': 'attestation-manifest' } } : {}),
  })
  it.each([
    ['linux', 'arm64', true],
    ['linux', 's390x', true],
    ['linux', 'unknown', true],
    ['unknown', 'arm64', true],
    ['unknown', 'unknown', false],
  ] as const)('registry-attestation rejects counting exemption for %s/%s annotated=%s', async (os, architecture, annotated) => {
    const index = indexFor()
    index.manifests.push(descriptorFor(os, architecture, annotated))
    expect(await runRegistry({ index })).toMatchObject({
      code: 1, out: expect.stringContaining(architecture === 'arm64' && os === 'linux'
        ? 'duplicate runnable index platform' : 'index platform map does not equal'),
    })
  }, 60_000)

  it('registry-attestation excludes only annotated unknown/unknown', async () => {
    const index = indexFor()
    index.manifests.push(descriptorFor('unknown', 'unknown'))
    expect(await runRegistry({ index })).toMatchObject({ code: 0, out: expect.stringContaining('PASS:') })
  }, 60_000)

  it('asserts the bootstrap label, never pushes and never tags for a registry', async () => {
    const source = await read('./verify-recovery-image.sh')
    expect(source).toContain('EXPECTED_AUTH_MODE=bootstrap')
    expect(source).toContain('io.openkubes.console.auth-mode')
    expect(source).toContain('--no-cache')
    expect(source).not.toMatch(/\bdocker\s+(?:push|login|tag)\b|--push\b|push=true/)
  })
})


it('keeps dev-v releases mapped to bootstrap builds', async () => {
  const workflow = await read('../../.github/workflows/publish-dev-image.yaml')
  expect(workflow).toContain("AUTH_MODE: ${{ startsWith(github.ref_name, 'dev-breakglass-v') && 'breakglass' || 'bootstrap' }}")
  expect(workflow).toContain('VITE_CONSOLE_AUTH_MODE=${{ env.AUTH_MODE }}')
})


// Exercise the exact shared-record helper without invoking local mode's git/build steps.
const recordHelper = async (root: string, mode: string, requested: string) => {
  const source = await read('./verify-recovery-image.sh')
  const helper = source.slice(source.indexOf('recovery_record() {'), source.indexOf('verify_local() {'))
  return exec('bash', ['-c', `set -Eeuo pipefail
repo_root=$1
script_dir=$1/deploy/kubernetes
${helper}
recovery_record "$2" "$3"`, 'record-helper', root, mode, requested])
}
it('verifier-local-revision rejects a released record for another requested commit', async () => {
  const root = await recoveryTree()
  try {
    await expect(recordHelper(root, 'local', 'd'.repeat(40)))
      .rejects.toMatchObject({ stderr: expect.stringContaining('requested commit does not match') })
    expect((await recordHelper(root, 'local', 'c'.repeat(40))).stdout).toBe('bootstrap bff\n')
  } finally { await rm(root, { recursive: true, force: true }) }
}, 60_000)
it('local sentinel expectations stay bootstrap bff with null provenance', async () => {
  const root = await recoveryTree()
  try {
    for (const file of ['overlays/expected-digests.json', 'overlays/ok-shared-bootstrap-recovery/kustomization.yaml']) {
      await writeFile(join(root, 'deploy/kubernetes', file), await read('./' + file))
    }
    expect((await recordHelper(root, 'local', 'd'.repeat(40))).stdout).toBe('bootstrap bff\n')
  } finally { await rm(root, { recursive: true, force: true }) }
}, 60_000)
