#!/usr/bin/env bash
# Read-only verification of the ok-shared live overlay against an approved change package.
#
# This script never changes the cluster. It renders and lints the overlay, then uses
# ok170-gates.mjs for a non-forced server-side dry-run of every admitted object, the
# managedFields ownership inventory, and the runtime image identity of the running Pods.
# Objects the gates do not admit are read with kubectl get and must already hold every
# field the overlay renders (a read-only drift check); any difference stops.
# It never passes --apply and never uses --force-conflicts; ok170-gates.mjs pins
# --force-conflicts=false on every dry-run. verify-ok-shared-live.sh, which applies with
# --force-conflicts, is not used by this path.
#
# Usage: verify-ok-shared-readonly.sh <approved-package-dir> <new-output-dir>
#   <approved-package-dir> holds the reviewed inputs:
#     deltas.json           {"Kind/name": [ {path, value}|{path, deleted: true}, ... ]}; objects not
#                           listed must render unchanged (empty delta)
#     allowlist.json        ok170-gates ownership-inventory allowlist; must name exactly the
#                           admitted objects
#     expected-images.json  ok170-gates runtime-identity input
#   <new-output-dir> must not exist; rendered artifacts (from the repository), gate results and
#   SHA256SUMS are written there.
# The kube context is fixed to ok-shared-admin@ok-shared and cannot be overridden.
# Environment: OK170_FIELD_MANAGER (default ok-172-live).
set -euo pipefail

readonly expected_context="ok-shared-admin@ok-shared"
readonly manager="${OK170_FIELD_MANAGER:-ok-172-live}"
readonly namespace="openkubes-console"
readonly here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly overlay="${OK170_OVERLAY:-${here}/overlays/ok-shared-live}"
readonly gates="${here}/ok170-gates.mjs"

stop() { echo "STOP: $*" >&2; exit 1; }

[[ $# -eq 2 ]] || stop "usage: verify-ok-shared-readonly.sh <approved-package-dir> <new-output-dir>"
readonly package="$1" out="$2"
for f in deltas.json allowlist.json expected-images.json; do
  [[ -f "${package}/${f}" && ! -L "${package}/${f}" ]] || stop "approved package is missing ${f}"
done
[[ ! -e "${out}" ]] || stop "output directory already exists"
[[ "${manager}" =~ ^[a-z0-9][a-z0-9.-]*$ ]] || stop "invalid field manager"
python3 -c 'import yaml' 2>/dev/null || stop "python3 with PyYAML is required"

export KUBECTL_KUBERC=false
actual_context="$(kubectl config current-context)"
[[ "${actual_context}" == "${expected_context}" ]] \
  || stop "current context '${actual_context}' is not '${expected_context}'"

mkdir -p "${out}/artifacts" "${out}/results"
# Raw live objects (env, ConfigMap data, managedFields) stay in a private scratch directory that is
# removed on exit; only rendered repository content and value-free gate results reach the output.
snapshots="$(mktemp -d)"
chmod 700 "${snapshots}"
trap 'rm -rf -- "${snapshots}"' EXIT
kubectl kustomize "${overlay}" >"${out}/rendered.yaml"
if grep -Eq 'REPLACE_|\.invalid|sha256:0{64}|image: .+:latest' "${out}/rendered.yaml"; then
  stop "rendered overlay contains an unresolved or mutable deployment identity"
fi
if grep -Eq '^kind: Secret$' "${out}/rendered.yaml"; then
  stop "rendered overlay must not contain Secret values"
fi

# Prepend the same quantity path predicate to the render and drift Python stages.
with_quantity_paths() {
  {
    cat <<'PYTHON'
POD_TEMPLATE = ("spec", "template", "spec")
POD_SPEC_PATHS = {
    ("apps", "Deployment"): POD_TEMPLATE,
    ("apps", "StatefulSet"): POD_TEMPLATE,
    ("apps", "DaemonSet"): POD_TEMPLATE,
    ("apps", "ReplicaSet"): POD_TEMPLATE,
    ("batch", "Job"): POD_TEMPLATE,
    ("batch", "CronJob"): ("spec", "jobTemplate", *POD_TEMPLATE),
    ("", "Pod"): ("spec",),
}
CNPG_CLUSTER = ("postgresql.cnpg.io", "Cluster")

def is_quantity_path(obj, path, default_kind=None, default_api=None):
    if path[-3:-1] not in (("resources", "requests"), ("resources", "limits")) or not isinstance(path[-1], str):
        return False
    if not isinstance(obj, dict):
        return False
    kind = obj.get("kind", default_kind)
    api = obj.get("apiVersion", default_api)
    if not isinstance(kind, str) or not isinstance(api, str):
        return False
    group = api.rpartition("/")[0]
    if not group and api != "v1":
        return False
    if path[:1] == ("items",) and isinstance(path[1], int):
        if (group, kind) == ("", "List"):
            return is_quantity_path(obj["items"][path[1]], path[2:])
        if kind.endswith("List"):
            item_kind = kind[:-4]
            if (group, item_kind) in POD_SPEC_PATHS or (group, item_kind) == CNPG_CLUSTER:
                return is_quantity_path(obj["items"][path[1]], path[2:], item_kind, api)
    if (group, kind) == CNPG_CLUSTER:
        return path[:-3] == ("spec",)
    pod_spec = POD_SPEC_PATHS.get((group, kind))
    return (path[:-5] == pod_spec
            and path[-5] in ("containers", "initContainers", "ephemeralContainers")
            and isinstance(path[-4], int))
PYTHON
    cat
  } | python3 - "$@"
}

# Split the render into one JSON artifact per object the gates admit, and list the rest.
with_quantity_paths "${out}" "${package}/deltas.json" "${namespace}" "${package}/expected-images.json" "${package}/allowlist.json" <<'PY' || stop "render split failed"
import json, os, re, sys, yaml

class RenderedFloat(float):
    pass

class RenderLoader(yaml.SafeLoader):
    pass

def load_rendered_float(loader, node):
    value = RenderedFloat(loader.construct_yaml_float(node))
    value.text = node.value
    return value

RenderLoader.add_constructor("tag:yaml.org,2002:float", load_rendered_float)

def preserve_quantity_text(value, obj, path=()):
    # Keep the original decimal through the JSON handoff to the drift check.
    if isinstance(value, RenderedFloat) and is_quantity_path(obj, path):
        return value.text
    if isinstance(value, dict):
        return {k: preserve_quantity_text(v, obj, (*path, k)) for k, v in value.items()}
    if isinstance(value, list):
        return [preserve_quantity_text(v, obj, (*path, i)) for i, v in enumerate(value)]
    return value

out, deltas_path, namespace, expected_path, allowlist_path = sys.argv[1:6]
admitted = {"Deployment", "Service", "ConfigMap", "Ingress"}
with open(os.path.join(out, "rendered.yaml")) as f:
    objects = [o for o in yaml.load_all(f, Loader=RenderLoader) if o is not None]
with open(deltas_path) as f:
    deltas = json.load(f)
if not isinstance(deltas, dict):
    sys.exit("deltas.json must be an object")
ids, skipped = [], []
for o in objects:
    if not isinstance(o, dict) or not isinstance(o.get("metadata"), dict):
        sys.exit("invalid rendered object")
    oid = f'{o.get("kind")}/{o["metadata"].get("name")}'
    if o.get("kind") not in admitted:
        kind, api, name = o.get("kind"), o.get("apiVersion"), o["metadata"].get("name", "")
        if not (isinstance(kind, str) and re.fullmatch(r"[A-Z][A-Za-z0-9]*", kind) and isinstance(api, str)
                and re.fullmatch(r"([a-z0-9.-]+/)?v[0-9a-z]+", api) and isinstance(name, str) and re.fullmatch(r"[a-z0-9][a-z0-9.:-]*", name)):
            sys.exit("invalid non-admitted object")
        if o["metadata"].get("namespace", namespace) != namespace:
            sys.exit("non-admitted object outside the namespace")
        group, version = api.rsplit("/", 1) if "/" in api else ("", api)
        ref = f"{kind}.{version}.{group}/{name}" if group else f"{kind}/{name}"
        if any(ref == r for r, _ in skipped):
            sys.exit("duplicate rendered object")
        skipped.append((ref, o))
        continue
    if o["metadata"].get("namespace", namespace) != namespace or not re.fullmatch(r"[a-z0-9][a-z0-9.-]*", o["metadata"].get("name", "")):
        sys.exit("rendered object outside the namespace or with an invalid name")
    if oid in ids:
        sys.exit("duplicate rendered object")
    ids.append(oid)
    base = oid.replace("/", "-")
    with open(os.path.join(out, "artifacts", f"{base}.json"), "w") as f:
        json.dump(o, f)
    with open(os.path.join(out, "artifacts", f"{base}.delta.json"), "w") as f:
        json.dump(deltas.get(oid, []), f)
unknown = sorted(set(deltas) - set(ids))
if unknown:
    sys.exit("deltas.json names objects the overlay does not render")
with open(expected_path) as f:
    expected = json.load(f)
if not isinstance(expected, dict):
    sys.exit("expected-images.json must be an object")
deployments = {i for i in ids if i.startswith("Deployment/")}
if set(expected) != deployments:
    sys.exit("expected-images.json must name exactly the rendered Deployments")
with open(os.path.join(out, "admitted.txt"), "w") as f:
    f.write("".join(f"{i}\n" for i in ids))
with open(allowlist_path) as f:
    allowlist = json.load(f)
if not isinstance(allowlist, dict) or set(allowlist) != set(ids):
    sys.exit("allowlist.json must name exactly the admitted objects")
os.makedirs(os.path.join(out, "unadmitted"))
with open(os.path.join(out, "not-admitted.txt"), "w") as f:
    for n, (ref, o) in enumerate(sorted(skipped, key=lambda x: x[0])):
        f.write(f"{ref}\n")
        with open(os.path.join(out, "unadmitted", f"{n:03d}.json"), "w") as g:
            json.dump(preserve_quantity_text(o, o), g)
PY

kube=(kubectl --context "${expected_context}" --namespace "${namespace}" --request-timeout=10s)
gate() { node "${gates}" "$1" --context "${expected_context}" --namespace "${namespace}" "${@:2}"; }

gate ownership-inventory --allowlist "${package}/allowlist.json" >"${out}/results/ownership-inventory.txt" \
  || stop "ownership inventory (managedFields) is not clean for ${manager}"

while IFS= read -r id; do
  base="${id/\//-}"
  "${kube[@]}" get "${id}" --show-managed-fields -o json >"${snapshots}/${base}.json" \
    || stop "cannot read live ${id}"
  gate admission --snapshot "${snapshots}/${base}.json" --artifact "${out}/artifacts/${base}.json" \
    --manager "${manager}" --delta "${out}/artifacts/${base}.delta.json" >"${out}/results/admission-${base}.txt" \
    || stop "non-forced server-side dry-run of ${id} is not exactly the approved delta for ${manager}"
done <"${out}/admitted.txt"

n=0
while IFS= read -r ref; do
  "${kube[@]}" get "${ref}" -o json >"${snapshots}/unadmitted-$(printf '%03d' "${n}").json" \
    || stop "cannot read live ${ref}"
  n=$((n + 1))
done <"${out}/not-admitted.txt"
with_quantity_paths "${out}" "${snapshots}" <<'PY' >"${out}/results/unadmitted-drift.txt" || stop "an object the gates do not admit differs from the live cluster (see results/unadmitted-drift.txt)"
import json, os, re, sys
from decimal import Decimal, DecimalException, localcontext

out, snapshots = sys.argv[1], sys.argv[2]
MISSING = object()
DECIMAL_SCALE = {"n": -9, "u": -6, "m": -3, "": 0, "k": 3, "M": 6, "G": 9, "T": 12, "P": 15, "E": 18}
BINARY_SCALE = {f"{unit}i": 2 ** (10 * i) for i, unit in enumerate("KMGTPE", 1)}
QUANTITY = re.compile(r"([+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+))([eE][+-]?[0-9]+|[numkMGTPE]|[KMGTPE]i)?")

class JsonFloat(float):
    def __new__(cls, text):
        value = super().__new__(cls, text)
        value.text = text
        return value

def quantity(value):
    if isinstance(value, JsonFloat):
        value = value.text
    match = QUANTITY.fullmatch(str(value))
    if match is None:
        return None
    number, suffix = match.groups(default="")
    try:
        if suffix in BINARY_SCALE:
            mantissa = Decimal(number)
            with localcontext() as ctx:
                # Even the largest binary multiplier (2**60) adds at most 19 digits.
                ctx.prec = len(mantissa.as_tuple().digits) + 19
                return mantissa * BINARY_SCALE[suffix]
        scale = DECIMAL_SCALE.get(suffix)
        if scale is None:
            scale = int(suffix[1:])
            if not -(2 ** 31) <= scale < 2 ** 31:
                return None
        return Decimal(f"{number}e{scale}")
    except (DecimalException, ValueError):
        return None

def same_quantity(want, have):
    expected, actual = quantity(want), quantity(have)
    return expected is not None and actual is not None and expected == actual

def diff(want, have, obj, path, found):
    field = "/" + "/".join(map(str, path))
    if is_quantity_path(obj, path):
        if not same_quantity(want, have):
            found.append(field)
    elif isinstance(want, dict):
        if not isinstance(have, dict):
            found.append(field); return
        for k, v in want.items():
            if path == () and k in ("status",):
                continue
            if path == ("metadata",) and k == "namespace":
                continue
            diff(v, have.get(k, MISSING), obj, (*path, k), found)
    elif isinstance(want, list):
        if not isinstance(have, list) or len(have) != len(want):
            found.append(field); return
        for i, (w, h) in enumerate(zip(want, have)):
            diff(w, h, obj, (*path, i), found)
    elif want != have or type(want) is not type(have):
        found.append(field)
failed = False
names = sorted(os.listdir(os.path.join(out, "unadmitted")))
refs = open(os.path.join(out, "not-admitted.txt")).read().split()
for name, ref in zip(names, refs):
    want = json.load(open(os.path.join(out, "unadmitted", name)), parse_float=JsonFloat)
    have = json.load(open(os.path.join(snapshots, f"unadmitted-{name}")), parse_float=JsonFloat)
    found = []
    if have.get("kind") != want["kind"] or have.get("metadata", {}).get("name") != want["metadata"]["name"]:
        found.append("identity")
    else:
        diff(want, have, want, (), found)
    print(f"{ref}\t{'unchanged' if not found else 'DRIFT ' + ' '.join(found)}")
    failed = failed or bool(found)
sys.exit(1 if failed else 0)
PY

gate runtime-identity --expected "${package}/expected-images.json" >"${out}/results/runtime-identity.txt" \
  || stop "running Pods do not match the approved images"

(cd "${out}" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum >SHA256SUMS)
echo "VERIFY_READONLY=PASS manager=${manager} admitted=$(wc -l <"${out}/admitted.txt") not_admitted=$(wc -l <"${out}/not-admitted.txt")"
