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

# Service selectors can still match terminating Pods from the previous rollout.
# Resolve the current ReplicaSet by Deployment ownership and revision instead.
deployment_identity="$(kubectl --context "kind-${cluster_name}" --namespace openkubes-console --request-timeout=10s get deployment ok-console -o jsonpath='{.metadata.uid}{"|"}{.metadata.annotations.deployment\.kubernetes\.io/revision}')"
IFS='|' read -r deployment_uid deployment_revision <<<"${deployment_identity}"
[[ -n "${deployment_uid}" && -n "${deployment_revision}" ]] || {
  echo "Deployment ok-console has no UID or revision: ${deployment_identity}" >&2
  exit 1
}
replica_sets="$(kubectl --context "kind-${cluster_name}" --namespace openkubes-console --request-timeout=10s get replicasets -o jsonpath='{range .items[*]}{.metadata.name}{"|"}{.metadata.uid}{"|"}{.metadata.annotations.deployment\.kubernetes\.io/revision}{"|"}{.metadata.ownerReferences[?(@.controller==true)].uid}{"\n"}{end}')"
deployment_rs_uids=()
current_rs_uids=()
current_rs_names=()
found_replica_sets=()
while IFS='|' read -r rs_name rs_uid rs_revision rs_owner_uid; do
  [[ "${rs_owner_uid}" == "${deployment_uid}" ]] || continue
  deployment_rs_uids+=("${rs_uid}")
  found_replica_sets+=("${rs_name}(revision=${rs_revision})")
  if [[ "${rs_revision}" == "${deployment_revision}" ]]; then
    current_rs_uids+=("${rs_uid}")
    current_rs_names+=("${rs_name}")
  fi
done <<<"${replica_sets}"
if [[ "${#current_rs_uids[@]}" != 1 ]]; then
  echo "Expected exactly one ReplicaSet for Deployment ok-console revision ${deployment_revision}; found ${#current_rs_uids[@]}. Deployment ReplicaSets: ${found_replica_sets[*]:-none}" >&2
  exit 1
fi
current_rs_uid="${current_rs_uids[0]}"
current_rs_name="${current_rs_names[0]}"

# Wait for every old ReplicaSet's Pods to disappear, including terminating Pods.
old_pods_deadline=$((SECONDS + 120))
leftover_pods=()
while true; do
  remaining_seconds=$((old_pods_deadline - SECONDS))
  if (( remaining_seconds <= 0 )); then
    echo "Timed out after 120s waiting for Pods of old ReplicaSets of Deployment ok-console to disappear. Leftover Pods: ${leftover_pods[*]:-none}" >&2
    exit 1
  fi
  if ! pods="$(kubectl --context "kind-${cluster_name}" --namespace openkubes-console --request-timeout="${remaining_seconds}s" get pods -o jsonpath='{range .items[*]}{.metadata.name}{"|"}{.metadata.ownerReferences[?(@.controller==true)].uid}{"|"}{.status.conditions[?(@.type=="Ready")].status}{"|"}{.metadata.deletionTimestamp}{"|"}{.status.phase}{"\n"}{end}')"
  then
    echo "Failed to list Pods while waiting for old ReplicaSets of Deployment ok-console. Last observed leftover Pods: ${leftover_pods[*]:-not yet observed}" >&2
    exit 1
  fi
  leftover_pods=()
  ready_pods=()
  found_current_pods=()
  while IFS='|' read -r found_pod_name pod_owner_uid pod_ready pod_deletion_timestamp pod_phase; do
    if [[ "${pod_owner_uid}" == "${current_rs_uid}" ]]; then
      found_current_pods+=("${found_pod_name}(Ready=${pod_ready:-unknown},deletionTimestamp=${pod_deletion_timestamp:-none},phase=${pod_phase:-unknown})")
      if [[ "${pod_ready}" == True && -z "${pod_deletion_timestamp}" ]]; then
        ready_pods+=("${found_pod_name}")
      fi
    else
      for rs_uid in "${deployment_rs_uids[@]}"; do
        if [[ "${pod_owner_uid}" == "${rs_uid}" ]]; then
          leftover_pods+=("${found_pod_name}")
          break
        fi
      done
    fi
  done <<<"${pods}"
  if (( SECONDS >= old_pods_deadline )); then
    echo "Timed out after 120s waiting for Pods of old ReplicaSets of Deployment ok-console to disappear. Leftover Pods: ${leftover_pods[*]:-none}" >&2
    exit 1
  fi
  [[ "${#leftover_pods[@]}" == 0 ]] && break
  sleep 1
done
if [[ "${#ready_pods[@]}" != 1 ]]; then
  echo "Expected exactly one Ready, non-terminating Pod of ReplicaSet ${current_rs_name}; found ${#ready_pods[@]}. Current ReplicaSet Pods: ${found_current_pods[*]:-none}" >&2
  exit 1
fi
pod_name="${ready_pods[0]}"
echo "Selected Pod ${pod_name} of ReplicaSet ${current_rs_name} (Deployment revision ${deployment_revision})."

kubectl --context "kind-${cluster_name}" \
  --namespace openkubes-console \
  port-forward "pod/${pod_name}" "${local_port}:8787" \
  >"${port_forward_log}" 2>&1 &
port_forward_pid="$!"

# `kubectl port-forward` can take a few seconds to bind after the process is
# started. Probe until the tunnel is actually usable and
# fail with its captured diagnostics instead of racing the first curl call.
port_forward_ready=false
for _ in $(seq 1 30); do
  if ! kill -0 "${port_forward_pid}" 2>/dev/null; then
    echo 'kubectl port-forward exited before the local probe became ready.' >&2
    cat "${port_forward_log}" >&2
    exit 1
  fi
  if curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${local_port}/health/live" >/dev/null 2>&1; then
    port_forward_ready=true
    break
  fi
  sleep 1
done
if [[ "${port_forward_ready}" != true ]]; then
  echo "Timed out waiting for the local port-forward on ${local_port}." >&2
  cat "${port_forward_log}" >&2
  exit 1
fi

curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${local_port}/health/live"
curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${local_port}/health/ready"
curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${local_port}/" >/dev/null

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
