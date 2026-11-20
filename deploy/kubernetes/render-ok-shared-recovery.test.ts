// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Each case renders two overlays with kubectl in a scratch copy of deploy/kubernetes.
vi.setConfig({ testTimeout: 60_000 })

const source = fileURLToPath(new URL('.', import.meta.url))
const file = 'deploy/kubernetes/overlays/expected-digests.json'
const index = (c: string) => `sha256:${c.repeat(64)}`
const amd64 = index('1'); const arm64 = index('2')
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function tree() {
  const root = mkdtempSync(join(tmpdir(), 'ok170-recovery-digests-')); dirs.push(root)
  cpSync(source, join(root, 'deploy/kubernetes'), { recursive: true })
  return root
}
const original = () => JSON.parse(readFileSync(join(source, 'overlays/expected-digests.json'), 'utf8')) as Record<string, { image: string; platforms: Record<string, string> }>
function render(root: string) {
  const out = join(root, 'out')
  const r = spawnSync('node', ['deploy/kubernetes/render-ok-shared-recovery.mjs', out], { cwd: root, encoding: 'utf8', timeout: 55_000 })
  return { ...r, out }
}
function refused(root: string, reason: string) {
  const r = render(root)
  expect(r.status).not.toBe(0)
  expect(r.stderr).toContain(reason)
  expect(existsSync(r.out)).toBe(false)
}
const pin = (root: string, overlay: string, digest: string) => {
  const p = join(root, 'deploy/kubernetes/overlays', overlay, 'kustomization.yaml')
  writeFileSync(p, readFileSync(p, 'utf8').replace(/digest: sha256:[a-f0-9]{64}/, `digest: ${digest}`))
}
const write = (root: string, body: unknown) => writeFileSync(join(root, file), typeof body === 'string' ? body : JSON.stringify(body))

describe('render-ok-shared-recovery.mjs reads its images from expected-digests.json', () => {
  it('records two differing per-overlay digests and their platform children', () => {
    const root = tree(); const e = original()
    const other = `ghcr.io/openkubes/ok-console@${index('a')}`
    e['ok-shared-bootstrap-recovery'] = { image: other, platforms: { 'linux/amd64': amd64, 'linux/arm64': arm64 } }
    write(root, e); pin(root, 'ok-shared-bootstrap-recovery', index('a'))
    const r = render(root)
    expect(r.stderr).toBe(''); expect(r.status).toBe(0)
    expect(readFileSync(join(r.out, 'bootstrap.yaml'), 'utf8')).toContain(`image: ${other}`)
    expect(readFileSync(join(r.out, 'post-recovery.yaml'), 'utf8')).toContain(`image: ${bg(e).image}`)
    const evidence = JSON.parse(readFileSync(join(r.out, 'recovery-evidence.json'), 'utf8'))
    expect(evidence.imageDigests).toEqual({
      bootstrap: { overlay: 'ok-shared-bootstrap-recovery', image: other, platforms: { 'linux/amd64': amd64, 'linux/arm64': arm64 } },
      postRecovery: { overlay: 'ok-shared-breakglass', ...e['ok-shared-breakglass'] },
    })
  })

  it.each(['ok-shared-bootstrap-recovery', 'ok-shared-breakglass'])('refuses when the %s overlay pins another digest than the file', (overlay) => {
    const root = tree(); pin(root, overlay, index('c'))
    refused(root, `overlays/${overlay}/kustomization.yaml does not pin the image in ${file}`)
  })

  it('refuses when the rendered Deployment runs another image than the file', () => {
    const root = tree()
    const p = join(root, 'deploy/kubernetes/overlays/ok-shared-breakglass/kustomization.yaml')
    writeFileSync(p, readFileSync(p, 'utf8').replace('newName: ghcr.io/openkubes/ok-console', 'newName: ghcr.io/openkubes/other'))
    refused(root, `Rendered deploy/kubernetes/overlays/ok-shared-breakglass does not run exactly the image in ${file}`)
  })

  it('refuses when the file is absent', () => {
    const root = tree(); rmSync(join(root, file))
    refused(root, `${file} is missing`)
  })

  it('refuses when the file is not JSON', () => {
    const root = tree(); write(root, '{"ok-shared-breakglass": ')
    refused(root, `${file} is not valid JSON`)
  })

  it('refuses a duplicated overlay key that JSON.parse would silently collapse', () => {
    const root = tree(); const text = readFileSync(join(source, 'overlays/expected-digests.json'), 'utf8')
    const entry = JSON.stringify(original()['ok-shared-breakglass'])
    write(root, text.replace(/\n}\s*$/, `,\n  "ok-shared-breakglass": ${entry}\n}\n`))
    refused(root, 'names ok-shared-breakglass more than once')
  })

  type Entry = { image: unknown; platforms: Record<string, string>; tag?: string }
  type Digests = Record<string, Entry | null>
  const bg = (e: Digests) => e['ok-shared-breakglass'] as Entry
  const mutate = (f: (e: Digests) => unknown) => { const e: Digests = original(); const r = f(e); return r === undefined ? e : r }
  it.each([
    ['null', () => null, 'must name exactly'],
    ['an array', () => [], 'must name exactly'],
    ['a missing overlay', mutate((e) => { delete e['ok-shared-bootstrap-recovery'] }), 'must name exactly'],
    ['a foreign overlay', mutate((e) => { e['ok-shared-live'] = e['ok-shared-breakglass'] }), 'must name exactly'],
    ['a null entry', mutate((e) => { e['ok-shared-breakglass'] = null }), 'entry must have exactly image and platforms'],
    ['an extra entry key', mutate((e) => { bg(e).tag = 'rc.30' }), 'entry must have exactly image and platforms'],
    ['a missing platforms key', mutate((e) => { delete (bg(e) as Partial<Entry>).platforms }), 'entry must have exactly image and platforms'],
    ['a tag instead of a digest', mutate((e) => { bg(e).image = 'ghcr.io/openkubes/ok-console:rc.30' }), 'image must be'],
    ['a truncated digest', mutate((e) => { bg(e).image = 'ghcr.io/openkubes/ok-console@sha256:705edc32' }), 'image must be'],
    ['another repository', mutate((e) => { bg(e).image = (bg(e).image as string).replace('openkubes/ok-console', 'other/ok-console') }), 'image must be'],
    ['a wrong-type image', mutate((e) => { bg(e).image = 7 }), 'image must be'],
    ['platforms without linux/amd64', mutate((e) => { bg(e).platforms = { 'linux/arm64': arm64 } }), 'platforms must map'],
    ['an empty platforms map', mutate((e) => { bg(e).platforms = {} }), 'platforms must map'],
    ['an unknown platform', mutate((e) => { bg(e).platforms['windows/amd64'] = index('3') }), 'platforms must map'],
    ['a malformed child digest', mutate((e) => { bg(e).platforms['linux/amd64'] = 'sha256:349eca29' }), 'platforms must map'],
    ['a child equal to the index', mutate((e) => { bg(e).platforms['linux/amd64'] = (bg(e).image as string).split('@')[1] }), 'platforms must map'],
    ['duplicate child digests', mutate((e) => { bg(e).platforms['linux/arm64'] = bg(e).platforms['linux/amd64'] }), 'platforms must map'],
  ])('refuses a file with %s', (_label, body, reason) => {
    const root = tree(); write(root, typeof body === 'function' ? (body as () => unknown)() : body)
    refused(root, reason)
  })
})
