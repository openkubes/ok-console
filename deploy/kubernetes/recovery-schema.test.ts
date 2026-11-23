// @vitest-environment node
import { execFile } from 'node:child_process'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { recoveryTree, runRenderer, releasedEntry } from './fixtures/releasedRecovery'

const exec = promisify(execFile)
const sourceRoot = fileURLToPath(new URL('../../', import.meta.url))
type Row = Record<string, unknown>
const bootstrap = (r: Row) => r['ok-shared-bootstrap-recovery'] as Row
const breakglass = (r: Row) => r['ok-shared-breakglass'] as Row
const children = (r: Row) => bootstrap(r).platforms as Row
const provenance = (r: Row) => bootstrap(r).provenance as Row
const sentinel = (r: Row) => Object.assign(bootstrap(r), {
  image: `ghcr.io/openkubes/ok-console@sha256:${'0'.repeat(64)}`, platforms: {},
  provenance: { authMode: null, dataMode: null, releaseTag: null, revision: null },
})
const cases: [string, string, (r: Row) => void, string][] = [
  ['entries', 'absent bootstrap', r => { delete r['ok-shared-bootstrap-recovery'] }, 'must name exactly'],
  ['entries', 'extra overlay', r => { r.foreign = {} }, 'must name exactly'],
  ['entry-keys', 'null bootstrap', r => { r['ok-shared-bootstrap-recovery'] = null }, 'entry must have exactly'],
  ['entry-keys', 'extra digest key', r => { bootstrap(r).digest = 'sha256:' + 'a'.repeat(64) }, 'entry must have exactly'],
  ['entry-keys', 'stored state', r => { bootstrap(r).state = 'released' }, 'entry must have exactly'],
  ['entry-keys', 'provenance on breakglass', r => { breakglass(r).provenance = releasedEntry.provenance }, 'entry must have exactly'],
  ['image', 'numeric image', r => { bootstrap(r).image = 42 }, 'image must be'],
  ['image', 'numeric digest', r => { bootstrap(r).image = 'ghcr.io/openkubes/ok-console@42' }, 'image must be'],
  ['image', 'foreign repository', r => { bootstrap(r).image = releasedEntry.image.replace('openkubes', 'foreign') }, 'image must be'],
  ['platforms-type', 'platforms array', r => { bootstrap(r).platforms = [] }, 'object required'],
  ['platforms-type', 'null platforms', r => { bootstrap(r).platforms = null }, 'object required'],
  ['platforms-digest', 'numeric child', r => { children(r)['linux/amd64'] = 42 }, 'valid sha256 child digests'],
  ['platforms-sentinel', 'sentinel children', r => { sentinel(r); bootstrap(r).platforms = releasedEntry.platforms }, 'sentinel platforms must be {}'],
  ['zero-index', 'breakglass zero index', r => { breakglass(r).image = 'ghcr.io/openkubes/ok-console@sha256:' + '0'.repeat(64) }, 'breakglass index must not be the zero sentinel'],
  ['zero-child', 'bootstrap zero child', r => { children(r)['linux/amd64'] = 'sha256:' + '0'.repeat(64) }, 'platform child must not be the zero sentinel'],
  ['zero-child', 'breakglass zero child', r => { (breakglass(r).platforms as Row)['linux/amd64'] = 'sha256:' + '0'.repeat(64) }, 'platform child must not be the zero sentinel'],
  ['platforms-required', 'missing amd64', r => { delete children(r)['linux/amd64'] }, 'linux/amd64 (required)'],
  ['platforms-name', 'foreign platform', r => { children(r)['windows/amd64'] = 'sha256:' + '4'.repeat(64) }, 'only linux/amd64 or linux/arm64'],
  ['platforms-index', 'child equals index', r => { children(r)['linux/amd64'] = (bootstrap(r).image as string).split('@')[1] }, 'children different from the index'],
  ['platforms-distinct', 'duplicate children', r => { children(r)['linux/arm64'] = children(r)['linux/amd64'] }, 'distinct child digests'],
  ['provenance-keys', 'provenance string', r => { bootstrap(r).provenance = 'bootstrap' }, 'provenance keys must be exactly'],
  ['provenance-keys', 'extra provenance key', r => { provenance(r).state = 'released' }, 'provenance keys must be exactly'],
  ['sentinel-provenance', 'sentinel auth mode', r => { sentinel(r); provenance(r).authMode = 'bootstrap' }, 'values must all be null'],
  ['auth-mode', 'released breakglass mode', r => { provenance(r).authMode = 'breakglass' }, 'authMode must be bootstrap'],
  ['data-mode', 'released fixture mode', r => { provenance(r).dataMode = 'fixture' }, 'dataMode must be bff'],
  ['revision', 'null revision', r => { provenance(r).revision = null }, 'full 40-character'],
  ['revision', 'array revision', r => { provenance(r).revision = ['c'.repeat(40)] }, 'full 40-character'],
  ['release-tag', 'breakglass tag', r => { provenance(r).releaseTag = 'dev-breakglass-v1' }, 'releaseTag must be a dev-v*'],
  ['release-tag', 'array tag', r => { provenance(r).releaseTag = ['dev-v1'] }, 'releaseTag must be a dev-v*'],
  ['overlap', 'same index', r => { bootstrap(r).image = breakglass(r).image }, 'Bootstrap and break-glass index/child digests must not overlap.'],
  ['overlap', 'shared child', r => { children(r)['linux/amd64'] = (breakglass(r).platforms as Row)['linux/amd64'] }, 'Bootstrap and break-glass index/child digests must not overlap.'],
  ['overlap', 'bootstrap index to breakglass child', r => { bootstrap(r).image = 'ghcr.io/openkubes/ok-console@' + (breakglass(r).platforms as Row)['linux/amd64'] }, 'Bootstrap and break-glass index/child digests must not overlap.'],
  ['overlap', 'bootstrap child to breakglass index', r => { children(r)['linux/amd64'] = (breakglass(r).image as string).split('@')[1] }, 'Bootstrap and break-glass index/child digests must not overlap.'],
  ['sentinel-gate', 'unreleased sentinel', r => { sentinel(r) }, 'separately authorized bootstrap recovery image release step'],
]

describe('recovery schema negative matrix', () => {
  it.each(cases)('%s rejects %s before output', async (_guard, _name, mutate, reason) => {
    const root = await recoveryTree()
    try {
      const file = join(root, 'deploy/kubernetes/overlays/expected-digests.json')
      const record = JSON.parse(await readFile(file, 'utf8')) as Row
      mutate(record)
      await writeFile(file, JSON.stringify(record))
      // Keep the pin coordinated for schema-only mutations, so a stale pin cannot mask them.
      for (const name of ['ok-shared-bootstrap-recovery', 'ok-shared-breakglass']) {
        const image = (record[name] as Row | null)?.image
        if (typeof image === 'string' && /@sha256:[a-f0-9]{64}$/.test(image)) {
          const pin = join(root, 'deploy/kubernetes/overlays', name, 'kustomization.yaml')
          await writeFile(pin, (await readFile(pin, 'utf8')).replace(/digest: sha256:[a-f0-9]{64}/, `digest: ${image.split('@')[1]}`))
        }
      }
      const output = join(root, 'out')
      await expect(runRenderer(root, output)).rejects.toMatchObject({ stderr: expect.stringContaining(reason) })
      expect(await stat(output).then(() => true, () => false)).toBe(false)
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 60_000)

  it('sentinel-gate refuses tracked tree with an output argument and writes nothing', async () => {
    const root = await recoveryTree()
    try {
      const output = join(root, 'tracked-output')
      await expect(exec('node', ['deploy/kubernetes/render-ok-shared-recovery.mjs', output], { cwd: sourceRoot }))
        .rejects.toMatchObject({ stderr: expect.stringContaining('No bootstrap-built recovery image has been released') })
      expect(await stat(output).then(() => true, () => false)).toBe(false)
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 60_000)

  it('synthetic released fixture renders both images and bootstrap provenance', async () => {
    const root = await recoveryTree()
    try {
      const output = join(root, 'out')
      await runRenderer(root, output)
      const evidence = JSON.parse(await readFile(join(output, 'recovery-evidence.json'), 'utf8'))
      expect(evidence.imageDigests.bootstrap).toMatchObject(releasedEntry)
      expect(evidence.imageDigests.postRecovery).not.toHaveProperty('provenance')
      expect(await readFile(join(output, 'bootstrap.yaml'), 'utf8')).toContain(releasedEntry.image)
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 60_000)

  it.each([[], ['--provenance', 'x', 'out'], ['--bogus'], ['a', 'b']])('rejects unsupported renderer arguments %j', async (...args) => {
    await expect(exec('node', ['deploy/kubernetes/render-ok-shared-recovery.mjs', ...args]))
      .rejects.toMatchObject({ code: 2 })
  })
})
