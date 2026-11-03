#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

class GateError extends Error {}
const fail = (reason) => { throw new GateError(reason); };
const check = (condition, reason) => { if (!condition) fail(reason); };
const record = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const string = (x) => typeof x === 'string' && x.trim().length > 0;
const equal = isDeepStrictEqual;
const kinds = new Set(['Deployment', 'Service', 'ConfigMap', 'Ingress']);
const modes = {
  'ownership-inventory': ['allowlist', 'forbid-manager'],
  'ownership-adopt': ['snapshot', 'selected', 'artifact', 'manager', 'apply'],
  'ownership-release': ['snapshot', 'selected', 'artifact', 'manager', 'apply'],
  permissions: ['matrix'],
  admission: ['snapshot', 'artifact', 'manager', 'delta', 'expect-rejection', 'expect-paths', 'expect-conflict-manager'],
};
function json(text, reason) { try { return JSON.parse(text); } catch { fail(reason); } }
function file(path) { try { return json(readFileSync(path, 'utf8'), 'invalid JSON input'); } catch { fail('missing or invalid JSON input'); } }
function identity(x, ns, snapshot = false) {
  check(record(x) && kinds.has(x.kind) && string(x.apiVersion) && record(x.metadata)
    && string(x.metadata.name) && /^[a-z0-9][a-z0-9.-]*$/.test(x.metadata.name), 'invalid object');
  check(x.metadata.namespace === undefined || x.metadata.namespace === ns, 'namespace mismatch');
  if (snapshot) check(string(x.metadata.uid) && string(x.metadata.resourceVersion), 'invalid snapshot identity');
  return `${x.kind}/${x.metadata.name}`;
}
function token(t) {
  check(typeof t === 'string' && /^(f:|k:|v:|i:).+/.test(t), 'invalid fieldsV1 token');
  if (t.startsWith('k:')) {
    const key = json(t.slice(2), 'invalid fieldsV1 key');
    check(record(key) && Object.keys(key).length > 0, 'invalid fieldsV1 key');
    const sort = (v) => Array.isArray(v) ? v.map(sort) : record(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v;
    return `k:${JSON.stringify(sort(key))}`;
  }
  if (t.startsWith('v:')) json(t.slice(2), 'invalid fieldsV1 value');
  if (t.startsWith('i:')) check(/^i:\d+$/.test(t), 'invalid fieldsV1 index');
  return t;
}
function fields(x) {
  check(record(x.metadata) && Array.isArray(x.metadata.managedFields) && x.metadata.managedFields.length > 0, 'missing managedFields');
  const entries = new Map();
  for (const e of x.metadata.managedFields) {
    check(record(e) && string(e.manager) && ['Apply', 'Update'].includes(e.operation)
      && string(e.apiVersion) && (e.subresource === undefined || typeof e.subresource === 'string')
      && e.fieldsType === 'FieldsV1' && record(e.fieldsV1), 'invalid managedFields operation or fieldsV1');
    const paths = new Set();
    function walk(node, path) {
      check(record(node), 'invalid fieldsV1 node');
      if (Object.keys(node).length === 0 || Object.hasOwn(node, '.')) paths.add(JSON.stringify(path));
      for (const [k, v] of Object.entries(node)) {
        if (k === '.') { check(record(v) && Object.keys(v).length === 0, 'invalid fieldsV1 dot'); continue; }
        walk(v, [...path, token(k)]);
      }
    }
    walk(e.fieldsV1, []);
    const key = JSON.stringify([e.manager, e.operation, e.apiVersion, e.subresource ?? '']);
    check(!entries.has(key), 'duplicate managedFields entry');
    entries.set(key, { manager: e.manager, operation: e.operation, subresource: e.subresource ?? '', paths: [...paths].sort() });
  }
  return entries;
}
function owned(entries, manager) {
  return new Set([...entries.values()].filter((e) => e.manager === manager).flatMap((e) => e.paths));
}
const minus = (a, b) => [...a].filter((p) => !b.has(p)).sort();
function stableValues(before, after) {
  check(equal(projection(before), projection(after))
    && equal(before.metadata.generation, after.metadata.generation), 'values, env order or generation changed');
}
const pointer = (p) => p.replaceAll('~', '~0').replaceAll('/', '~1');
const roots = ['spec', 'data', 'binaryData', 'immutable'];
function projection(x) {
  const result = {};
  for (const k of roots) if (Object.hasOwn(x, k)) result[k] = x[k];
  result.metadata = {};
  for (const k of ['labels', 'annotations', 'finalizers', 'ownerReferences']) if (Object.hasOwn(x.metadata, k)) result.metadata[k] = x.metadata[k];
  return result;
}
const absent = Symbol('absent');
function differences(a, b, path = '') {
  if (equal(a, b)) return [];
  const branch = (v) => record(v) || Array.isArray(v);
  if ((branch(a) || a === absent) && (branch(b) || b === absent)
    && (a === absent || b === absent || Array.isArray(a) === Array.isArray(b))) {
    const keys = new Set([...Object.keys(a === absent ? {} : a), ...Object.keys(b === absent ? {} : b)]);
    if (keys.size) return [...keys].flatMap((k) => differences(
      a !== absent && Object.hasOwn(a, k) ? a[k] : absent,
      b !== absent && Object.hasOwn(b, k) ? b[k] : absent, `${path}/${pointer(k)}`));
  }
  return [path];
}
function at(x, path) {
  for (const k of path.slice(1).split('/').map((s) => s.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if ((!record(x) && !Array.isArray(x)) || !Object.hasOwn(x, k)) return absent;
    x = x[k];
  }
  return x;
}
function fieldPath(path) {
  return typeof path === 'string' && /^\.?[A-Za-z_][\w-]*(?:\[(?:\d+|[\w.-]+="[^"\]\r\n]+")\]|\.[A-Za-z_][\w/-]*)*$/.test(path);
}
// kubectl v1.34.1 appends this fixed help text to SSA conflicts.
const conflictHelp = [
  "Please review the fields above--they currently have other managers. Here",
  "are the ways you can resolve this warning:",
  "* If you intend to manage all of these fields, please re-run the apply",
  "  command with the `--force-conflicts` flag.",
  "* If you do not intend to manage all of the fields, please edit your",
  "  manifest to remove references to the fields that should keep their",
  "  current managers.",
  "* You may co-own fields by updating your manifest to match the existing",
  "  value; in this case, you'll become the manager if the other manager(s)",
  "  stop managing the field (remove it from their configuration).",
  "See https://kubernetes.io/docs/reference/using-api/server-side-apply/#conflicts",
].join('\n');
function classifyRejection(stderr, artifact) {
  stderr = stderr.replace(/^(?:Warning:[^\r\n]*\r?\n)+/, '');
  const conflict = /^(?:error: |Error from server \(Conflict\): )Apply failed with (\d+) conflicts?: /.exec(stderr);
  if (conflict) {
    let body = stderr.slice(conflict[0].length).replaceAll('\r\n', '\n');
    const help = body.indexOf('\nPlease review the fields above--');
    if (help !== -1) {
      if (body.slice(help + 1).trimEnd() !== conflictHelp) return null;
      body = body.slice(0, help);
    }
    const lines = body.trimEnd().split(/\r?\n/);
    const items = [];
    let manager;
    for (const line of lines) {
      const block = /^(?:- )?conflicts? with "([^"\r\n]+)"(?: using [A-Za-z0-9./-]+)?:([ \t]*(\.[^\r\n]+))?$/.exec(line);
      if (block) {
        manager = block[1];
        if (block[3]) items.push([manager, block[3].trim()]);
      } else if (manager && /^- \./.test(line)) items.push([manager, line.slice(2).trim()]);
      else return null;
    }
    if (items.length !== Number(conflict[1]) || !items.every((m) => fieldPath(m[1]))) return null;
    return { classification: 'conflict', paths: [...new Set(items.map((m) => m[1]))].sort(), managers: items.map((m) => m[0]) };
  }
  const prefix = `The ${artifact.kind} "${artifact.metadata.name}" is invalid:`;
  if (!stderr.startsWith(prefix) && !/^Error from server \(Invalid\):/.test(stderr)) return null;
  const body = stderr.startsWith(prefix) ? stderr.slice(prefix.length) : stderr.replace(/^Error from server \(Invalid\):.*? is invalid:/, '');
  const items = body.trim().split(/\r?\n|,\s+(?=[^,:\r\n]+:\s)/).map((s) => s.trim().replace(/^\*\s+/, ''));
  const paths = items.map((item) => /^([^:]+):\s+.+$/.exec(item)?.[1]);
  if (!paths.length || !paths.every(fieldPath)) return null;
  return { classification: 'invalid', paths: [...new Set(paths)].sort() };
}
function parse(argv) {
  const [mode, ...args] = argv;
  check(Object.hasOwn(modes, mode), 'unknown mode');
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i].slice(2);
    check(args[i].startsWith('--') && ['context', 'namespace', ...modes[mode]].includes(key)
      && !Object.hasOwn(flags, key), 'unknown or duplicate flag');
    if (key === 'apply') flags[key] = true;
    else { check(string(args[i + 1]) && !args[i + 1].startsWith('--'), 'missing flag value'); flags[key] = args[++i]; }
  }
  for (const k of ['context', 'namespace']) check(string(flags[k]), `missing --${k}`);
  check(process.env.KUBECTL_KUBERC === 'false', 'KUBECTL_KUBERC must be false');
  const required = mode === 'ownership-inventory' ? ['allowlist'] : mode === 'permissions' ? ['matrix']
    : mode === 'admission' ? ['snapshot', 'artifact', 'manager'] : ['snapshot', 'selected', 'artifact'];
  if (mode === 'ownership-release') required.push('manager');
  for (const k of required) check(string(flags[k]), `missing --${k}`);
  if (flags['expect-rejection']) check(['conflict', 'invalid'].includes(flags['expect-rejection']), 'invalid expected rejection');
  if (mode === 'admission') check(Boolean(flags.delta) !== Boolean(flags['expect-rejection']), 'provide delta or expected rejection');
  if (flags['expect-rejection']) {
    check(string(flags['expect-paths']), 'missing --expect-paths');
    const paths = json(flags['expect-paths'], 'invalid expected paths');
    check(Array.isArray(paths) && paths.length > 0 && paths.every(fieldPath)
      && new Set(paths).size === paths.length, 'invalid expected paths');
    flags.expectedPaths = paths.sort();
    if (flags['expect-rejection'] === 'conflict') check(string(flags['expect-conflict-manager']), 'missing --expect-conflict-manager');
    else check(!flags['expect-conflict-manager'], 'unexpected conflict manager');
  } else check(!flags['expect-paths'] && !flags['expect-conflict-manager'], 'unexpected rejection flags');
  const input = {};
  for (const k of ['allowlist', 'matrix', 'snapshot', 'selected', 'artifact', 'delta']) if (flags[k]) input[k] = file(flags[k]);
  if (input.snapshot) {
    input.id = identity(input.snapshot, flags.namespace, true);
    check(identity(input.artifact, flags.namespace) === input.id, 'artifact identity mismatch');
    fields(input.snapshot);
  } else if (flags.snapshot) fail('invalid snapshot');
  if (mode.startsWith('ownership-') && mode !== 'ownership-inventory') {
    check(record(input.selected) && equal(Object.keys(input.selected), [input.id]), 'invalid selected object');
    const selected = input.selected[input.id];
    check(record(selected) && Object.keys(selected).every((k) => ['manager', 'paths'].includes(k)) && string(selected.manager) && Array.isArray(selected.paths) && selected.paths.length > 0,
      'invalid selected paths');
    input.paths = selected.paths.map((p) => { check(Array.isArray(p), 'invalid selected path'); return JSON.stringify(p.map(token)); });
    check(new Set(input.paths).size === input.paths.length, 'duplicate selected path');
    input.adopter = selected.manager;
    if (mode === 'ownership-adopt') check(!flags.manager || flags.manager === input.adopter, 'adopting manager mismatch');
    else check(flags.manager !== input.adopter, 'releasing manager equals adopter');
  }
  if (mode === 'ownership-inventory') {
    check(record(input.allowlist) && Object.keys(input.allowlist).length > 0, 'invalid allowlist');
    for (const [id, entries] of Object.entries(input.allowlist)) {
      const [kind, name, extra] = id.split('/');
      check(kinds.has(kind) && string(name) && /^[a-z0-9][a-z0-9.-]*$/.test(name) && extra === undefined
        && Array.isArray(entries) && entries.length > 0, 'invalid allowlist object');
      for (const e of entries) check(record(e) && Object.keys(e).every((k) => ['manager', 'operation', 'subresource', 'required'].includes(k))
        && string(e.manager) && ['Apply', 'Update'].includes(e.operation)
        && (e.subresource === undefined || typeof e.subresource === 'string')
        && (e.required === undefined || typeof e.required === 'boolean'), 'invalid allowlist entry');
    }
  }
  if (mode === 'permissions') {
    check(record(input.matrix) && Object.keys(input.matrix).length > 0, 'invalid matrix');
    for (const [sa, m] of Object.entries(input.matrix)) {
      check(/^[a-z0-9][a-z0-9.-]*$/.test(sa) && record(m) && Object.keys(m).every((k) => ['allow', 'deny'].includes(k)), 'invalid service account');
      for (const k of ['allow', 'deny']) {
        check(Array.isArray(m[k]) && m[k].length > 0, 'empty permission matrix');
        for (const pair of m[k]) check(Array.isArray(pair) && pair.length === 2
          && string(pair[0]) && /^[a-z][a-z0-9*-]*$/.test(pair[0])
          && string(pair[1]) && /^[A-Za-z*][A-Za-z0-9.*-]*(?:\/[a-z*][a-z0-9*-]*)?$/.test(pair[1]), 'invalid permission pair');
      }
    }
  }
  if (flags.delta) {
    check(Array.isArray(input.delta), 'invalid delta');
    const paths = [];
    for (const d of input.delta) {
      check(record(d) && typeof d.path === 'string'
        && /^\/(spec|data|binaryData|immutable|metadata\/(labels|annotations|finalizers|ownerReferences))(\/|$)/.test(d.path)
        && !/~(?![01])/.test(d.path) && (Object.hasOwn(d, 'value') !== Object.hasOwn(d, 'deleted'))
        && (d.deleted === undefined || d.deleted === true)
        && Object.keys(d).every((k) => ['path', 'value', 'deleted'].includes(k)), 'invalid delta entry');
      check(!paths.some((p) => p === d.path || p.startsWith(`${d.path}/`) || d.path.startsWith(`${p}/`)), 'overlapping delta paths');
      paths.push(d.path);
    }
  }
  return { mode, flags, input };
}
function main() {
  const { mode, flags: f, input: i } = parse(process.argv.slice(2));
  const common = ['--context', f.context, '--namespace', f.namespace, '--request-timeout=10s'];
  function run(args, stdin) {
    const r = spawnSync('kubectl', [...common, ...args], {
      encoding: 'utf8', input: stdin, timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, KUBECTL_KUBERC: 'false' },
    });
    check(!r.error && !r.signal, r.error?.code === 'ETIMEDOUT' ? 'kubectl timeout' : 'kubectl execution failed');
    return r;
  }
  function success(r) { check(r.status === 0 && r.stderr === '' && r.stdout.trim() !== '', 'kubectl failed, stderr or empty stdout'); return r.stdout; }
  function object(r) { const x = json(success(r), 'unparsable kubectl JSON'); check(record(x), 'invalid kubectl object'); return x; }
  const version = object(run(['version', '--client', '-o', 'json']));
  check(version.clientVersion?.gitVersion === 'v1.34.1', 'wrong kubectl client version');
  function get(id) {
    const x = object(run(['get', id, '--show-managed-fields', '-o', 'json']));
    check(identity(x, f.namespace, true) === id, 'missing or mismatched object'); fields(x); return x;
  }
  const result = [];
  if (mode === 'ownership-inventory') {
    for (const [id, allow] of Object.entries(i.allowlist)) {
      const entries = [...fields(get(id)).values()];
      for (const e of entries) {
        check(e.manager !== f['forbid-manager'], 'forbidden manager');
        check(allow.some((a) => a.manager === e.manager && a.operation === e.operation && (a.subresource ?? '') === e.subresource), 'foreign manager or operation');
      }
      for (const a of allow) check(!a.required || entries.some((e) => e.manager === a.manager
        && e.operation === a.operation && e.subresource === (a.subresource ?? '')), 'required manager absent');
      result.push({ object: id, managers: entries.map(({ manager, operation, subresource }) => ({ manager, operation, subresource })), verdict: 'pass' });
    }
  } else if (mode === 'permissions') {
    const discovery = success(run(['api-resources', '-o', 'wide'])).trim().split(/\r?\n/);
    check(/^NAME\s+SHORTNAMES\s+APIVERSION\s+NAMESPACED\s+KIND\s+VERBS/.test(discovery.shift()), 'invalid resource discovery');
    const resources = discovery.map((line) => {
      const m = /^(\S+)\s+(?:(\S+)\s+)?(\S+)\s+(true|false)\s+(\S+)\s+.+$/.exec(line);
      check(m, 'invalid resource discovery');
      return { plural: m[1], short: (m[2] ?? '').split(','), group: m[3].includes('/') ? m[3].split('/')[0] : '', kind: m[5].toLowerCase() };
    });
    function resolve([verb, resource]) {
      const [base, sub] = resource.split('/');
      const [name, ...suffix] = base.toLowerCase().split('.');
      const matches = resources.filter((r) => (!suffix.length || r.group === suffix.join('.'))
        && (r.plural === name || r.kind === name || r.short.includes(name)));
      const unique = [...new Map(matches.map((r) => [JSON.stringify([r.group, r.plural]), r])).values()];
      check(unique.length === 1, 'unknown or ambiguous resource');
      return { verb, ...unique[0], sub };
    }
    // Resolve the entire matrix before making any permission decision.
    const matrices = Object.entries(i.matrix).map(([sa, matrix]) => [sa, {
      allow: matrix.allow.map(resolve), deny: matrix.deny.map(resolve),
    }]);
    for (const [sa, matrix] of matrices) {
      const account = object(run(['get', 'serviceaccount', sa, '-o', 'json']));
      check(account.kind === 'ServiceAccount' && account.metadata?.name === sa && account.metadata?.namespace === f.namespace,
        'missing service account');
      function can(pair, denied) {
        const { verb, plural, group, sub } = pair;
        const resource = group ? `${plural}.${group}` : plural;
        const r = run(['auth', 'can-i', verb, resource, ...(sub ? [`--subresource=${sub}`] : []), `--as=system:serviceaccount:${f.namespace}:${sa}`]);
        check(r.status === (denied ? 1 : 0) && r.stderr === ''
          && (r.stdout === (denied ? 'no' : 'yes') || r.stdout === `${denied ? 'no' : 'yes'}\n`),
        denied ? 'permission denial failed' : 'positive permission control failed');
        result.push({ object: `ServiceAccount/${sa}`, operation: [verb, `${resource}${sub ? `/${sub}` : ''}`], verdict: denied ? 'denied' : 'allowed' });
      }
      for (const pair of matrix.allow) can(pair, false);
      // This built-in review needs no client CRD discovery under the impersonated SA.
      const review = object(run(['create', '--validate=false', '-f', '-', '-o', 'json', `--as=system:serviceaccount:${f.namespace}:${sa}`],
        JSON.stringify({ apiVersion: 'authorization.k8s.io/v1', kind: 'SelfSubjectRulesReview', spec: { namespace: f.namespace } })));
      check(record(review.status) && review.status.incomplete === false && Array.isArray(review.status.resourceRules), 'incomplete permission rules');
      for (const rule of review.status.resourceRules) {
        check(record(rule) && ['verbs', 'resources', 'apiGroups'].every((k) => Array.isArray(rule[k])
          && rule[k].every((v) => typeof v === 'string')), 'invalid permission rules');
        for (const { verb, plural, group, sub } of matrix.deny) {
          const target = sub ? `${plural}/${sub}` : plural;
          const matches = (values, value) => values.includes('*') || values.includes(value);
          check(!(matches(rule.verbs, verb) && matches(rule.apiGroups, group)
            && (matches(rule.resources, target) || (sub && (rule.resources.includes(`*/${sub}`) || rule.resources.includes(`${plural}/*`))))), 'permission rules grant denied pair');
        }
      }
      for (const pair of matrix.deny) can(pair, true);
    }
  } else {
    const live = get(i.id);
    check(live.metadata.uid === i.snapshot.metadata.uid && live.metadata.resourceVersion === i.snapshot.metadata.resourceVersion, 'stale snapshot');
    check(equal(projection(live), projection(i.snapshot)), 'stale snapshot');
    const before = fields(i.snapshot);
    check(equal(before, fields(live)), 'stale snapshot ownership');
    if (mode === 'ownership-adopt') {
      const others = new Set([...before.values()].filter((e) => e.manager !== i.adopter).flatMap((e) => e.paths));
      check(i.paths.every((p) => others.has(p)), 'selected path not owned by another manager');
    }
    if (mode === 'ownership-release') {
      const adopted = owned(fields(live), i.adopter);
      check(i.paths.every((p) => adopted.has(p)), 'release before adoption');
    }
    const manager = mode === 'ownership-adopt' ? i.adopter : f.manager;
    const artifact = structuredClone(i.artifact);
    if (f.apply) artifact.metadata.resourceVersion = i.snapshot.metadata.resourceVersion;
    function apply(dry) {
      const args = ['apply', '--server-side', '--force-conflicts=false', `--field-manager=${manager}`,
        ...(dry ? ['--dry-run=server'] : []), '--show-managed-fields', '-f', '-', '-o', 'json'];
      return run(args, JSON.stringify(artifact));
    }
    const dry = apply(true);
    const rejection = classifyRejection(dry.stderr, i.artifact);
    const classification = rejection?.classification ?? 'unclassified';
    if (!f['expect-rejection'] && dry.status !== 0 && classification !== 'unclassified') fail(`admission rejected: ${classification}`);
    if (f['expect-rejection']) {
      check(dry.status !== 0 && classification === f['expect-rejection'], 'expected rejection absent or unclassified');
      check(equal(rejection.paths, f.expectedPaths), 'expected rejection paths mismatch');
      if (classification === 'conflict') check(rejection.managers.every((m) => m === f['expect-conflict-manager']), 'expected conflict manager mismatch');
      result.push({ object: i.id, verdict: 'rejected', rejection: classification, paths: rejection.paths });
    } else {
      function verify(after) {
        check(identity(after, f.namespace, true) === i.id && after.metadata.uid === i.snapshot.metadata.uid, 'response identity mismatch');
        const afterEntries = fields(after);
        if (mode === 'admission') {
          const a = projection(i.snapshot), b = projection(after);
          const diff = [...new Set([...differences(a, b), ...differences(b, a)])].sort();
          for (const d of i.delta) {
            check(diff.some((p) => p === d.path || p.startsWith(`${d.path}/`)), 'approved delta not realised');
            check(d.deleted ? at(b, d.path) === absent : equal(at(b, d.path), d.value), 'approved delta value mismatch');
          }
          check(diff.every((p) => i.delta.filter((d) => p === d.path || p.startsWith(`${d.path}/`)).length === 1), 'unapproved admission delta');
          return diff;
        }
        stableValues(i.snapshot, after);
        const target = mode === 'ownership-adopt' ? i.adopter : f.manager;
        const oldPaths = owned(before, target), newPaths = owned(afterEntries, target);
        if (mode === 'ownership-adopt') {
          check(equal(minus(newPaths, oldPaths), [...i.paths].sort()) && minus(oldPaths, newPaths).length === 0, 'extra or missing adoption');
        } else {
          check(minus(newPaths, oldPaths).length === 0 && equal(minus(oldPaths, newPaths), [...i.paths].sort()), 'over-release, under-release or newly owned path');
        }
        const targetKey = JSON.stringify([target, 'Apply', i.artifact.apiVersion, '']);
        for (const key of new Set([...before.keys(), ...afterEntries.keys()])) {
          if (key !== targetKey) check(equal(before.get(key), afterEntries.get(key)), 'other owner changed');
        }
        return i.paths.map((p) => JSON.parse(p));
      }
      const paths = verify(object(dry));
      if (f.apply) { verify(object(apply(false))); verify(get(i.id)); }
      result.push({ object: i.id, manager, paths, verdict: 'pass' });
    }
  }
  process.stdout.write(`${JSON.stringify(result)}\nPASS ${mode}\n`);
}
try { main(); } catch (e) {
  // All diagnostics are fixed strings: never include subprocess output or input values.
  process.stderr.write(`${e instanceof GateError ? e.message : 'gate failed'}\n`);
  process.exitCode = 1;
}
