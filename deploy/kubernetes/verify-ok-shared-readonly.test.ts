// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The script launches kubectl, python3 and several gate processes per case.
vi.setConfig({ testTimeout: 60_000 })

const script = process.env.OK170_READONLY_SCRIPT ?? fileURLToPath(new URL('./verify-ok-shared-readonly.sh', import.meta.url))
const context = 'ok-shared-admin@ok-shared'
const ns = 'openkubes-console'
const oldImage = `ghcr.io/openkubes/ok-console@sha256:${'1'.repeat(64)}`
const newImage = `ghcr.io/openkubes/ok-console@sha256:${'2'.repeat(64)}`
const child = `sha256:${'3'.repeat(64)}`
const imagePath = '/spec/template/spec/containers/0/image'
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

type Reply = { stdout?: string; stderr?: string; status?: number }
const json = (x: unknown): Reply => ({ stdout: JSON.stringify(x) })
const fields = (manager: string) => [{ manager, operation: 'Apply', apiVersion: 'apps/v1', fieldsType: 'FieldsV1', fieldsV1: { 'f:spec': { 'f:template': {} } } }]
const labels = { 'app.kubernetes.io/name': 'ok-console' }
const podTemplate = (image: string) => ({ metadata: { labels }, spec: { containers: [{ name: 'ok-console', image }] } })

function deployment(image: string, managers = fields('ok-172-live')) {
  return { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'ok-console', namespace: ns, uid: 'd-1', resourceVersion: '10', generation: 4, managedFields: managers },
    spec: { replicas: 1, selector: { matchLabels: labels }, template: podTemplate(image) } }
}
function configMap() {
  return { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'observations', namespace: ns, uid: 'c-1', resourceVersion: '11',
    managedFields: [{ ...fields('ok-172-live')[0], apiVersion: 'v1', fieldsV1: { 'f:data': {} } }] }, data: { a: '1' } }
}
const rendered = (image = newImage, extra = '') => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ok-console
  namespace: ${ns}
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: ok-console
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ok-console
    spec:
      containers:
      - name: ok-console
        image: ${image}
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: observations
  namespace: ${ns}
data:
  a: "1"
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ok-console-live-egress
  namespace: ${ns}
spec: {}
${extra}`

function runtime(imageID = `ghcr.io/openkubes/ok-console@${child}`) {
  const owner = (kind: string, uid: string) => [{ kind, uid, controller: true }]
  const rev = { 'deployment.kubernetes.io/revision': '5' }
  const d = { ...deployment(newImage), metadata: { ...deployment(newImage).metadata, annotations: rev },
    status: { observedGeneration: 4, replicas: 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 } }
  const rs = { metadata: { name: 'ok-console-5', uid: 'rs-5', annotations: rev, ownerReferences: owner('Deployment', 'd-1') },
    spec: { replicas: 1, template: podTemplate(newImage) }, status: { replicas: 1 } }
  const pod = { metadata: { name: 'ok-console-5-a', ownerReferences: owner('ReplicaSet', 'rs-5') }, spec: podTemplate(newImage).spec,
    status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [{ name: 'ok-console', ready: true, imageID }] } }
  return { d, rs, pod }
}

const netpol = 'NetworkPolicy.v1.networking.k8s.io/ok-console-live-egress'
type Policy = { apiVersion: string; kind: string; metadata: { name: string; namespace: string; uid: string; resourceVersion: string; labels: Record<string, string> }; spec: Record<string, unknown> }
const livePolicy = (): Policy => ({ apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy',
  metadata: { name: 'ok-console-live-egress', namespace: ns, uid: 'n-1', resourceVersion: '12', labels: { extra: 'server-side' } },
  spec: { podSelector: {}, policyTypes: ['Egress'] } })
function scenario() {
  const before = deployment(oldImage)
  const after = structuredClone(before); after.spec.template.spec.containers[0].image = newImage
  const r = runtime()
  const replies: Record<string, Reply> = {
    'config current-context': { stdout: `${context}\n` },
    kustomize: { stdout: rendered() },
    'version --client -o json': json({ clientVersion: { gitVersion: 'v1.34.1' } }),
    'get Deployment/ok-console --show-managed-fields -o json': json(before),
    'get ConfigMap/observations --show-managed-fields -o json': json(configMap()),
    'apply Deployment/ok-console': json(after),
    'apply ConfigMap/observations': json(configMap()),
    'get deployment ok-console -o json': json(r.d),
    'get replicasets -l app.kubernetes.io/name=ok-console -o json': json({ kind: 'List', items: [r.rs] }),
    'get pods -l app.kubernetes.io/name=ok-console -o json': json({ kind: 'List', items: [r.pod] }),
    [`get ${netpol} -o json`]: json(livePolicy()),
  }
  const pkg = {
    deltas: { 'Deployment/ok-console': [{ path: imagePath, value: newImage }] } as Record<string, unknown>,
    allowlist: { 'Deployment/ok-console': [{ manager: 'ok-172-live', operation: 'Apply', required: true }],
      'ConfigMap/observations': [{ manager: 'ok-172-live', operation: 'Apply', required: true }] } as Record<string, unknown>,
    expected: { 'Deployment/ok-console': { container: 'ok-console', image: newImage, imageIDs: [newImage.split('@')[1], child] } } as Record<string, unknown>,
  }
  return { replies, pkg }
}

const fake = `#!/usr/bin/env node
const fs = require('node:fs');
let args = process.argv.slice(2);
const input = args.includes('-f') && args.includes('-') ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({ args, kuberc: process.env.KUBECTL_KUBERC }) + '\\n');
const target = ['--context', '${context}', '--namespace', '${ns}', '--request-timeout=10s'];
if (JSON.stringify(args.slice(0, 5)) === JSON.stringify(target)) args = args.slice(5);
else if (!(args[0] === 'config' || args[0] === 'kustomize')) { process.stderr.write('bad target'); process.exit(99); }
let key = args.join(' ');
if (args[0] === 'kustomize') key = 'kustomize';
if (args[0] === 'apply') {
  const forbidden = !args.includes('--dry-run=server') || args.some((a) => a === '--force-conflicts' || a === '--force-conflicts=true');
  if (forbidden) { fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({ violation: args }) + '\\n'); process.exit(97); }
  const o = JSON.parse(input); key = 'apply ' + o.kind + '/' + o.metadata.name;
}
const r = JSON.parse(fs.readFileSync(process.env.REPLIES, 'utf8'))[key];
if (!r) { process.stderr.write('unexpected call'); process.exit(98); }
process.stdout.write(r.stdout ?? ''); process.stderr.write(r.stderr ?? ''); process.exitCode = r.status ?? 0;
`

type Opts = { outExists?: boolean; raw?: Record<string, string>; symlink?: string; env?: Record<string, string>; args?: (pkg: string, out: string) => string[]; scriptPath?: string }
function run(s = scenario(), opts: Opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ok170-ro-')); dirs.push(dir)
  writeFileSync(join(dir, 'kubectl'), fake); chmodSync(join(dir, 'kubectl'), 0o755)
  const pkg = join(dir, 'package'); mkdirSync(pkg)
  writeFileSync(join(pkg, 'deltas.json'), JSON.stringify(s.pkg.deltas))
  writeFileSync(join(pkg, 'allowlist.json'), JSON.stringify(s.pkg.allowlist))
  writeFileSync(join(pkg, 'expected-images.json'), JSON.stringify(s.pkg.expected))
  for (const [f, v] of Object.entries(opts.raw ?? {})) writeFileSync(join(pkg, f), v)
  if (opts.symlink) { writeFileSync(join(dir, 'elsewhere.json'), readFileSync(join(pkg, opts.symlink))); rmSync(join(pkg, opts.symlink)); symlinkSync(join(dir, 'elsewhere.json'), join(pkg, opts.symlink)) }
  writeFileSync(join(dir, 'replies.json'), JSON.stringify(s.replies))
  const log = join(dir, 'calls.jsonl'); writeFileSync(log, '')
  const out = join(dir, 'out'); if (opts.outExists) mkdirSync(out)
  const tmp = join(dir, 'tmp'); mkdirSync(tmp)
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, CALL_LOG: log, REPLIES: join(dir, 'replies.json'),
    TMPDIR: tmp, ...opts.env }
  const r = spawnSync('bash', [opts.scriptPath ?? script, ...(opts.args ? opts.args(pkg, out) : [pkg, out])], { encoding: 'utf8', env, timeout: 55_000 })
  const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { args?: string[]; violation?: string[]; kuberc?: string })
  return { ...r, calls, out, tmp }
}
function stopped(r: ReturnType<typeof run>, reason: string) {
  expect(r.status).not.toBe(0)
  expect(r.stdout).not.toContain('VERIFY_READONLY=PASS')
  expect(r.stderr).toContain(`STOP: ${reason}`)
  expect(r.calls.filter((c) => c.violation)).toEqual([])
  expect(readdirSync(r.tmp)).toEqual([])
}

const cnpg = 'Cluster.v1.postgresql.cnpg.io/console-db'
const deploymentList = 'DeploymentList.v1.apps/quantity-fixture'
const unadmittedDrift = 'an object the gates do not admit differs from the live cluster'
const driftReport = (r: ReturnType<typeof run>) => readFileSync(join(r.out, 'results/unadmitted-drift.txt'), 'utf8')

function quantityCluster(resources: Record<string, unknown>) {
  return { apiVersion: 'postgresql.cnpg.io/v1', kind: 'Cluster', metadata: { name: 'console-db', namespace: ns },
    spec: { resources } }
}

function quantityDeployment(resources: Record<string, unknown>, env = '0.5') {
  // A standalone Deployment is admitted. A list fixture exercises its container shape in the drift check.
  const item = deployment(newImage)
  const container = { ...item.spec.template.spec.containers[0], resources, env: [{ name: 'THRESHOLD', value: env }] }
  return { apiVersion: 'apps/v1', kind: 'DeploymentList', metadata: { name: 'quantity-fixture', namespace: ns },
    items: [{ ...item, spec: { ...item.spec, template: { ...item.spec.template, spec: { containers: [container] } } } }] }
}

function withUnadmitted(ref: string, want: object, have: object) {
  const s = scenario()
  s.replies.kustomize = { stdout: rendered(newImage, `---\n${JSON.stringify(want)}\n`) }
  s.replies[`get ${ref} -o json`] = json(have)
  return s
}

const quantityNormalisations = [
  ['Deployment container', deploymentList,
    quantityDeployment({ requests: { cpu: '0.5', memory: '1024Mi' }, limits: { cpu: '1' } }),
    quantityDeployment({ requests: { cpu: '500m', memory: '1Gi' }, limits: { cpu: 1 } }),
    '/items/0/spec/template/spec/containers/0/resources/requests/cpu'],
  ['CNPG Cluster', cnpg,
    quantityCluster({ requests: { cpu: 0.5, memory: '1.5Gi' }, limits: { cpu: '1e0', 'example.com/resource': '0.5' } }),
    quantityCluster({ requests: { cpu: '500m', memory: '1536Mi' }, limits: { cpu: 1, 'example.com/resource': 0.5 } }),
    '/spec/resources/requests/cpu'],
] as const

describe('verify-ok-shared-readonly.sh', () => {
  it('passes on the approved delta with dry-run only, records hashes, and lists objects it does not admit', () => {
    const r = run()
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('VERIFY_READONLY=PASS manager=ok-172-live admitted=2 not_admitted=1')
    const applies = r.calls.filter((c) => c.args?.includes('apply'))
    expect(applies).toHaveLength(2)
    for (const c of applies) {
      expect(c.args).toContain('--dry-run=server')
      expect(c.args).toContain('--force-conflicts=false')
      expect(c.args).toContain('--field-manager=ok-172-live')
    }
    expect(r.calls.filter((c) => c.violation)).toEqual([])
    expect(r.calls.every((c) => c.kuberc === 'false')).toBe(true)
    expect(readFileSync(join(r.out, 'not-admitted.txt'), 'utf8')).toBe(`${netpol}\n`)
    expect(readFileSync(join(r.out, 'results/unadmitted-drift.txt'), 'utf8')).toBe(`${netpol}\tunchanged\n`)
    const sums = readFileSync(join(r.out, 'SHA256SUMS'), 'utf8')
    expect(existsSync(join(r.out, 'snapshots'))).toBe(false)
    expect(sums).not.toMatch(/snapshot|unadmitted-0/)
    expect(readdirSync(r.tmp)).toEqual([])
    for (const f of ['rendered.yaml', 'artifacts/Deployment-ok-console.json', 'results/unadmitted-drift.txt', 'results/runtime-identity.txt']) expect(sums).toContain(`./${f}`)
  })

  it.each([[{}], [{ OK_CONSOLE_KUBE_CONTEXT: 'kind-other' }]])('refuses another current kube context before reading anything else (env %j)', (env) => {
    const s = scenario(); s.replies['config current-context'] = { stdout: 'kind-other\n' }
    const r = run(s, { env })
    stopped(r, "current context 'kind-other' is not 'ok-shared-admin@ok-shared'")
    expect(r.calls.map((c) => c.args)).toEqual([['config', 'current-context']])
  })

  it('stops when allowlist.json leaves an admitted object out of the ownership inventory', () => {
    const s = scenario(); delete s.pkg.allowlist['Deployment/ok-console']
    const r = run(s); stopped(r, 'render split failed'); expect(r.stderr).toContain('allowlist.json must name exactly the admitted objects'); noApply(r)
  })

  it('stops when an object the gates do not admit differs from the live cluster', () => {
    const s = scenario(); s.replies.kustomize = { stdout: rendered().replace('spec: {}', 'spec:\n  policyTypes:\n  - Ingress') }
    const r = run(s)
    stopped(r, 'an object the gates do not admit differs from the live cluster')
    expect(readFileSync(join(r.out, 'results/unadmitted-drift.txt'), 'utf8')).toBe(`${netpol}\tDRIFT /spec/policyTypes/0\n`)
  })

  it.each([
    ['a missing field', (o: Policy) => { delete o.spec.policyTypes }, '/spec/policyTypes'],
    ['a different label', (o: Policy) => { o.metadata.labels.extra = 'other' }, '/metadata/labels/extra'],
    ['a shorter list', (o: Policy) => { o.spec.policyTypes = [] }, '/spec/policyTypes'],
    ['a wrong type', (o: Policy) => { o.spec.podSelector = 'all' }, '/spec/podSelector'],
  ])('reports drift on %s', (_label, change, path) => {
    const s = scenario()
    s.replies.kustomize = { stdout: rendered().replace('spec: {}', 'metadata:\n  labels:\n    extra: server-side\nspec:\n  podSelector: {}\n  policyTypes:\n  - Egress').replace(/(name: ok-console-live-egress\n {2}namespace: [a-z-]+\n)metadata:\n/, '$1') }
    const live = livePolicy(); change(live); s.replies[`get ${netpol} -o json`] = json(live)
    const r = run(s)
    stopped(r, 'an object the gates do not admit differs from the live cluster')
    expect(readFileSync(join(r.out, 'results/unadmitted-drift.txt'), 'utf8')).toContain(`DRIFT ${path}`)
  })

  it('reports drift when the live value equals the rendered one only after type coercion (true vs 1)', () => {
    const s = scenario(); s.replies.kustomize = { stdout: rendered().replace('spec: {}', 'spec:\n  x: true') }
    const live = livePolicy(); live.spec.x = 1; s.replies[`get ${netpol} -o json`] = json(live)
    const r = run(s)
    stopped(r, 'an object the gates do not admit differs from the live cluster')
    expect(readFileSync(join(r.out, 'results/unadmitted-drift.txt'), 'utf8')).toBe(`${netpol}\tDRIFT /spec/x\n`)
  })

  it.each(quantityNormalisations)('accepts server-normalised quantities in a %s', (_label, ref, want, have) => {
    const r = run(withUnadmitted(ref, want, have))
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
    expect(r.stdout).toContain('VERIFY_READONLY=PASS')
    expect(driftReport(r)).toContain(`${ref}\tunchanged\n`)
  })

  it('reports drift for both normalisation fixtures when quantity comparison falls back to exact equality', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok170-ro-exact-')); dirs.push(dir)
    const mutant = join(dir, 'verify-ok-shared-readonly.sh')
    const original = readFileSync(script, 'utf8')
    const exact = original.replace('if not same_quantity(want, have):', 'if want != have or type(want) is not type(have):')
    expect(exact).not.toBe(original)
    writeFileSync(mutant, exact)
    symlinkSync(fileURLToPath(new URL('./ok170-gates.mjs', import.meta.url)), join(dir, 'ok170-gates.mjs'))
    for (const [, ref, want, have, path] of quantityNormalisations) {
      const r = run(withUnadmitted(ref, want, have), { scriptPath: mutant })
      stopped(r, unadmittedDrift)
      expect(driftReport(r)).toContain(`${ref}\tDRIFT ${path}`)
    }
  })

  it.each([
    ['a changed quantity', { cpu: '500m' }, { cpu: '600m' }],
    ['decimal SI versus binary SI', { cpu: '1G' }, { cpu: '1Gi' }],
    ['an invalid live quantity', { cpu: '500m' }, { cpu: 'abc' }],
    ['an invalid rendered quantity', { cpu: 'abc' }, { cpu: '500m' }],
    ['identical invalid quantities', { cpu: 'abc' }, { cpu: 'abc' }],
    ['a missing quantity', { cpu: '500m' }, {}],
    ['a null quantity', { cpu: '0' }, { cpu: null }],
    ['a boolean quantity', { cpu: '1' }, { cpu: true }],
    ['a list used as a quantity', { cpu: [] }, { cpu: [] }],
  ])('reports quantity drift for %s', (_label, want, have) => {
    const r = run(withUnadmitted(cnpg, quantityCluster({ limits: want }), quantityCluster({ limits: have })))
    stopped(r, unadmittedDrift)
    expect(driftReport(r)).toContain(`${cnpg}\tDRIFT /spec/resources/limits/cpu\n`)
  })

  it.each([
    ['rendered', '0.50000000000000000000000000001', '0.5'],
    ['live', '0.5', '0.50000000000000000000000000001'],
  ])('reports quantity drift when rounding the %s decimal would hide it', (_label, renderedNumber, liveNumber) => {
    const want = quantityCluster({ requests: { cpu: 'RENDERED_NUMBER' } })
    const have = quantityCluster({ requests: { cpu: 'LIVE_NUMBER' } })
    const s = withUnadmitted(cnpg, want, have)
    s.replies.kustomize.stdout = s.replies.kustomize.stdout!.replace('"RENDERED_NUMBER"', renderedNumber)
    const reply = s.replies[`get ${cnpg} -o json`]
    reply.stdout = reply.stdout!.replace('"LIVE_NUMBER"', liveNumber)
    const r = run(s)
    stopped(r, unadmittedDrift)
    expect(driftReport(r)).toContain(`${cnpg}\tDRIFT /spec/resources/requests/cpu\n`)
  })

  it.each([
    ['a quantity-like env value', quantityDeployment({}, '0.5'), quantityDeployment({}, '500m'),
      '/items/0/spec/template/spec/containers/0/env/0/value'],
    ['a quantity-like claim name', quantityDeployment({ claims: [{ name: '0.5' }] }),
      quantityDeployment({ claims: [{ name: '500m' }] }), '/items/0/spec/template/spec/containers/0/resources/claims/0/name'],
    ['an extra list item', quantityDeployment({}), { ...quantityDeployment({}), items: [...quantityDeployment({}).items, deployment(newImage)] },
      '/items'],
  ] as const)('reports deployment drift for %s', (_label, want, have, path) => {
    const r = run(withUnadmitted(deploymentList, want, have))
    stopped(r, unadmittedDrift)
    expect(driftReport(r)).toContain(`${deploymentList}\tDRIFT ${path}\n`)
  })

  it('stops when an object the gates do not admit is absent from the live cluster', () => {
    const s = scenario(); s.replies[`get ${netpol} -o json`] = { status: 1, stderr: 'Error from server (NotFound)' }
    stopped(run(s), `cannot read live ${netpol}`)
  })

  it('stops on a non-admitted object outside the namespace', () => {
    const s = scenario(); s.replies.kustomize = { stdout: rendered().replace(`name: ok-console-live-egress\n  namespace: ${ns}`, 'name: ok-console-live-egress\n  namespace: kube-system') }
    const r = run(s); stopped(r, 'render split failed'); expect(r.stderr).toContain('non-admitted object outside the namespace'); noApply(r)
  })

  it('refuses an existing output directory before any kubectl call', () => {
    const r = run(scenario(), { outExists: true })
    stopped(r, 'output directory already exists')
    expect(r.calls).toEqual([])
  })

  it.each([
    ['a Secret object', '---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: s\n', 'rendered overlay must not contain Secret values'],
    ['an .invalid host', '---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: p\ndata:\n  x: https://console.example.invalid\n', 'rendered overlay contains an unresolved or mutable deployment identity'],
    ['a zero digest', `---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: p\ndata:\n  x: sha256:${'0'.repeat(64)}\n`, 'rendered overlay contains an unresolved or mutable deployment identity'],
    ['a placeholder', '---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: p\ndata:\n  x: REPLACE_ME\n', 'rendered overlay contains an unresolved or mutable deployment identity'],
  ])('stops on a render with %s', (_label, extra, reason) => {
    const s = scenario(); s.replies.kustomize = { stdout: rendered(newImage, extra) }
    stopped(run(s), reason)
  })

  it('stops on a mutable image tag', () => {
    const s = scenario(); s.replies.kustomize = { stdout: rendered('ghcr.io/openkubes/ok-console:latest') }
    stopped(run(s), 'rendered overlay contains an unresolved or mutable deployment identity')
  })

  it('stops on an SSA conflict without retrying or forcing', () => {
    const s = scenario()
    s.replies['apply Deployment/ok-console'] = { status: 1, stderr: 'error: Apply failed with 1 conflict: conflict with "kubectl-set" using apps/v1: .spec.template.spec.containers[name="ok-console"].image\n' }
    const r = run(s)
    stopped(r, 'non-forced server-side dry-run of Deployment/ok-console is not exactly the approved delta for ok-172-live')
    expect(r.calls.filter((c) => c.args?.includes('apply'))).toHaveLength(1)
  })

  it('stops when the dry-run changes a field outside the approved delta', () => {
    const s = scenario()
    const after = deployment(newImage); after.spec.replicas = 3
    s.replies['apply Deployment/ok-console'] = json(after)
    stopped(run(s), 'non-forced server-side dry-run of Deployment/ok-console is not exactly the approved delta for ok-172-live')
  })

  it('stops when an object expected unchanged would change', () => {
    const s = scenario()
    const changed = configMap(); changed.data.a = '2'
    s.replies['apply ConfigMap/observations'] = json(changed)
    stopped(run(s), 'non-forced server-side dry-run of ConfigMap/observations is not exactly the approved delta for ok-172-live')
  })

  it('stops when the approved delta names an object the overlay does not render', () => {
    const s = scenario(); s.pkg.deltas['Deployment/ghost'] = []
    stopped(run(s), 'render split failed')
  })

  it('stops when a manager outside the allowlist owns fields', () => {
    const s = scenario()
    s.replies['get Deployment/ok-console --show-managed-fields -o json'] = json(deployment(oldImage, [...fields('ok-172-live'), ...fields('kubectl-set')]))
    stopped(run(s), 'ownership inventory (managedFields) is not clean for ok-172-live')
  })

  it('stops when a running Pod reports an unapproved image', () => {
    const s = scenario(); const r = runtime(`ghcr.io/openkubes/ok-console@sha256:${'9'.repeat(64)}`)
    s.replies['get pods -l app.kubernetes.io/name=ok-console -o json'] = json({ kind: 'List', items: [r.pod] })
    stopped(run(s), 'running Pods do not match the approved images')
  })

  it.each(['deltas.json', 'allowlist.json', 'expected-images.json'])('stops when the approved package lacks %s', (name) => {
    const s = scenario()
    const dir = mkdtempSync(join(tmpdir(), 'ok170-ro-pkg-')); dirs.push(dir)
    const pkg = join(dir, 'package'); mkdirSync(pkg)
    for (const [f, v] of [['deltas.json', s.pkg.deltas], ['allowlist.json', s.pkg.allowlist], ['expected-images.json', s.pkg.expected]] as const) if (f !== name) writeFileSync(join(pkg, f), JSON.stringify(v))
    const r = spawnSync('bash', [script, pkg, join(dir, 'out')], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } })
    expect(r.status).not.toBe(0); expect(r.stderr).toContain(`STOP: approved package is missing ${name}`)
    expect(existsSync(join(dir, 'out'))).toBe(false)
  })

  it('applies the same render lint as verify-ok-shared-live.sh', () => {
    const lint = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8').match(/grep -E?q '[^']+'/g)
    const live = lint('./verify-ok-shared-live.sh'); const ro = lint('./verify-ok-shared-readonly.sh')
    expect(live).toEqual(["grep -Eq 'REPLACE_|\\.invalid|sha256:0{64}|image: .+:latest'", "grep -Eq '^kind: Secret$'"])
    expect(ro).toEqual(live)
  })

  const noApply = (r: ReturnType<typeof run>) => expect(r.calls.filter((c) => c.args?.includes('apply'))).toEqual([])

  it.each([
    ['deltas.json', '[]', 'deltas.json must be an object'],
    ['deltas.json', '{"Deployment/ok-console": ', 'JSONDecodeError'],
    ['deltas.json', 'null', 'deltas.json must be an object'],
    ['expected-images.json', '[]', 'expected-images.json must be an object'],
    ['expected-images.json', 'null', 'expected-images.json must be an object'],
    ['expected-images.json', '{}', 'expected-images.json must name exactly the rendered Deployments'],
  ])('stops before any dry-run when %s is %s', (file, body, cause) => {
    const r = run(scenario(), { raw: { [file]: body } })
    stopped(r, 'render split failed'); expect(r.stderr).toContain(cause); noApply(r)
    if (cause !== 'JSONDecodeError') expect(r.stderr).not.toContain('Traceback')
  })

  it('stops when expected-images.json names a Deployment the overlay does not render', () => {
    const s = scenario(); s.pkg.expected['Deployment/ghost'] = s.pkg.expected['Deployment/ok-console']
    const r = run(s); stopped(r, 'render split failed'); expect(r.stderr).toContain('expected-images.json must name exactly the rendered Deployments'); noApply(r)
  })

  it.each(['deltas.json', 'allowlist.json', 'expected-images.json'])('refuses a symlinked %s', (name) => {
    const r = run(scenario(), { symlink: name })
    stopped(r, `approved package is missing ${name}`); expect(r.calls).toEqual([])
  })

  it.each([
    ['a duplicate object', 'duplicate rendered object', `---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: observations\n  namespace: ${ns}\ndata:\n  a: "1"\n`],
    ['an object in a foreign namespace', 'rendered object outside the namespace', '---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: other\n  namespace: kube-system\n'],
    ['a non-object document', 'invalid rendered object', '---\njust-a-string\n'],
  ])('stops on a render with %s', (_label, cause, extra) => {
    const s = scenario(); s.replies.kustomize = { stdout: rendered(newImage, extra) }
    const r = run(s); stopped(r, 'render split failed'); expect(r.stderr).toContain(cause); expect(r.stderr).not.toContain('Traceback'); noApply(r)
  })

  it.each([['Bad Manager'], ['--force']])('refuses field manager %j before any kubectl call', (m) => {
    const r = run(scenario(), { env: { OK170_FIELD_MANAGER: m } })
    stopped(r, 'invalid field manager'); expect(r.calls).toEqual([])
  })

  it('refuses extra arguments before any kubectl call', () => {
    const r = run(scenario(), { args: (pkg, out) => [pkg, out, '--apply'] })
    stopped(r, 'usage: verify-ok-shared-readonly.sh'); expect(r.calls).toEqual([])
  })

  it('stops when python3 cannot load PyYAML', () => {
    const r = run(scenario(), { env: { PYTHONPATH: join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'ok170-no-yaml') } })
    stopped(r, 'python3 with PyYAML is required'); expect(r.calls).toEqual([])
  })

  it('contains no code path that applies for real or forces conflicts', () => {
    const code = readFileSync(script, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
    expect(code).not.toMatch(/--apply\b/)
    expect(code).not.toMatch(/--force-conflicts/)
    expect(code).not.toMatch(/\bapply\b(?!\s+--dry-run=server)/)
  })
})
