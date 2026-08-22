#!/usr/bin/env bash
set -euo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
repository_root="$(CDPATH= cd -- "${script_dir}/../.." && pwd)"
cluster_name="${OK_CONSOLE_KIND_CLUSTER:-ok-console-ok169}"
keep_cluster="${OK_CONSOLE_KEEP_CLUSTER:-false}"
local_port="${OK_CONSOLE_LOCAL_PORT:-18787}"
source_revision="$(git -C "${repository_root}" rev-parse HEAD)"
short_revision="$(git -C "${repository_root}" rev-parse --short=12 HEAD)"
expected_revision="${OK_CONSOLE_EXPECTED_REVISION:-${source_revision}}"
default_image="ok-console:ok-169-${short_revision}"
candidate_image="${OK_CONSOLE_IMAGE:-${default_image}}"
rendered_manifest="$(mktemp -t ok-console-ok169.XXXXXX.yaml)"
port_forward_log="$(mktemp -t ok-console-ok169-port-forward.XXXXXX.log)"
created_cluster=false
port_forward_pid=""

cleanup() {
  if [[ -n "${port_forward_pid}" ]]; then
    kill "${port_forward_pid}" 2>/dev/null || true
    wait "${port_forward_pid}" 2>/dev/null || true
  fi
  rm -f "${rendered_manifest}" "${port_forward_log}"
  if [[ "${created_cluster}" == true && "${keep_cluster}" != true ]]; then
    kind delete cluster --name "${cluster_name}"
  fi
}
trap cleanup EXIT

for command_name in docker kind kubectl curl git; do
  command -v "${command_name}" >/dev/null || {
    echo "Required command not found: ${command_name}" >&2
    exit 1
  }
done

[[ "${cluster_name}" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]] || {
  echo 'OK_CONSOLE_KIND_CLUSTER must be a bounded lowercase name.' >&2
  exit 1
}
[[ "${local_port}" =~ ^[0-9]{4,5}$ ]] || {
  echo 'OK_CONSOLE_LOCAL_PORT must be a four- or five-digit port.' >&2
  exit 1
}
[[ "${candidate_image}" =~ ^[A-Za-z0-9._/@:-]+$ ]] || {
  echo 'OK_CONSOLE_IMAGE contains unsupported characters.' >&2
  exit 1
}
if [[ "${candidate_image}" == ghcr.io/* && ! "${candidate_image}" =~ @sha256:[a-f0-9]{64}$ ]]; then
  echo 'GHCR candidates must be selected by immutable sha256 digest.' >&2
  exit 1
fi
if [[ "${candidate_image}" == "${default_image}" ]] && [[ -n "$(git -C "${repository_root}" status --porcelain --untracked-files=normal)" ]]; then
  echo 'Refusing to label a local image from a dirty worktree as an exact source revision.' >&2
  exit 1
fi

if kind get clusters | grep -Fxq "${cluster_name}"; then
  echo "Kind cluster ${cluster_name} already exists; refusing to modify an unowned cluster." >&2
  echo 'Delete it explicitly or select a different OK_CONSOLE_KIND_CLUSTER.' >&2
  exit 1
fi
kind create cluster --name "${cluster_name}" --wait 90s
created_cluster=true

if [[ "${candidate_image}" == "${default_image}" ]]; then
  docker build \
    --build-arg "VCS_REF=${source_revision}" \
    --tag "${candidate_image}" \
    "${repository_root}"
fi

if ! docker image inspect "${candidate_image}" >/dev/null 2>&1; then
  docker pull "${candidate_image}"
fi
image_revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "${candidate_image}")"
[[ "${image_revision}" == "${expected_revision}" ]] || {
  echo "Image revision ${image_revision} does not match expected revision ${expected_revision}." >&2
  exit 1
}
if [[ "${candidate_image}" != ghcr.io/* ]]; then
  kind load docker-image --name "${cluster_name}" "${candidate_image}"
fi

kubectl kustomize "${script_dir}/overlays/local-kind" \
  | sed "s|ok-console:ok-169-local|${candidate_image}|g" \
  > "${rendered_manifest}"

grep -Fq "image: ${candidate_image}" "${rendered_manifest}"
if grep -Eq 'sha256:0{64}|\.invalid|REPLACE_|secretName:' "${rendered_manifest}"; then
  echo 'Rendered local manifest retained a production safety placeholder or Secret dependency.' >&2
  exit 1
fi

kubectl --context "kind-${cluster_name}" apply -f "${rendered_manifest}"
kubectl --context "kind-${cluster_name}" \
  --namespace openkubes-console \
  rollout status deployment/ok-console --timeout=120s

deployed_image="$(kubectl --context "kind-${cluster_name}" --namespace openkubes-console get deployment ok-console -o jsonpath='{.spec.template.spec.containers[0].image}')"
[[ "${deployed_image}" == "${candidate_image}" ]]
runtime_security="$(kubectl --context "kind-${cluster_name}" --namespace openkubes-console get deployment ok-console -o jsonpath='{.spec.template.spec.automountServiceAccountToken} {.spec.template.spec.securityContext.runAsNonRoot} {.spec.template.spec.containers[0].securityContext.readOnlyRootFilesystem} {.spec.template.spec.containers[0].securityContext.allowPrivilegeEscalation} {.spec.template.spec.containers[0].securityContext.capabilities.drop[0]}')"
[[ "${runtime_security}" == 'false true true false ALL' ]]

kubectl --context "kind-${cluster_name}" --namespace openkubes-console rollout restart deployment/ok-console
kubectl --context "kind-${cluster_name}" --namespace openkubes-console rollout status deployment/ok-console --timeout=120s

kubectl --context "kind-${cluster_name}" \
  --namespace openkubes-console \
  port-forward service/ok-console "${local_port}:8787" \
  >"${port_forward_log}" 2>&1 &
port_forward_pid="$!"

curl --fail --silent --show-error --retry 20 --retry-all-errors --retry-delay 1 "http://127.0.0.1:${local_port}/health/live"
curl --fail --silent --show-error "http://127.0.0.1:${local_port}/health/ready"
curl --fail --silent --show-error "http://127.0.0.1:${local_port}/" >/dev/null

pod_name="$(kubectl --context "kind-${cluster_name}" --namespace openkubes-console get pod -l app.kubernetes.io/name=ok-console -o jsonpath='{.items[0].metadata.name}')"
runtime_image_id="$(kubectl --context "kind-${cluster_name}" --namespace openkubes-console get pod "${pod_name}" -o jsonpath='{.status.containerStatuses[0].imageID}')"
runtime_node_env="$(kubectl --context "kind-${cluster_name}" --namespace openkubes-console exec "${pod_name}" -- /nodejs/bin/node -e "process.stdout.write(process.env.NODE_ENV)")"

cat <<EOF
OK-169 local Kubernetes deployment proof passed.
Source revision: ${source_revision}
Verified image revision: ${image_revision}
Requested image: ${candidate_image}
Runtime image ID: ${runtime_image_id}
Runtime NODE_ENV: ${runtime_node_env}
Runtime security: ${runtime_security}
Console URL during verification: http://127.0.0.1:${local_port}
Cluster retained: ${keep_cluster}
EOF
