// @vitest-environment node

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { BREAKGLASS_DIGEST, UNRELEASED_DIGEST, checkRecoveryProvenance, consoleImageReferences } from './recovery-image.mjs'
import { recoveryTree, releasedProvenance as released, runRenderer } from './fixtures/releasedRecovery'

// OK-173: the bootstrap-only recovery overlay may run only a bootstrap-built image, referenced by
// an immutable digest recorded with its provenance. Until a release publishes one, the overlay
// carries an explicit sentinel and the renderer refuses to produce a recovery bundle.
const exec = promisify(execFile)
const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8')
const overlayDigest = (kustomization: string) => kustomization.match(/^\s+digest:\s*(\S+)\s*$/m)?.[1]
const checkedIn = checkRecoveryProvenance(JSON.parse(readFileSync(new URL('./overlays/ok-shared-bootstrap-recovery/image-provenance.json', import.meta.url), 'utf8')))
const unreleased = { ...released, releaseTag: null, revision: null, digest: UNRELEASED_DIGEST }

describe('OK-173 bootstrap recovery image reference', () => {
  it('keeps the overlay digest and the provenance record consistent and never on the break-glass build', async () => {
    const recovery = overlayDigest(await read('./overlays/ok-shared-bootstrap-recovery/kustomization.yaml'))
    const breakglass = overlayDigest(await read('./overlays/ok-shared-breakglass/kustomization.yaml'))
    const provenance = JSON.parse(await read('./overlays/ok-shared-bootstrap-recovery/image-provenance.json'))
    const checked = checkRecoveryProvenance(provenance)

    expect(breakglass).toBe(BREAKGLASS_DIGEST)
    expect(recovery).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(recovery).not.toBe(breakglass)
    expect(recovery).toBe(provenance.digest)
    expect(checked.errors).toEqual([])
    expect(['released', 'unreleased']).toContain(checked.state)
  })

  it('accepts exactly the released and unreleased shapes', () => {
    expect(checkRecoveryProvenance(released)).toEqual({ state: 'released', errors: [] })
    expect(checkRecoveryProvenance(unreleased)).toEqual({ state: 'unreleased', errors: [] })
  })

  it.each([
    ['absent', undefined],
    ['null', null],
    ['an array', [released]],
    ['a missing key', Object.fromEntries(Object.entries(released).filter(([key]) => key !== 'releaseTag'))],
    ['an extra key', { ...released, signedBy: 'someone' }],
    ['the break-glass mode', { ...released, authMode: 'breakglass' }],
    ['the prototype mode', { ...released, authMode: 'prototype' }],
    ['the fixture data mode', { ...released, dataMode: 'fixture' }],
    ['another repository', { ...released, image: 'ghcr.io/example/ok-console' }],
    ['the break-glass digest', { ...released, digest: BREAKGLASS_DIGEST }],
    ['a truncated digest', { ...released, digest: 'sha256:705edc32' }],
    ['a tag instead of a digest', { ...released, digest: 'dev-v0.1.0-rc.9' }],
    ['an upper-case digest', { ...released, digest: `sha256:${'AB'.repeat(32)}` }],
    ['a numeric digest', { ...released, digest: 42 }],
    ['a short revision', { ...released, revision: 'f653fcf' }],
    ['a null revision with a released digest', { ...released, revision: null }],
    ['a break-glass release tag', { ...released, releaseTag: 'dev-breakglass-v0.1.0-rc.3' }],
    ['a non-release tag', { ...released, releaseTag: 'latest' }],
    ['the sentinel with a revision', { ...unreleased, revision: 'c'.repeat(40) }],
    ['the sentinel with a release tag', { ...unreleased, releaseTag: 'dev-v0.1.0-rc.9' }],
    ['a released digest without revision or tag', { ...unreleased, digest: released.digest }],
    ['an unreleased record in the break-glass mode', { ...unreleased, authMode: 'breakglass' }],
  ])('rejects %s', (_case, provenance) => {
    const checked = checkRecoveryProvenance(provenance)
    expect(checked.state).toBe('invalid')
    expect(checked.errors.length).toBeGreaterThan(0)
  })

  it('finds every Console image reference, including tags', () => {
    expect(consoleImageReferences([
      'image: ghcr.io/openkubes/ok-console@sha256:' + 'a'.repeat(64),
      '  - image: "ghcr.io/openkubes/ok-console:dev-v1"',
      'image: ghcr.io/openkubes/ok-console',
      'image: ghcr.io/openkubes/other@sha256:' + 'a'.repeat(64),
      'imageName: ghcr.io/openkubes/ok-console:dev-v1',
    ].join('\n'))).toEqual(['ghcr.io/openkubes/ok-console@sha256:' + 'a'.repeat(64), 'ghcr.io/openkubes/ok-console:dev-v1', 'ghcr.io/openkubes/ok-console'])
  })

  it('publishes dev-v* tags as bootstrap builds and dev-breakglass-v* tags as break-glass builds', async () => {
    const workflow = await read('../../.github/workflows/publish-dev-image.yaml')
    expect(workflow).toContain("AUTH_MODE: ${{ startsWith(github.ref_name, 'dev-breakglass-v') && 'breakglass' || 'bootstrap' }}")
    expect(workflow).toContain('VITE_CONSOLE_AUTH_MODE=${{ env.AUTH_MODE }}')
    expect(workflow).toMatch(/tags:\n\s+- 'dev-v\*'\n\s+- 'dev-breakglass-v\*'/)
  })
})

describe('OK-173 recovery bundle renderer', () => {
  const renderTree = async (options: Parameters<typeof recoveryTree>[0]) => {
    const root = await recoveryTree(options)
    const output = join(root, 'generated')
    try {
      const result = await runRenderer(root, output)
        .then(() => ({ code: 0, stderr: '' }), (error) => ({ code: error.code, stderr: String(error.stderr) }))
      const written = await stat(output).then(() => true, () => false)
      const bootstrap = written ? await readFile(join(output, 'bootstrap.yaml'), 'utf8').catch(() => '') : ''
      return { ...result, written, bootstrap }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  it.skipIf(checkedIn.state !== 'unreleased')('refuses the checked-in record until a bootstrap build is released', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'ok-console-recovery-image-test-'))
    try {
      const output = join(parent, 'generated')
      await expect(exec('node', ['deploy/kubernetes/render-ok-shared-recovery.mjs', output]))
        .rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('No bootstrap-built recovery image has been released') })
      expect(await stat(output).then(() => true, () => false)).toBe(false)
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  }, 60_000)

  it.each([
    ['an unreleased record', { provenance: unreleased, overlayDigest: UNRELEASED_DIGEST }, 'No bootstrap-built recovery image has been released', 2],
    ['a released record the overlay does not pin', { overlayDigest: UNRELEASED_DIGEST }, 'does not reference the expected Console digest', 1],
    ['an overlay pinning another digest', { overlayDigest: `sha256:${'cd'.repeat(32)}` }, 'does not reference the expected Console digest', 1],
    ['an overlay pinning the break-glass build', { overlayDigest: BREAKGLASS_DIGEST }, 'does not reference the expected Console digest', 1],
    ['a record naming the break-glass build', { provenance: { ...released, digest: BREAKGLASS_DIGEST }, overlayDigest: BREAKGLASS_DIGEST }, 'break-glass build', 2],
    ['a record in the break-glass mode', { provenance: { ...released, authMode: 'breakglass' } }, 'authMode must be bootstrap', 2],
    ['malformed JSON', { provenance: '{' }, 'Cannot read the recovery image provenance', 2],
  ])('refuses %s and writes nothing', async (_case, options, message, code) => {
    const result = await renderTree(options)
    expect(result.code).toBe(code)
    expect(result.stderr).toContain(message)
    expect(result.written).toBe(false)
  }, 60_000)

  it('renders the bootstrap bundle with the recorded and pinned bootstrap digest only', async () => {
    const result = await renderTree({})
    expect(result.code).toBe(0)
    expect(consoleImageReferences(result.bootstrap)).toEqual([`ghcr.io/openkubes/ok-console@${released.digest}`])
  }, 60_000)

  it.each([[[]], [['--provenance', 'x', 'out']], [['--bogus']], [['a', 'b']]])('rejects the usage %j', async (args) => {
    await expect(exec('node', ['deploy/kubernetes/render-ok-shared-recovery.mjs', ...args]))
      .rejects.toMatchObject({ code: 2 })
  })
})

describe('OK-173 recovery image verifier', () => {
  const script = 'deploy/kubernetes/verify-recovery-image.sh'
  it('is valid bash and rejects bad usage before touching Docker', async () => {
    await exec('bash', ['-n', script])
    for (const args of [[], ['publish', 'x'], ['local'], ['registry'], ['registry', 'ghcr.io/openkubes/ok-console:dev-v1'], ['registry', 'ghcr.io/openkubes/ok-console@sha256:705edc32']]) {
      await expect(exec('bash', [script, ...args]), args.join(' ')).rejects.toMatchObject({ code: 2 })
    }
  })

  it('asserts the bootstrap label, never pushes and never tags for a registry', async () => {
    const source = await read('./verify-recovery-image.sh')
    expect(source).toContain('EXPECTED_AUTH_MODE=bootstrap')
    expect(source).toContain('io.openkubes.console.auth-mode')
    expect(source).toContain('--no-cache')
    expect(source).not.toMatch(/\bdocker\s+(?:push|login|tag)\b|--push\b|push=true/)
  })
})
