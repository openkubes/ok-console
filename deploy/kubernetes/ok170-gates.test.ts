// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Each case launches several real CLI processes; allow for slow mounted filesystems.
vi.setConfig({ testTimeout: 20_000 })

const tool = fileURLToPath(new URL('./ok170-gates.mjs', import.meta.url))
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const copy = <T,>(x: T): T => structuredClone(x)
const selector = ['f:spec', 'f:selector']
const ports = ['f:spec', 'f:ports']
function entry(manager: string, paths = [selector], operation = 'Apply') {
  const fieldsV1: Record<string, unknown> = {}
  for (const path of paths) {
    let node = fieldsV1
    for (const key of path) { node[key] ??= {}; node = node[key] as Record<string, unknown> }
  }
  return { manager, operation, apiVersion: 'v1', fieldsType: 'FieldsV1', fieldsV1 }
}
function baseline() {
  return { apiVersion: 'v1', kind: 'Service', metadata: {
    name: 'observed-state-producer', namespace: 'openkubes-console', uid: 'uid-1', resourceVersion: '7', generation: 1,
    labels: { app: 'producer' }, annotations: { retained: 'yes' }, managedFields: [entry('old', [selector, ports])],
  }, spec: { selector: { app: 'producer' }, ports: [{ port: 80 }], env: [{ name: 'A', value: 'a' }, { name: 'B', value: 'b' }] } }
}
type Reply = { stdout?: string; stderr?: string; status?: number; sleep?: boolean }
const reply = (x: unknown): Reply => ({ stdout: JSON.stringify(x) })
const version = reply({ clientVersion: { gitVersion: 'v1.34.1' } })
function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'ok170-')); dirs.push(dir)
  const log = join(dir, 'calls.jsonl')
  writeFileSync(join(dir, 'kubectl'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({args, kuberc: process.env.KUBECTL_KUBERC, input: fs.readFileSync(0, 'utf8')})+'\\n');
if (JSON.stringify(args.slice(0,5)) !== JSON.stringify(['--context','kind-unit','--namespace','openkubes-console','--request-timeout=10s'])) { process.stderr.write('bad target'); process.exit(99); }
const q = JSON.parse(fs.readFileSync(process.env.REPLIES, 'utf8'));
const r = q.shift(); fs.writeFileSync(process.env.REPLIES, JSON.stringify(q));
if (!r) { process.stderr.write('unexpected call'); process.exit(98); }
if (r.sleep) setTimeout(() => {}, 30000);
else { process.stdout.write(r.stdout ?? ''); process.stderr.write(r.stderr ?? ''); process.exitCode = r.status ?? 0; }
`)
  chmodSync(join(dir, 'kubectl'), 0o755)
  let n = 0
  function input(value: unknown) { const path = join(dir, `input-${n++}.json`); writeFileSync(path, JSON.stringify(value)); return path }
  function run(mode: string, flags: string[], replies: Reply[], kuberc: string | null = 'false', target = ['--context', 'kind-unit', '--namespace', 'openkubes-console']) {
    writeFileSync(join(dir, 'replies.json'), JSON.stringify(replies)); writeFileSync(log, '')
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, CALL_LOG: log, REPLIES: join(dir, 'replies.json') }
    if (kuberc === null) delete env.KUBECTL_KUBERC
    else env.KUBECTL_KUBERC = kuberc
    const r = spawnSync(process.execPath, [tool, mode, ...target, ...flags], { encoding: 'utf8', env, timeout: 18000 })
    return { ...r, calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((s) => JSON.parse(s) as { args: string[]; input: string; kuberc: string }) }
  }
  return { input, run }
}
type Run = ReturnType<ReturnType<typeof harness>['run']>
function failed(r: Run, reason?: string) {
  expect(r.status).not.toBe(0); expect(r.stdout).not.toContain('PASS ')
  expect(r.stderr.trim().split('\n')).toHaveLength(1)
  if (reason) expect(r.stderr).toContain(reason)
}
function passed(r: Run, mode: string) {
  expect(r.stderr).toBe(''); expect(r.status).toBe(0)
  expect(r.stdout.trim().split('\n').at(-1)).toBe(`PASS ${mode}`)
  expect(r.stdout.match(/^PASS /gm)).toHaveLength(1)
  expect(() => JSON.parse(r.stdout.split('\n')[0])).not.toThrow()
  expect(r.calls[0].args.slice(5)).toEqual(['version', '--client', '-o', 'json'])
  for (const c of r.calls) {
    expect(c.args.slice(0, 5)).toEqual(['--context', 'kind-unit', '--namespace', 'openkubes-console', '--request-timeout=10s'])
    expect(c.kuberc).toBe('false')
    if (c.args[5] === 'get' && c.args[6] !== 'serviceaccount') expect(c.args).toContain('--show-managed-fields')
    if (c.args[5] === 'apply') {
      for (const flag of ['--server-side', '--force-conflicts=false', '--show-managed-fields']) expect(c.args).toContain(flag)
      expect(c.args.slice(-4)).toEqual(['-f', '-', '-o', 'json'])
      expect(c.args.some((a) => a.startsWith('--field-manager='))).toBe(true)
    }
  }
}
function inventory(h: ReturnType<typeof harness>) {
  return ['--allowlist', h.input({ 'Service/observed-state-producer': [{ manager: 'old', operation: 'Apply' }] })]
}
function ownership(h: ReturnType<typeof harness>, before = baseline(), mode = 'ownership-adopt') {
  return ['--snapshot', h.input(before), '--selected', h.input({ 'Service/observed-state-producer': { manager: 'new', paths: [selector] } }),
    '--artifact', h.input({ apiVersion: 'v1', kind: 'Service', metadata: { name: before.metadata.name }, spec: before.spec }),
    ...(mode === 'ownership-release' ? ['--manager', 'old'] : [])]
}
function adopted() { const x = baseline(); x.metadata.managedFields.push(entry('new')); return x }

describe('target and input guards through the real entrypoint', () => {
  it.each([null, 'true', 'False', ''])('refuses KUBECTL_KUBERC=%s before any call', (value) => {
    const h = harness(); const f = inventory(h)
    const bad = h.run('ownership-inventory', f, [], value); failed(bad); expect(bad.calls).toEqual([])
    passed(h.run('ownership-inventory', f, [version, reply(baseline())]), 'ownership-inventory')
  })
  it.each([[], ['--context', 'kind-unit'], ['--namespace', 'openkubes-console'], ['--context', '', '--namespace', 'openkubes-console']].map((target) => ({ target })))('requires both nonempty target flags $target', ({ target }) => {
    const h = harness(); const f = inventory(h); const bad = h.run('ownership-inventory', f, [], 'false', target)
    failed(bad); expect(bad.calls).toEqual([])
    passed(h.run('ownership-inventory', f, [version, reply(baseline())]), 'ownership-inventory')
  })
  it.each(['unknown', 'duplicate', 'null', 'empty', 'wrong-type', 'malformed', 'unknown-mode'])('rejects %s inputs before calls', (caseName) => {
    const h = harness(); let f = inventory(h); let mode = 'ownership-inventory'
    if (caseName === 'unknown') f.push('--extra', 'value')
    if (caseName === 'duplicate') f.push('--allowlist', f[1])
    if (caseName === 'null') f = ['--allowlist', h.input(null)]
    if (caseName === 'empty') f = ['--allowlist', h.input({})]
    if (caseName === 'wrong-type') f = ['--allowlist', h.input([])]
    if (caseName === 'malformed') { writeFileSync(f[1], '{'); }
    if (caseName === 'unknown-mode') mode = 'no-mode'
    const bad = h.run(mode, f, []); failed(bad); expect(bad.calls).toEqual([])
    passed(h.run('ownership-inventory', inventory(h), [version, reply(baseline())]), 'ownership-inventory')
  })
  it.each(['version', 'stderr', 'empty', 'unparsable', 'missing', 'nonzero'])('fails closed on kubectl %s', (c) => {
    const h = harness(); const f = inventory(h)
    const replies = c === 'version' ? [reply({ clientVersion: { gitVersion: 'v1.35.0' } })]
      : [version, c === 'stderr' ? { ...reply(baseline()), stderr: 'warning secret-data' }
        : c === 'empty' ? {} : c === 'unparsable' ? { stdout: '{' }
          : c === 'missing' ? { stdout: 'null' } : { status: 1, stderr: 'not found private-content' }]
    const bad = h.run('ownership-inventory', f, replies); failed(bad, c === 'version' ? 'wrong kubectl client version' : undefined)
    if (c === 'version') expect(bad.calls).toHaveLength(1)
    expect(bad.stderr + bad.stdout).not.toMatch(/secret-data|private-content/)
    passed(h.run('ownership-inventory', f, [version, reply(baseline())]), 'ownership-inventory')
  })
  it('kills a stalled child using its own deadline', () => {
    const h = harness(); const f = inventory(h)
    failed(h.run('ownership-inventory', f, [{ sleep: true }]), 'timeout')
    passed(h.run('ownership-inventory', f, [version, reply(baseline())]), 'ownership-inventory')
  }, 20000)
})

describe('ownership inventory', () => {
  it.each(['foreign', 'forbidden', 'unknown-operation', 'wrong-operation', 'fieldsType', 'fieldsV1', 'duplicate-entry'])('rejects %s then accepts baseline', (c) => {
    const h = harness(); const x = baseline(); const f = inventory(h)
    if (c === 'foreign' || c === 'forbidden') x.metadata.managedFields.push(entry(c === 'foreign' ? 'intruder' : 'ok-170-acceptance'))
    if (c === 'forbidden') { f.push('--forbid-manager', 'ok-170-acceptance'); writeFileSync(f[1], JSON.stringify({ 'Service/observed-state-producer': [{ manager: 'old', operation: 'Apply' }, { manager: 'ok-170-acceptance', operation: 'Apply' }] })) }
    if (c === 'unknown-operation') x.metadata.managedFields[0].operation = 'Delete'
    if (c === 'wrong-operation') x.metadata.managedFields[0].operation = 'Update'
    if (c === 'fieldsType') x.metadata.managedFields[0].fieldsType = 'Other'
    if (c === 'fieldsV1') x.metadata.managedFields[0].fieldsV1 = null as unknown as Record<string, unknown>
    if (c === 'duplicate-entry') x.metadata.managedFields.push(copy(x.metadata.managedFields[0]))
    failed(h.run('ownership-inventory', f, [version, reply(x)]))
    passed(h.run('ownership-inventory', f, [version, reply(baseline())]), 'ownership-inventory')
  })
})

describe('retained snapshot adoption and release', () => {
  it.each(['extra-adoption', 'missing-adoption', 'other-owner', 'value', 'env-order', 'generation', 'label', 'annotation'])('rejects adoption %s before positive fixture', (c) => {
    const h = harness(); const f = ownership(h); const bad = adopted()
    if (c === 'extra-adoption') bad.metadata.managedFields[1] = entry('new', [selector, ports])
    if (c === 'missing-adoption') bad.metadata.managedFields.pop()
    if (c === 'other-owner') bad.metadata.managedFields[0] = entry('old', [ports])
    if (c === 'value') bad.spec.selector.app = 'changed'
    if (c === 'env-order') bad.spec.env.reverse()
    if (c === 'generation') bad.metadata.generation++
    if (c === 'label') bad.metadata.labels.app = 'changed'
    if (c === 'annotation') bad.metadata.annotations.retained = 'changed'
    failed(h.run('ownership-adopt', f, [version, reply(baseline()), reply(bad)]))
    passed(h.run('ownership-adopt', f, [version, reply(baseline()), reply(adopted())]), 'ownership-adopt')
  })
  it.each(['uid', 'resourceVersion', 'missing-snapshot', 'missing-live', 'artifact-kind', 'artifact-namespace'])('rejects %s before dry-run', (c) => {
    const h = harness(); const f = ownership(h); const live = baseline()
    if (c === 'uid') live.metadata.uid = 'new'
    if (c === 'resourceVersion') live.metadata.resourceVersion = '8'
    if (c === 'missing-snapshot') rmSync(f[1])
    if (c === 'artifact-kind') { const a = baseline(); a.kind = 'ConfigMap'; writeFileSync(f[5], JSON.stringify(a)) }
    if (c === 'artifact-namespace') { const a = baseline(); a.metadata.namespace = 'default'; writeFileSync(f[5], JSON.stringify(a)) }
    const bad = h.run('ownership-adopt', f, [version, c === 'missing-live' ? { status: 1 } : reply(live)])
    failed(bad); expect(bad.calls.length).toBeLessThanOrEqual(2)
    passed(h.run('ownership-adopt', ownership(h), [version, reply(baseline()), reply(adopted())]), 'ownership-adopt')
  })
  it.each(['before-adoption', 'over-release', 'under-release', 'new-path', 'other-owner'])('rejects release %s before positive fixture', (c) => {
    const h = harness(); const before = c === 'before-adoption' ? baseline() : adopted()
    const f = ownership(h, before, 'ownership-release'); const after = adopted()
    after.metadata.managedFields[0] = entry('old', [ports])
    if (c === 'over-release') after.metadata.managedFields.shift()
    if (c === 'under-release') after.metadata.managedFields[0] = entry('old', [selector, ports])
    if (c === 'new-path') after.metadata.managedFields[0] = entry('old', [ports, ['f:metadata', 'f:labels']])
    if (c === 'other-owner') after.metadata.managedFields[1] = entry('new', [ports])
    failed(h.run('ownership-release', f, [version, reply(before), reply(after)]), c === 'before-adoption' ? 'release before adoption' : undefined)
    const positive = adopted(); positive.metadata.managedFields[0] = entry('old', [ports])
    passed(h.run('ownership-release', ownership(h, adopted(), 'ownership-release'), [version, reply(adopted()), reply(positive)]), 'ownership-release')
  })
  it.each(['ownership-adopt', 'ownership-release'])('%s compares the apply re-read against the retained snapshot and pins resourceVersion', (mode) => {
    const h = harness(); const before = mode === 'ownership-adopt' ? baseline() : adopted()
    const after = adopted(); if (mode === 'ownership-release') after.metadata.managedFields[0] = entry('old', [ports])
    const f = [...ownership(h, before, mode), '--apply']; const changed = copy(after); changed.spec.selector.app = 'changed'
    failed(h.run(mode, f, [version, reply(before), reply(after), reply(after), reply(changed)]))
    const good = h.run(mode, f, [version, reply(before), reply(after), reply(after), reply(after)])
    passed(good, mode)
    const apply = good.calls.filter((c) => c.args.includes('apply'))
    expect(apply).toHaveLength(2)
    expect(JSON.parse(apply[1].input).metadata.resourceVersion).toBe('7')
    expect(apply[0].args).toContain('--force-conflicts=false')
  })
  it.each(['ownership-adopt', 'ownership-release'])('%s preserves distinct entries for the same manager', (mode) => {
    const h = harness(); const before = mode === 'ownership-adopt' ? baseline() : adopted()
    const target = mode === 'ownership-adopt' ? 'new' : 'old'
    const extraPath = mode === 'ownership-adopt' ? ports : ['f:metadata', 'f:labels', 'f:app']
    before.metadata.managedFields.push(entry(target, [extraPath], 'Update'))
    const good = copy(before)
    if (mode === 'ownership-adopt') good.metadata.managedFields.push(entry('new'))
    else good.metadata.managedFields[0] = entry('old', [ports])
    const bad = copy(good); bad.metadata.managedFields = bad.metadata.managedFields.filter((e) => e.operation !== 'Update')
    const applyEntry = bad.metadata.managedFields.findIndex((e) => e.manager === target)
    bad.metadata.managedFields[applyEntry] = entry(target, mode === 'ownership-adopt' ? [selector, extraPath] : [ports, extraPath])
    const f = ownership(h, before, mode)
    failed(h.run(mode, f, [version, reply(before), reply(bad)]), 'other owner changed')
    passed(h.run(mode, f, [version, reply(before), reply(good)]), mode)
  })
  it('preserves ConfigMap data and binaryData', () => {
    const h = harness(); const before = { ...baseline(), kind: 'ConfigMap', data: { safe: 'private' }, binaryData: { binary: 'c2VjcmV0' } }
    const f = ['--snapshot', h.input(before), '--artifact', h.input(before), '--selected', h.input({ 'ConfigMap/observed-state-producer': { manager: 'new', paths: [selector] } })]
    const good = copy(before); good.metadata.managedFields.push(entry('new'))
    for (const key of ['data', 'binaryData'] as const) {
      const bad = copy(good); bad[key] = { changed: 'private' } as typeof bad[typeof key]
      failed(h.run('ownership-adopt', f, [version, reply(before), reply(bad)]))
    }
    const r = h.run('ownership-adopt', f, [version, reply(before), reply(good)]); passed(r, 'ownership-adopt')
    expect(r.stdout).not.toMatch(/private|c2VjcmV0/)
  })
  it('canonicalises associative keys and records dot ownership', () => {
    const h = harness(); const before = baseline(); const good = adopted()
    const p = ['f:spec', 'f:ports', 'k:{"protocol":"TCP","port":80}']
    good.metadata.managedFields[1] = entry('new', [p])
    const f = ownership(h, before); writeFileSync(f[3], JSON.stringify({ 'Service/observed-state-producer': { manager: 'new', paths: [['f:spec', 'f:ports', 'k:{"port":80,"protocol":"TCP"}']] } }))
    good.metadata.managedFields[1].fieldsV1 = { 'f:spec': { 'f:ports': { 'k:{"protocol":"TCP","port":80}': { '.': {}, 'f:port': {} } } } }
    failed(h.run('ownership-adopt', f, [version, reply(before), reply(good)]), 'adoption')
    good.metadata.managedFields[1] = entry('new', [p])
    passed(h.run('ownership-adopt', f, [version, reply(before), reply(good)]), 'ownership-adopt')
  })
})

function permissionFlags(h: ReturnType<typeof harness>) { return ['--matrix', h.input({ 'ok-console': { allow: [['get', 'configmaps']], deny: [['get', 'secrets'], ['get', 'pods']] } })] }
const sa = reply({ kind: 'ServiceAccount', metadata: { name: 'ok-console', namespace: 'openkubes-console' } })
const yes = { stdout: 'yes\n' }; const no = { stdout: 'no\n', status: 1 }
describe('permission controls', () => {
  it.each(['denial-yes', 'positive-no', 'impersonation', 'stderr', 'empty', 'wrong-exit', 'missing-sa'])('rejects %s then passes explicit namespace checks', (c) => {
    const h = harness(); const f = permissionFlags(h)
    const replies = [version, sa, yes, no, no].map(copy)
    if (c === 'denial-yes') replies[3] = yes
    if (c === 'positive-no') replies[2] = no
    if (c === 'impersonation') replies[3] = { status: 1, stderr: 'Error from server (Forbidden): cannot impersonate' }
    if (c === 'stderr') replies[3] = { ...no, stderr: 'warning' }
    if (c === 'empty') replies[3] = { status: 1 }
    if (c === 'wrong-exit') replies[3] = { stdout: 'no\n', status: 0 }
    if (c === 'missing-sa') replies[1] = { status: 1 }
    failed(h.run('permissions', f, replies))
    const good = h.run('permissions', f, [version, sa, yes, no, no]); passed(good, 'permissions')
    const checks = good.calls.filter((c) => c.args.includes('can-i'))
    expect(checks.map((c) => c.args.slice(7, 9))).toEqual([['get', 'configmaps'], ['get', 'secrets'], ['get', 'pods']])
    for (const call of checks) expect(call.args).toContain('--as=system:serviceaccount:openkubes-console:ok-console')
  })
})

describe('admission compares all changed leaves in both directions', () => {
  function flags(h: ReturnType<typeof harness>, delta: unknown = [{ path: '/spec/selector/app', value: 'new' }]) {
    return ['--snapshot', h.input(baseline()), '--artifact', h.input(baseline()), '--manager', 'old', '--delta', h.input(delta)]
  }
  it.each(['missing-field', 'extra-field', 'unexpected-default', 'undeclared-deletion', 'wrong-value', 'no-delta'])('rejects %s before exact delta passes', (c) => {
    const h = harness(); const f = flags(h); const bad = baseline(); bad.spec.selector.app = 'new'
    if (c === 'missing-field') delete (bad.spec.selector as { app?: string }).app
    if (c === 'extra-field') Object.assign(bad.spec, { extra: true })
    if (c === 'unexpected-default') Object.assign(bad.spec, { sessionAffinity: 'None' })
    if (c === 'undeclared-deletion') delete (bad.spec as { ports?: unknown }).ports
    if (c === 'wrong-value') bad.spec.selector.app = 'unexpected'
    if (c === 'no-delta') bad.spec.selector.app = 'producer'
    failed(h.run('admission', f, [version, reply(baseline()), reply(bad)]))
    const good = baseline(); good.spec.selector.app = 'new'
    passed(h.run('admission', f, [version, reply(baseline()), reply(good)]), 'admission')
  })
  it('requires a declared deletion to remove an existing field', () => {
    const h = harness()
    const invalid = flags(h, [{ path: '/spec/alreadyAbsent', deleted: true }])
    failed(h.run('admission', invalid, [version, reply(baseline()), reply(baseline())]), 'not realised')
    passed(h.run('admission', flags(h, []), [version, reply(baseline()), reply(baseline())]), 'admission')
  })
  it('accepts declared deletion and distinguishes missing from null', () => {
    const h = harness(); const out = baseline(); delete (out.spec.selector as { app?: unknown }).app
    const f = flags(h, [{ path: '/spec/selector/app', deleted: true }])
    const bad = baseline(); (bad.spec.selector as { app: unknown }).app = null
    failed(h.run('admission', f, [version, reply(baseline()), reply(bad)]))
    passed(h.run('admission', f, [version, reply(baseline()), reply(out)]), 'admission')
  })
  it.each(['duplicate', 'overlap', 'bad-pointer', 'null', 'both'])('rejects malformed %s delta before any call', (c) => {
    const h = harness(); const d = { path: '/spec/selector/app', value: 'new' }
    const delta = c === 'duplicate' ? [d, d] : c === 'overlap' ? [d, { path: '/spec/selector', value: {} }]
      : c === 'bad-pointer' ? [{ path: '/spec/~2', value: 1 }] : c === 'null' ? null : [{ ...d, deleted: true }]
    const r = h.run('admission', flags(h, delta), []); failed(r); expect(r.calls).toEqual([])
    const good = baseline(); good.spec.selector.app = 'new'
    passed(h.run('admission', flags(h), [version, reply(baseline()), reply(good)]), 'admission')
  })
  it.each(['conflict', 'invalid'])('expected %s only inverts the classified rejection', (classification) => {
    const h = harness(); const f = flags(h); const stderr = classification === 'conflict'
      ? 'error: Apply failed with 1 conflict: conflict with "ok-172-live": .spec.template.spec.containers[name="console"].image\n'
      : 'The Service "observed-state-producer" is invalid: spec.ports: Required value\n'
    failed(h.run('admission', f, [version, reply(baseline()), { status: 1, stderr }]))
    const expected = [...f.slice(0, -2), '--expect-rejection', classification]
    for (const wrong of ['Error from server (Forbidden): private', 'Error from server (Conflict): object has been modified', 'Error from server (NotFound): private']) {
      failed(h.run('admission', expected, [version, reply(baseline()), { status: 1, stderr: wrong }]))
    }
    failed(h.run('admission', expected, [version, reply(baseline()), reply(baseline())]))
    passed(h.run('admission', expected, [version, reply(baseline()), { status: 1, stderr }]), 'admission')
    if (classification === 'conflict') passed(h.run('admission', expected, [version, reply(baseline()), { status: 1, stderr: stderr.replace('error: ', 'Error from server (Conflict): ') }]), 'admission')
  })
})
