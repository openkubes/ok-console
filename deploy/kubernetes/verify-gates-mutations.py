#!/usr/bin/env python3
"""Run in the pinned gates container. Mutate disposable copies; retain per-site evidence."""
import concurrent.futures
import hashlib
import os
from pathlib import Path
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'deploy/kubernetes/ok170-gates.mjs'
OUT = ROOT / 'test-results/ok170-gates-r2/mutations'
OUT.mkdir(parents=True, exist_ok=True)
OUT = Path(tempfile.mkdtemp(prefix='run-', dir=OUT))
print(f'Mutation logs: {OUT}', flush=True)
CONFIG = OUT / 'vitest.config.mjs'
CONFIG.write_text("export default {test: {environment: 'node'}};\n")
ORIGINAL = SOURCE.read_text()
DIGEST = hashlib.sha256(SOURCE.read_bytes()).hexdigest()
ROWS = []


def row(name, old, new, test, source=SOURCE):
    text = source.read_text()
    assert text.count(old) == 1, (name, text.count(old))
    line = text[:text.index(old)].count('\n') + 1
    ROWS.append((name, line, old, new, test, source))


# The round-1 survivors: each mutation removes exactly the named condition.
row('expect-class-cross', "classification === f['expect-rejection']", "classification !== 'unclassified'", 'rejects expected rejection class-cross')
row('adopt-lost-path', ' && minus(oldPaths, newPaths).length === 0', '', 'rejects lost-path regression')
row('stale-ownership', "check(equal(before, fields(live)), 'stale snapshot ownership');", '', 'rejects ownership regression')
row('response-uid', ' && after.metadata.uid === i.snapshot.metadata.uid', '', 'rejects response-uid regression')
row('release-manager-neq', "check(flags.manager !== input.adopter, 'releasing manager equals adopter');", '{}', 'rejects release-manager-neq precisely')
row('adopt-manager-flag', "check(!flags.manager || flags.manager === input.adopter, 'adopting manager mismatch');", '{}', 'rejects adopt-manager-flag precisely')
row('sa-namespace', ' && account.metadata?.namespace === f.namespace', '', 'rejects service account namespace mismatch')
row('sa-kind', "account.kind === 'ServiceAccount' && ", '', 'rejects service account kind mismatch')
row('selected-dup', "check(new Set(input.paths).size === input.paths.length, 'duplicate selected path');", '', 'rejects selected-dup precisely')
row('token-index', "check(/^i:\\d+$/.test(t), 'invalid fieldsV1 index');", '{}', 'rejects token-index precisely')
row('dot-nonempty', 'record(v) && Object.keys(v).length === 0', 'record(v)', 'rejects dot-nonempty precisely')
row('managed-empty', ' && x.metadata.managedFields.length > 0', '', 'inventory rejects empty ownership')
row('allow-subresource', " && (a.subresource ?? '') === e.subresource", '', 'inventory rejects subresource ownership')
row('allow-required', '!a.required || entries.some', 'true || entries.some', 'inventory rejects required ownership')
row('co-ownership', "check(i.paths.every((p) => others.has(p)), 'selected path not owned by another manager');", '', 'rejects unowned selected paths')
row('snapshot-content', "check(equal(projection(live), projection(i.snapshot)), 'stale snapshot');", '', 'rejects content regression')
for key in ['immutable', 'finalizers', 'ownerReferences']:
    row('root-' + key, ", '" + key + "'", '', 'compares root ' + key)
row('all-allow', 'for (const pair of matrix.allow) can(pair, false);', 'can(matrix.allow[0], false);', 'rejects permission second-allow')
row('rules-incomplete', 'review.status.incomplete === false', 'true', 'rejects permission incomplete')
row('rules-denied', "check(!(matches(rule.verbs, verb) && matches(rule.apiGroups, group.join('.'))\n            && (matches(rule.resources, target) || (sub && rule.resources.includes(`*/${sub}`)))), 'permission rules grant denied pair');", '', 'rejects permission named')
for key, test in [('verbs', 'verb-wildcard'), ('apiGroups', 'group-wildcard'), ('resources', 'resource-wildcard')]:
    old = f'matches(rule.{key}, ' + {'verbs': 'verb', 'apiGroups': "group.join('.')", 'resources': 'target'}[key] + ')'
    new = f'rule.{key}.includes(' + {'verbs': 'verb', 'apiGroups': "group.join('.')", 'resources': 'target'}[key] + ')'
    row('rules-' + key + '-wildcard', old, new, 'rejects permission ' + test)
row('paths-required', "check(string(flags['expect-paths']), 'missing --expect-paths');", '', 'rejects expected rejection missing-paths')
row('manager-required', "check(string(flags['expect-conflict-manager']), 'missing --expect-conflict-manager');", '{}', 'rejects expected rejection missing-manager')
row('paths-exact', "check(equal(rejection.paths, f.expectedPaths), 'expected rejection paths mismatch');", '', 'rejects expected rejection paths')
row('conflict-manager', "check(rejection.managers.every((m) => m === f['expect-conflict-manager']), 'expected conflict manager mismatch');", '{}', 'rejects expected rejection manager')
row('allow-extra', "Object.keys(e).every((k) => ['manager', 'operation', 'subresource', 'required'].includes(k))", 'true', 'rejects unknown allowlist keys')
row('matrix-extra', "Object.keys(m).every((k) => ['allow', 'deny'].includes(k))", 'true', 'rejects unknown matrix keys')
row('selected-extra', "Object.keys(selected).every((k) => ['manager', 'paths'].includes(k))", 'true', 'rejects unknown selected keys')
row('delta-extra', "Object.keys(d).every((k) => ['path', 'value', 'deleted'].includes(k))", 'true', 'rejects unknown delta keys')

row('expected-path-shape', "Array.isArray(paths) && paths.length > 0 && paths.every(fieldPath)\n      && new Set(paths).size === paths.length", 'true', 'rejects expected-path input')
row('conflict-count', 'items.length !== Number(conflict[1]) || ', '', 'rejects conflict parser count')
row('conflict-path-parse', '!items.every((m) => fieldPath(m[2].trim()))', 'false', 'rejects conflict parser bad-path')
row('invalid-path-parse', '!paths.length || !paths.every(fieldPath)', 'false', 'rejects invalid-path')
row('rules-shape', "record(rule) && ['verbs', 'resources', 'apiGroups'].every((k) => Array.isArray(rule[k])\n          && rule[k].every((v) => typeof v === 'string'))", 'true', 'rejects rules status bad-rule')

row('unexpected-manager', "check(!flags['expect-conflict-manager'], 'unexpected conflict manager');", '{}', 'rejects unexpected-manager')
row('unexpected-rejection-flags', "check(!flags['expect-paths'] && !flags['expect-conflict-manager'], 'unexpected rejection flags');", '{}', 'rejects unexpected-paths')
row('allow-subresource-type', "(e.subresource === undefined || typeof e.subresource === 'string')\n        && (e.required", "true\n        && (e.required", 'rejects allowlist subresource')
row('allow-required-type', "(e.required === undefined || typeof e.required === 'boolean')", 'true', 'rejects allowlist required')

row('stable-values', 'equal(projection(before), projection(after))', 'true', 'compares root immutable')
row('required-subresource', "e.subresource === (a.subresource ?? '')", 'true', 'inventory rejects required-subresource ownership')
row('required-operation', 'e.operation === a.operation', 'true', 'inventory rejects required-operation ownership')
row('rules-subresource-wildcard', " || (sub && rule.resources.includes(`*/${sub}`))", '', 'rejects permission subresource-wildcard')
row('matrix-subresource', r'(?:\/[a-z*][a-z0-9*-]*)?', '', 'rejects permission subresource')
for key in ['immutable', 'finalizers', 'ownerReferences']:
    row('delta-root-' + key, '|' + key, '', 'compares root ' + key)
row('conflict-prefix', r'^(?:error: |Error from server \(Conflict\): )Apply failed', 'Apply failed', 'rejects conflict parser prefix')
row('invalid-prefix', "if (!stderr.startsWith(prefix) && !/^Error from server \(Invalid\):/.test(stderr)) return null;", '', 'rejects invalid-prefix')

row('invalid-mixed-item', r',\s+(?=[^,:\r\n]+:\s)', r', (?=[A-Za-z_*][\w.\[\]\"/-]*:)', 'rejects invalid-mixed-path')

row('field-path-grammar', "return typeof path === 'string' && ", 'return true || ', 'rejects expected-path input bad-path')

KIND = ROOT / 'deploy/kubernetes/verify-gates-kind.sh'
row('cleanup-cluster-absent', 'if [[ "$remaining" == "$cluster_name" ]]; then', 'if false; then', 'cleanup verifies cluster present', KIND)
row('cleanup-list-success', "echo 'kind cleanup inventory failed' >&2; status=1", ':', 'cleanup verifies cluster list-error', KIND)
row('call-log-control', 'if [[ ! -s "$OK170_CALL_LOG" ]]; then', 'if false; then', 'refuses an empty positive call log', KIND)


def test(name, tool, pattern, source):
    env = {**os.environ, 'OK170_GATE_TOOL' if source == SOURCE else 'OK170_KIND_SCRIPT': str(tool)}
    with (OUT / (name + '.log')).open('w') as output:
        result = subprocess.run(['node_modules/.bin/vitest', 'run', 'deploy/kubernetes/ok170-gates.test.ts', '--config', str(CONFIG), '-t', pattern],
                                cwd=ROOT, env=env, stdout=output, stderr=subprocess.STDOUT)
    return result.returncode, (OUT / (name + '.log')).read_text()


def run(item):
    name, line, old, new, pattern, source = item
    original = source.read_text()
    assert original.count(old) == 1, name
    line = original[:original.index(old)].count('\n') + 1
    target = OUT / (name + source.suffix)
    assert not target.exists(), target
    target.write_text(original.replace(old, new))
    rc, output = test(name, target, pattern, source)
    failures = re.findall(r'^ FAIL  (.+)$', output, re.MULTILINE)
    killed = rc != 0 and bool(failures) and 'AssertionError:' in output
    # Restore the same disposable file and prove its named test passes.
    target.write_text(original)
    restored, _ = test(name + '-restored', target, pattern, source)
    assert hashlib.sha256(SOURCE.read_bytes()).hexdigest() == DIGEST
    status = 'KILLED' if killed and restored == 0 else 'FAILED'
    result = f'{name} | {source.name}:{line} | {pattern} | {status} | restore={restored}'
    print(result, flush=True)
    return status == 'KILLED', result


if __name__ == '__main__':
    names = os.environ.get('OK170_MUTATION_NAMES', '').split(',')
    selected = ROWS if names == [''] else [r for r in ROWS if r[0] in names]
    assert selected, 'no mutation rows selected'
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(run, selected))
    (OUT / 'table.txt').write_text('\n'.join(result for _, result in results) + '\n')
    raise SystemExit(0 if all(ok for ok, _ in results) else 1)
