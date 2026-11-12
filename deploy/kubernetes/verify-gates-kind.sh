#!/usr/bin/env bash
set -Eeuo pipefail
if (( BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 4) )); then
  echo 'verify-gates-kind.sh requires Bash 4.4 or newer' >&2
  exit 1
fi
: "${KIND_NODE_IMAGE:?KIND_NODE_IMAGE must name the locally built v1.34.1 node image}"
for tool in kind kubectl node; do
  if ! command -v "$tool" >/dev/null; then echo "missing tool: $tool" >&2; exit 1; fi
done
script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(dirname -- "$(dirname -- "$script_dir")")"
mkdir -p "$repo_dir/test-results/ok170-gates"
proof_dir="$(mktemp -d "$repo_dir/test-results/ok170-gates/kind.XXXXXXXX")"
cluster_name="ok170-cx-$(date +%s)-$$-$RANDOM"
context="kind-$cluster_name"
namespace=openkubes-console
export KUBECTL_KUBERC=false
export KUBECONFIG="$proof_dir/kubeconfig"
created=false
completed=false
server_version=''
cleanup() {
  local status="$?"
  trap - EXIT
  if [[ "$created" == true ]]; then
    if ! kind delete cluster --name "$cluster_name" >"$proof_dir/cleanup.log" 2>&1; then
      echo 'kind cleanup failed' >&2
      status=1
    fi
    if kind get clusters >"$proof_dir/clusters-after" 2>"$proof_dir/clusters-after.stderr"; then
      while IFS= read -r remaining; do
        if [[ "$remaining" == "$cluster_name" ]]; then echo 'kind cleanup left cluster present' >&2; status=1; fi
      done <"$proof_dir/clusters-after"
    else
      echo 'kind cleanup inventory failed' >&2; status=1
    fi
  fi
  if (( status == 0 )) && [[ "$completed" == true ]]; then
    printf 'KIND-PROOF PASS %s\n' "$server_version"
  fi
  printf 'Proof logs: %s\n' "$proof_dir" >&2
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if kind get clusters >"$proof_dir/clusters" 2>"$proof_dir/clusters.stderr"; then
  : # An empty inventory may emit kind's "No kind clusters found" diagnostic.
else
  echo 'kind list failed' >&2; exit 1
fi
while IFS= read -r existing; do
  if [[ "$existing" == "$cluster_name" ]]; then echo 'cluster already exists' >&2; exit 1; fi
done <"$proof_dir/clusters"
created=true
kind create cluster --name "$cluster_name" --image "$KIND_NODE_IMAGE" --wait 120s >"$proof_dir/create.log" 2>&1
k() { kubectl --context "$context" --namespace "$namespace" --request-timeout=10s "$@"; }
k version -o json >"$proof_dir/version.json"
server_version="$(node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1])); if(v.clientVersion.gitVersion!=="v1.34.1" || v.serverVersion.gitVersion!=="v1.34.1") process.exit(1); console.log(v.serverVersion.gitVersion)' "$proof_dir/version.json")"
# This helper only builds inputs and retained snapshots. All gate decisions go through the CLI.
fixture() {
  node --input-type=module - "$proof_dir" "$namespace" "$@" <<'JS'
import fs from 'node:fs';
const [dir, ns, action] = process.argv.slice(2);
const write = (name, obj) => fs.writeFileSync(`${dir}/${name}.json`, JSON.stringify(obj));
const read = (name) => JSON.parse(fs.readFileSync(`${dir}/${name}.json`));
const service = { apiVersion: 'v1', kind: 'Service', metadata: { name: 'observed-state-producer', namespace: ns, labels: { app: 'proof' } }, spec: { selector: { app: 'proof' }, ports: [{ port: 80, targetPort: 8080, protocol: 'TCP' }], type: 'ClusterIP' } };
if (action === 'initial') {
  write('namespace', { apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns } });
  write('service', service);
  write('deployment', { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'ok-console', namespace: ns }, spec: { replicas: 0, selector: { matchLabels: { app: 'proof' } }, template: { metadata: { labels: { app: 'proof' } }, spec: { containers: [{ name: 'console', image: 'registry.k8s.io/pause:3.10', env: [{ name: 'FIRST', value: 'one' }, { name: 'SECOND', value: 'two' }], ports: [{ containerPort: 8080 }] }] } } } });
  write('configmap', { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'observed-state-producer-cluster-observations', namespace: ns }, data: { observation: 'stand-in' } });
  const matrix = {};
  for (const sa of ['ok-console', 'observed-state-producer']) {
    write(`sa-${sa}`, { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: sa, namespace: ns } });
    write(`binding-${sa}`, { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', metadata: { name: sa, namespace: ns }, roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'configmap-reader' }, subjects: [{ kind: 'ServiceAccount', name: sa, namespace: ns }] });
    matrix[sa] = { allow: [['get', 'configmaps']], deny: [['get', 'secrets'], ['list', 'secrets'], ['watch', 'secrets'], ['get', 'pods'], ['create', 'deployments.apps'], ['patch', 'deployments.apps'], ['delete', 'pods']] };
  }
  write('matrix', matrix);
  write('rules-review', { apiVersion: 'authorization.k8s.io/v1', kind: 'SelfSubjectRulesReview', spec: { namespace: ns } });
  write('role', { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role', metadata: { name: 'configmap-reader', namespace: ns }, rules: [{ apiGroups: [''], resources: ['configmaps'], verbs: ['get'] }] });
  write('extra-role', { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role', metadata: { name: 'deliberate-extra', namespace: ns }, rules: [{ apiGroups: [''], resources: ['secrets'], verbs: ['get'] }] });
  write('named-role', { ...read('extra-role'), rules: [{ apiGroups: [''], resources: ['secrets'], verbs: ['get'], resourceNames: ['one'] }] });
  write('extra-binding', { ...read('binding-ok-console'), metadata: { name: 'deliberate-extra', namespace: ns }, roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'deliberate-extra' } });
  write('allowlist', { 'Deployment/ok-console': [{ manager: 'ok-172-live', operation: 'Apply', required: true }, { manager: 'kubectl-set', operation: 'Update' }, { manager: 'kube-controller-manager', operation: 'Update', subresource: 'status' }], 'Service/observed-state-producer': [{ manager: 'ok-172-live', operation: 'Apply', required: true }, { manager: 'ok-173-breakglass', operation: 'Apply', required: true }], 'ConfigMap/observed-state-producer-cluster-observations': [{ manager: 'ok-173-breakglass', operation: 'Apply', required: true }] });
} else if (action === 'permissions-r3') {
  for (const [resource, plural, group, verb, name] of [
    ['secret', 'secrets', '', 'get', 'one'], ['sa', 'serviceaccounts', '', 'get', 'ok-console'],
    ['deployments', 'deployments', 'apps', 'delete', 'ok-console'], ['deployments.apps', 'deployments', 'apps', 'delete', 'ok-console'],
  ]) {
    write(`matrix-${resource}`, { 'ok-console': { allow: [['get', 'configmaps']], deny: [[verb, resource]] } });
    write(`named-${resource}`, { ...read('extra-role'), rules: [{ apiGroups: [group], resources: [plural], verbs: [verb], resourceNames: [name] }] });
  }
  for (const [name, resource] of [['pods-only', 'pods'], ['exec-only', 'pods/exec']]) {
    write(name, { ...read('extra-role'), rules: [{ apiGroups: [''], resources: [resource], verbs: ['create'] }] });
  }
  write('allow-exec', { 'ok-console': { allow: [['get', 'configmaps'], ['create', 'pods/exec']], deny: [['get', 'secrets']] } });
  write('deny-exec', { 'ok-console': { allow: [['get', 'configmaps']], deny: [['create', 'pods/exec']] } });
} else if (action === 'ownership') {
  const live = read('snapshot');
  const paths = [];
  function walk(node, path) {
    if (!Object.keys(node).length || Object.hasOwn(node, '.')) {
      if (path[0] === 'f:spec' && path[1] === 'f:selector') paths.push(path);
    }
    for (const [k, v] of Object.entries(node)) if (k !== '.') walk(v, [...path, k]);
  }
  const entry = live.metadata.managedFields.find(e => e.manager === 'ok-172-live' && e.operation === 'Apply');
  walk(entry.fieldsV1, []);
  if (!paths.length) throw Error('fixture does not own selector');
  write('unowned-selected', { 'Service/observed-state-producer': { manager: 'ok-170-acceptance', paths: [['f:spec', 'f:sessionAffinity']] } });
  write('selected', { 'Service/observed-state-producer': { manager: 'ok-170-acceptance', paths } });
  write('adopt', { apiVersion: 'v1', kind: 'Service', metadata: { name: service.metadata.name, namespace: ns }, spec: { selector: service.spec.selector } });
  write('unowned-adopt', { ...read('adopt'), spec: { sessionAffinity: 'None' } });
  const release = structuredClone(service); delete release.spec.selector; write('release', release);
  delete release.spec.ports; write('over-release', release);
  const allow = read('allowlist'); allow['Service/observed-state-producer'].push({ manager: 'ok-170-acceptance', operation: 'Apply' }); write('adopted-allowlist', allow);
} else if (action === 'admission') {
  const cm = read('configmap'); cm.immutable = true; write('immutable', cm);
  write('empty-delta', []); write('immutable-delta', [{ path: '/immutable', value: true }]);
  const dep = read('deployment');
  dep.spec.template.spec.containers[0].image = 'registry.k8s.io/pause:3.9'; write('conflict', dep);
  dep.spec.replicas = 3; write('conflict-two', dep);
  const invalid = read('deployment'); invalid.spec.template.spec.containers[0].ports[0].containerPort = 70000; write('invalid', invalid);
  const approved = read('deployment'); approved.spec.replicas = 1; write('approved', approved);
  write('delta', [{ path: '/spec/replicas', value: 1 }]);
  approved.spec.template.metadata.labels.extra = 'undeclared'; write('extra', approved);
}
JS
}
step_counter=0
step() {
  local number="$1" name="$2" expected="$3" code got
  shift 3
  step_counter=$((step_counter + 1))
  local out="$proof_dir/step-$step_counter.stdout" err="$proof_dir/step-$step_counter.stderr"
  if node "$script_dir/ok170-gates.mjs" "$@" >"$out" 2>"$err"; then code=0; else code=$?; fi
  got="$(node --input-type=module - "$out" "$err" "$code" "${1}" "$name" <<'JS'
import fs from 'node:fs';
const [out, err, code, mode, name] = process.argv.slice(2);
const text = fs.readFileSync(out, 'utf8'), stderr = fs.readFileSync(err, 'utf8');
const lines = text.trim().split('\n');
const passes = lines.filter(x => x.startsWith('PASS '));
const reasons = { 'foreign-manager': 'foreign manager or operation', 'release-before-adoption': 'release before adoption',
  'over-release': 'over-release, under-release or newly owned path', conflict: 'admission rejected: conflict',
  'extra-delta': 'unapproved admission delta', 'extra-permission': 'permission rules grant denied pair', 'missing-namespace': 'missing --namespace',
  'unowned-adopt': 'selected path not owned by another manager', 'immutable-empty': 'unapproved admission delta',
  'exec-without-grant': 'positive permission control failed', 'named-permission': 'permission rules grant denied pair', 'wrong-conflict-path': 'expected rejection paths mismatch',
  'wrong-invalid-path': 'expected rejection paths mismatch' };
const intendedFailure = Boolean(reasons[name]) && stderr === `${reasons[name]}\n`;
if (+code === 0 && stderr === '' && passes.length === 1 && lines.at(-1) === `PASS ${mode}`) console.log('PASS');
else if (+code !== 0 && passes.length === 0 && stderr.trim().split('\n').length === 1 && stderr.trim() && intendedFailure) console.log('FAIL');
else console.log('MALFORMED');
JS
)"
  if [[ "$got" != "$expected" ]]; then
    printf 'STEP %s %s expected=%s got=%s mismatch\n' "$number" "$name" "$expected" "$got" >&2
    exit 1
  fi
  printf 'STEP %s %s expected=%s got=%s ok\n' "$number" "$name" "$expected" "$got"
}
gate() { step "$1" "$2" "$3" "$4" --context "$context" --namespace "$namespace" "${@:5}"; }
snapshot_service() { k get service observed-state-producer --show-managed-fields -o json >"$proof_dir/snapshot.json"; }
snapshot_deployment() { k get deployment ok-console --show-managed-fields -o json >"$proof_dir/deployment-snapshot.json"; }
apply_fixture() { k apply --server-side --force-conflicts=false --field-manager="$1" -f "$proof_dir/$2.json" -o json >"$proof_dir/setup-$2.json"; }
reset_service() {
  k delete service observed-state-producer --ignore-not-found --wait=true >"$proof_dir/reset.log"
  apply_fixture ok-172-live service
  apply_fixture ok-173-breakglass service
  snapshot_service
  fixture ownership
}
fixture initial
apply_fixture ok170-proof namespace
apply_fixture ok-172-live deployment
apply_fixture ok-173-breakglass configmap
k set env deployment/ok-console UPDATE_OWNER=present --field-manager=kubectl-set >"$proof_dir/set-env.log"
k rollout status deployment/ok-console --timeout=60s >"$proof_dir/rollout.log"
reset_service
for f in role sa-ok-console sa-observed-state-producer binding-ok-console binding-observed-state-producer; do apply_fixture ok170-proof "$f"; done
gate 1 baseline PASS ownership-inventory --allowlist "$proof_dir/allowlist.json" --forbid-manager ok-170-acceptance
k label service observed-state-producer foreign=present --field-manager=foreign >"$proof_dir/foreign.log"
gate 1 foreign-manager FAIL ownership-inventory --allowlist "$proof_dir/allowlist.json"
reset_service
gate 2 release-before-adoption FAIL ownership-release --snapshot "$proof_dir/snapshot.json" --selected "$proof_dir/selected.json" --artifact "$proof_dir/release.json" --manager ok-172-live
gate 3 unowned-adopt FAIL ownership-adopt --snapshot "$proof_dir/snapshot.json" --selected "$proof_dir/unowned-selected.json" --artifact "$proof_dir/unowned-adopt.json"
gate 3 adopt-dry-run PASS ownership-adopt --snapshot "$proof_dir/snapshot.json" --selected "$proof_dir/selected.json" --artifact "$proof_dir/adopt.json"
gate 3 adopt-apply PASS ownership-adopt --snapshot "$proof_dir/snapshot.json" --selected "$proof_dir/selected.json" --artifact "$proof_dir/adopt.json" --apply
gate 3 adopted-inventory PASS ownership-inventory --allowlist "$proof_dir/adopted-allowlist.json"
for manager in ok-172-live ok-173-breakglass; do
  snapshot_service
  gate 4 "release-$manager-dry-run" PASS ownership-release --snapshot "$proof_dir/snapshot.json" --selected "$proof_dir/selected.json" --artifact "$proof_dir/release.json" --manager "$manager"
  gate 4 "release-$manager-apply" PASS ownership-release --snapshot "$proof_dir/snapshot.json" --selected "$proof_dir/selected.json" --artifact "$proof_dir/release.json" --manager "$manager" --apply
done
reset_service
gate 4 readopt PASS ownership-adopt --snapshot "$proof_dir/snapshot.json" --selected "$proof_dir/selected.json" --artifact "$proof_dir/adopt.json" --apply
snapshot_service
gate 4 over-release FAIL ownership-release --snapshot "$proof_dir/snapshot.json" --selected "$proof_dir/selected.json" --artifact "$proof_dir/over-release.json" --manager ok-172-live
snapshot_deployment
fixture admission
# Retain the real CLI diagnostics so rejection fixtures can be checked against the producer.
if k apply --server-side --force-conflicts=false --dry-run=server --field-manager=unowned --show-managed-fields -f "$proof_dir/conflict.json" -o json >"$proof_dir/conflict-producer.stdout" 2>"$proof_dir/conflict-producer.stderr"; then
  echo 'conflict fixture unexpectedly accepted' >&2; exit 1
fi
gate 5 conflict FAIL admission --snapshot "$proof_dir/deployment-snapshot.json" --artifact "$proof_dir/conflict.json" --manager unowned --delta "$proof_dir/delta.json"
gate 5 expected-conflict PASS admission --snapshot "$proof_dir/deployment-snapshot.json" --artifact "$proof_dir/conflict.json" --manager unowned --expect-rejection conflict --expect-paths '[".spec.template.spec.containers[name=\"console\"].image"]' --expect-conflict-manager ok-172-live
if k apply --server-side --force-conflicts=false --dry-run=server --field-manager=unowned -f "$proof_dir/conflict-two.json" -o json >"$proof_dir/conflict-two-producer.stdout" 2>"$proof_dir/conflict-two-producer.stderr"; then
  echo 'two-field conflict unexpectedly accepted' >&2; exit 1
fi
cmp "$proof_dir/conflict-two-producer.stderr" "$script_dir/fixtures/ok170-conflict-two.stderr"
gate 5 expected-conflict-two PASS admission --snapshot "$proof_dir/deployment-snapshot.json" --artifact "$proof_dir/conflict-two.json" --manager unowned --expect-rejection conflict --expect-paths '[".spec.replicas",".spec.template.spec.containers[name=\"console\"].image"]' --expect-conflict-manager ok-172-live
gate 5 wrong-conflict-path FAIL admission --snapshot "$proof_dir/deployment-snapshot.json" --artifact "$proof_dir/conflict.json" --manager unowned --expect-rejection conflict --expect-paths '[".spec.replicas"]' --expect-conflict-manager ok-172-live
if k apply --server-side --force-conflicts=false --dry-run=server --field-manager=ok-172-live --show-managed-fields -f "$proof_dir/invalid.json" -o json >"$proof_dir/invalid-producer.stdout" 2>"$proof_dir/invalid-producer.stderr"; then
  echo 'invalid fixture unexpectedly accepted' >&2; exit 1
fi
gate 6 expected-invalid PASS admission --snapshot "$proof_dir/deployment-snapshot.json" --artifact "$proof_dir/invalid.json" --manager ok-172-live --expect-rejection invalid --expect-paths '["spec.template.spec.containers[0].ports[0].containerPort"]'
gate 6 wrong-invalid-path FAIL admission --snapshot "$proof_dir/deployment-snapshot.json" --artifact "$proof_dir/invalid.json" --manager ok-172-live --expect-rejection invalid --expect-paths '["spec.replicas"]'
gate 7 exact-delta PASS admission --snapshot "$proof_dir/deployment-snapshot.json" --artifact "$proof_dir/approved.json" --manager ok-172-live --delta "$proof_dir/delta.json"
gate 7 extra-delta FAIL admission --snapshot "$proof_dir/deployment-snapshot.json" --artifact "$proof_dir/extra.json" --manager ok-172-live --delta "$proof_dir/delta.json"
k get configmap observed-state-producer-cluster-observations --show-managed-fields -o json >"$proof_dir/cm-snapshot.json"
gate 7 immutable-empty FAIL admission --snapshot "$proof_dir/cm-snapshot.json" --artifact "$proof_dir/immutable.json" --manager ok-173-breakglass --delta "$proof_dir/empty-delta.json"
gate 7 immutable-exact PASS admission --snapshot "$proof_dir/cm-snapshot.json" --artifact "$proof_dir/immutable.json" --manager ok-173-breakglass --delta "$proof_dir/immutable-delta.json"
# Retain the real review producer diagnostics alongside admission diagnostics.
if k create --validate=false -f "$proof_dir/rules-review.json" -o json --as="system:serviceaccount:$namespace:ok-console" >"$proof_dir/rules-producer.stdout" 2>"$proof_dir/rules-producer.stderr"; then :; else
  echo 'rules review producer failed' >&2; exit 1
fi
gate 8 permissions PASS permissions --matrix "$proof_dir/matrix.json"
apply_fixture ok170-proof named-role
apply_fixture ok170-proof extra-binding
gate 8 named-permission FAIL permissions --matrix "$proof_dir/matrix.json"
fixture permissions-r3
for resource in secret sa deployments deployments.apps; do
  apply_fixture ok170-proof "named-$resource"
  gate 8 named-permission FAIL permissions --matrix "$proof_dir/matrix-$resource.json"
done
# N1's independent authorization control: the named Deployment really is deletable.
k delete deployment ok-console --dry-run=server --as="system:serviceaccount:$namespace:ok-console" >"$proof_dir/n1-delete-dry-run.stdout"
apply_fixture ok170-proof pods-only
gate 8 exec-without-grant FAIL permissions --matrix "$proof_dir/allow-exec.json"
gate 8 deny-exec-pods-only PASS permissions --matrix "$proof_dir/deny-exec.json"
apply_fixture ok170-proof exec-only
gate 8 allow-exec-granted PASS permissions --matrix "$proof_dir/allow-exec.json"
gate 8 named-permission FAIL permissions --matrix "$proof_dir/deny-exec.json"
apply_fixture ok170-proof extra-role
apply_fixture ok170-proof extra-binding
gate 8 extra-permission FAIL permissions --matrix "$proof_dir/matrix.json"
k delete rolebinding deliberate-extra >"$proof_dir/remove-extra-binding.log"
# The wrapper records ANY kubectl call, including client version. A guard refusal must leave it empty.
if [[ -e "$proof_dir/bin" ]]; then echo 'wrapper directory already exists' >&2; exit 1; fi
mkdir "$proof_dir/bin"
real_kubectl="$(command -v kubectl)"
export OK170_REAL_KUBECTL="$real_kubectl" OK170_CALL_LOG="$proof_dir/missing-namespace.calls"
: >"$OK170_CALL_LOG"
cat >"$proof_dir/bin/kubectl" <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'call\n' >>"$OK170_CALL_LOG"
exec "$OK170_REAL_KUBECTL" "$@"
SH
chmod +x "$proof_dir/bin/kubectl"
# Positive control: the same wrapper and complete target must record calls.
PATH="$proof_dir/bin:$PATH" gate 8 call-log-control PASS permissions --matrix "$proof_dir/matrix.json"
if [[ ! -s "$OK170_CALL_LOG" ]]; then echo 'call log positive control empty' >&2; exit 1; fi
: >"$OK170_CALL_LOG"
PATH="$proof_dir/bin:$PATH" step 8 missing-namespace FAIL permissions --context "$context" --matrix "$proof_dir/matrix.json"
if [[ -s "$OK170_CALL_LOG" ]]; then echo 'guard made a kubectl call' >&2; exit 1; fi
completed=true
