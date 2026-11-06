#!/usr/bin/env bash
set -Eeuo pipefail

if (( BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 4) )); then
  echo 'verify-local-kind.sh requires Bash 4.4 or newer.' >&2
  echo 'OK_LOCAL_DIAGNOSTIC stage=unknown code=UNKNOWN' >&2
  exit 1
fi

script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
failure_capture_helper="${script_dir}/capture-local-kind-failure.sh"
rendered_manifest=""
port_forward_log=""
port_forward_filter_pid=""
port_forward_filter_fd=""
failure_artifact_dir=""
created_cluster=false
port_forward_pid=""
verification_started_seconds=0
netstat_baseline=""
failure_stage="unknown"
failure_code="UNKNOWN"

cleanup() {
  if [[ -n "${port_forward_pid}" ]]; then
    kill "${port_forward_pid}" 2>/dev/null || true
    wait "${port_forward_pid}" 2>/dev/null || true
  fi
  if [[ -n "${port_forward_filter_fd}" ]]; then
    exec {port_forward_filter_fd}>&-
    port_forward_filter_fd=""
  fi
  if [[ -n "${port_forward_filter_pid}" ]]; then
    wait "${port_forward_filter_pid}" 2>/dev/null || true
    port_forward_filter_pid=""
  fi
  if [[ "${created_cluster}" == true && "${keep_cluster:-false}" != true ]]; then
    kind delete cluster --name "${cluster_name}"
  fi
}

capture_failure() {
  [[ "${created_cluster}" == true ]] || return 0
  if ! command -v timeout >/dev/null; then
    echo 'timeout unavailable; capture skipped' >&2
    return 0
  fi
  if [[ -x "${failure_capture_helper}" ]]; then
    failure_artifact_dir="$(mktemp -d -t ok-console-ok200-failure.XXXXXX 2>/dev/null)"
    if [[ -n "${failure_artifact_dir}" ]]; then
      timeout --signal=TERM --kill-after=1s 29s "${failure_capture_helper}" capture \
        "${failure_artifact_dir}" \
        "${cluster_name:-unknown}" \
        "${local_port:-0}" \
        "${pod_name:-}" \
        "$((SECONDS - verification_started_seconds))" \
        "${port_forward_log:-}" \
        "${netstat_baseline:-}" \
        >/dev/null 2>&1 || true
    fi
  fi
}

on_exit() {
  local original_status="$?" cleanup_status
  trap - EXIT
  set +e
  # A failed forwarder has closed its pipe; drain the sanitizer before taking
  # the artifact snapshot. Keep a live forwarder up for the listener observation.
  if [[ -n "${port_forward_pid}" ]] && ! kill -0 "${port_forward_pid}" 2>/dev/null; then
    if [[ -n "${port_forward_filter_fd}" ]]; then
      exec {port_forward_filter_fd}>&-
      port_forward_filter_fd=""
    fi
    if [[ -n "${port_forward_filter_pid}" ]]; then
      wait "${port_forward_filter_pid}" 2>/dev/null || true
      port_forward_filter_pid=""
    fi
  fi
  if (( original_status != 0 && original_status != 130 && original_status != 143 )); then
    capture_failure
  fi
  cleanup
  cleanup_status="$?"
  if (( original_status == 0 && cleanup_status != 0 )); then
    original_status="${cleanup_status}"
    failure_stage="unknown"
    failure_code="UNKNOWN"
    if (( original_status != 130 && original_status != 143 )); then
      capture_failure
    fi
  fi
  [[ -z "${rendered_manifest}" ]] || rm -f "${rendered_manifest}"
  [[ -z "${port_forward_log}" ]] || rm -f "${port_forward_log}"
  if [[ -n "${failure_artifact_dir}" ]]; then
    printf 'Failure diagnostics: %s\n' "${failure_artifact_dir}" >&2
  fi
  if (( original_status != 0 && original_status != 130 && original_status != 143 )); then
    case "${failure_stage}:${failure_code}" in
      preflight:KIND_NAME_TOO_LONG|kind_inventory:KIND_LIST_FAILED|kind_create:KIND_CONFIG_OR_CREATE_FAILED|image_deploy:IMAGE_OR_DEPLOY_FAILED|temp_file:TEMP_FILE_PREPARATION_FAILED|unknown:UNKNOWN) ;;
      *) failure_stage="unknown"; failure_code="UNKNOWN" ;;
    esac
    printf 'OK_LOCAL_DIAGNOSTIC stage=%s code=%s\n' "${failure_stage}" "${failure_code}" >&2
  fi
  exit "${original_status}"
}

port_forward_filter_is_running() {
  [[ -n "${port_forward_filter_pid}" ]] || return 1
  kill -0 "${port_forward_filter_pid}" 2>/dev/null
}

select_current_pod() {
  local deployment_identity deployment_uid deployment_revision replica_sets
  local rs_name rs_uid rs_revision rs_owner_uid pods remaining_seconds
  local found_pod_name pod_owner_uid pod_ready pod_deletion_timestamp pod_phase
  local rs_uid_to_check timeout_seconds="${1:-120}" poll_interval="${2:-1}" deadline
  local -a deployment_rs_uids=()
  local -a current_rs_uids=()
  local -a current_rs_names=()
  local -a found_replica_sets=()
  local -a leftover_pods=()
  local -a current_pods=()
  local -a ready_pods=()

  deployment_identity="$(kubectl --context "kind-${cluster_name}" --namespace openkubes-console --request-timeout=10s get deployment ok-console -o jsonpath='{.metadata.uid}{"|"}{.metadata.annotations.deployment\.kubernetes\.io/revision}')"
  IFS='|' read -r deployment_uid deployment_revision <<<"${deployment_identity}"
  [[ -n "${deployment_uid}" && -n "${deployment_revision}" ]] || {
    echo "Deployment ok-console has no UID or revision: ${deployment_identity}" >&2
    return 1
  }

  replica_sets="$(kubectl --context "kind-${cluster_name}" --namespace openkubes-console --request-timeout=10s get replicasets -o jsonpath='{range .items[*]}{.metadata.name}{"|"}{.metadata.uid}{"|"}{.metadata.annotations.deployment\.kubernetes\.io/revision}{"|"}{.metadata.ownerReferences[?(@.controller==true)].uid}{"\n"}{end}')"
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
    return 1
  fi
  current_rs_uid="${current_rs_uids[0]}"
  current_rs_name="${current_rs_names[0]}"

  deadline=$((SECONDS + timeout_seconds))
  while true; do
    remaining_seconds=$((deadline - SECONDS))
    if (( remaining_seconds <= 0 )); then
      echo "Timed out after ${timeout_seconds}s waiting for Pods of old ReplicaSets of Deployment ok-console to disappear. Leftover Pods: ${leftover_pods[*]:-none}" >&2
      return 1
    fi
    if ! pods="$(kubectl --context "kind-${cluster_name}" --namespace openkubes-console --request-timeout="${remaining_seconds}s" get pods -o jsonpath='{range .items[*]}{.metadata.name}{"|"}{.metadata.ownerReferences[?(@.controller==true)].uid}{"|"}{.status.conditions[?(@.type=="Ready")].status}{"|"}{.metadata.deletionTimestamp}{"|"}{.status.phase}{"\n"}{end}')"; then
      echo "Failed to list Pods while waiting for old ReplicaSets of Deployment ok-console. Last observed leftover Pods: ${leftover_pods[*]:-not yet observed}" >&2
      return 1
    fi
    leftover_pods=()
    current_pods=()
    ready_pods=()
    while IFS='|' read -r found_pod_name pod_owner_uid pod_ready pod_deletion_timestamp pod_phase; do
      [[ -n "${found_pod_name}" ]] || continue
      if [[ "${pod_owner_uid}" == "${current_rs_uid}" ]]; then
        current_pods+=("${found_pod_name}(Ready=${pod_ready:-unknown},deletionTimestamp=${pod_deletion_timestamp:-none},phase=${pod_phase:-unknown})")
        if [[ "${pod_ready}" == True && -z "${pod_deletion_timestamp}" ]]; then
          ready_pods+=("${found_pod_name}")
        fi
      else
        for rs_uid_to_check in "${deployment_rs_uids[@]}"; do
          if [[ "${pod_owner_uid}" == "${rs_uid_to_check}" ]]; then
            leftover_pods+=("${found_pod_name}")
            break
          fi
        done
      fi
    done <<<"${pods}"
    [[ "${#leftover_pods[@]}" == 0 ]] && break
    if (( SECONDS >= deadline )); then
      echo "Timed out after ${timeout_seconds}s waiting for Pods of old ReplicaSets of Deployment ok-console to disappear. Leftover Pods: ${leftover_pods[*]:-none}" >&2
      return 1
    fi
    sleep "${poll_interval}"
  done
  if [[ "${#current_pods[@]}" != 1 ]]; then
    echo "Expected exactly one Pod of current ReplicaSet ${current_rs_name}; found ${#current_pods[@]}. Current ReplicaSet Pods: ${current_pods[*]:-none}" >&2
    return 1
  fi
  if [[ "${#ready_pods[@]}" != 1 ]]; then
    echo "The single Pod of current ReplicaSet ${current_rs_name} must be Ready and non-terminating. Current ReplicaSet Pod: ${current_pods[0]}" >&2
    return 1
  fi
  pod_name="${ready_pods[0]}"
  echo "Selected Pod ${pod_name} of ReplicaSet ${current_rs_name} (Deployment revision ${deployment_revision})."
}

start_and_wait_for_port_forward() {
  local expected_line observed_line timeout_seconds="${1:-30}" poll_interval="${2:-1}" deadline
  : >"${port_forward_log}"
  exec {port_forward_filter_fd}> >("${failure_capture_helper}" filter-port-forward "${port_forward_log}")
  port_forward_filter_pid="$!"
  kubectl --context "kind-${cluster_name}" \
    --namespace openkubes-console \
    -v=6 port-forward --address 127.0.0.1 "pod/${pod_name}" "${local_port}:8787" \
    >&"${port_forward_filter_fd}" 2>&1 &
  port_forward_pid="$!"
  expected_line="Forwarding from 127.0.0.1:${local_port} -> 8787"
  deadline=$((SECONDS + timeout_seconds))

  while (( SECONDS < deadline )); do
    if ! port_forward_filter_is_running; then
      echo 'port-forward output filter exited before readiness was established.' >&2
      return 1
    fi
    while IFS= read -r observed_line; do
      if [[ "${observed_line}" == "${expected_line}" ]]; then
        if ! port_forward_filter_is_running; then
          echo 'port-forward output filter exited before readiness was established.' >&2
          return 1
        fi
        if ! kill -0 "${port_forward_pid}" 2>/dev/null; then
          echo "kubectl port-forward exited immediately after reporting readiness for 127.0.0.1:${local_port}." >&2
          return 1
        fi
        return 0
      fi
      if [[ "${observed_line}" == 'Forwarding from '* ]]; then
        echo "kubectl port-forward reported an unexpected forwarding endpoint; expected: ${expected_line}" >&2
        return 1
      fi
    done <"${port_forward_log}"
    if ! port_forward_filter_is_running; then
      echo 'port-forward output filter exited before readiness was established.' >&2
      return 1
    fi
    if ! kill -0 "${port_forward_pid}" 2>/dev/null; then
      echo "kubectl port-forward exited before reporting readiness for 127.0.0.1:${local_port}." >&2
      return 1
    fi
    sleep "${poll_interval}"
  done

  echo "Timed out waiting for kubectl port-forward to report: ${expected_line}" >&2
  return 1
}

main() {
  repository_root="$(CDPATH= cd -- "${script_dir}/../.." && pwd)"
  cluster_name="${OK_CONSOLE_KIND_CLUSTER:-ok-console-ok169}"
  keep_cluster="${OK_CONSOLE_KEEP_CLUSTER:-false}"
  local_port="${OK_CONSOLE_LOCAL_PORT:-18787}"
  kind_config="${OK_CONSOLE_KIND_CONFIG:-}"
  isolated_kubeconfig="${OK_CONSOLE_KUBECONFIG:-}"
  minimum_kind_version="${OK_CONSOLE_MIN_KIND_VERSION:-}"
  verification_started_seconds="${SECONDS}"
  trap on_exit EXIT
  source_revision="$(git -C "${repository_root}" rev-parse HEAD 2>/dev/null)"
  short_revision="$(git -C "${repository_root}" rev-parse --short=12 HEAD 2>/dev/null)"
  expected_revision="${OK_CONSOLE_EXPECTED_REVISION:-${source_revision}}"
  default_image="ok-console:ok-169-${short_revision}"
  candidate_image="${OK_CONSOLE_IMAGE:-${default_image}}"
  failure_stage="temp_file"
  failure_code="TEMP_FILE_PREPARATION_FAILED"
  rendered_manifest="$(mktemp -t ok-console-ok169.XXXXXX.yaml 2>/dev/null)"
  port_forward_log="$(mktemp -t ok-console-ok169-port-forward.XXXXXX.log 2>/dev/null)"
  failure_stage="unknown"
  failure_code="UNKNOWN"
[[ -x "${failure_capture_helper}" ]] || {
  echo 'Required local Kind failure-capture helper is missing or not executable.' >&2
  exit 1
}

for command_name in docker kind kubectl curl git; do
  command -v "${command_name}" >/dev/null || {
    echo "Required command not found: ${command_name}" >&2
    exit 1
  }
done

if (( ${#cluster_name} > 50 )); then
  failure_stage="preflight"
  failure_code="KIND_NAME_TOO_LONG"
  echo 'OK_CONSOLE_KIND_CLUSTER must be a lowercase DNS label of at most 50 characters.' >&2
  exit 1
fi
[[ "${cluster_name}" =~ ^[a-z0-9]([a-z0-9-]{0,48}[a-z0-9])?$ ]] || {
  failure_stage="preflight"
  failure_code="UNKNOWN"
  echo 'OK_CONSOLE_KIND_CLUSTER must be a lowercase DNS label of at most 50 characters.' >&2
  exit 1
}
[[ "${local_port}" =~ ^[0-9]{4,5}$ ]] || {
  echo 'OK_CONSOLE_LOCAL_PORT must be a four- or five-digit port.' >&2
  exit 1
}
  if [[ -n "${kind_config}" || -n "${isolated_kubeconfig}" ]]; then
    [[ -n "${kind_config}" && -n "${isolated_kubeconfig}" ]] || {
      echo 'OK_CONSOLE_KIND_CONFIG and OK_CONSOLE_KUBECONFIG must be supplied together.' >&2
      exit 1
    }
    [[ "${kind_config}" == /* && "${isolated_kubeconfig}" == /* && "${kind_config}" != *$'\n'* && "${isolated_kubeconfig}" != *$'\n'* ]] || {
      echo 'Isolated Kind config and kubeconfig paths must be absolute single-line paths.' >&2
      exit 1
    }
    [[ -f "${kind_config}" && ! -L "${kind_config}" ]] || {
      echo 'Isolated Kind config must be an existing regular non-symlink file.' >&2
      exit 1
    }
    [[ ! -e "${isolated_kubeconfig}" && ! -L "${isolated_kubeconfig}" ]] || {
      echo 'Isolated kubeconfig destination already exists; refusing to merge or overwrite it.' >&2
      exit 1
    }
    export KUBECONFIG="${isolated_kubeconfig}"
  fi
  if [[ -n "${minimum_kind_version}" ]]; then
    [[ "${minimum_kind_version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
      echo 'OK_CONSOLE_MIN_KIND_VERSION must use major.minor.patch format.' >&2
      exit 1
    }
    kind_version_output="$(kind version 2>/dev/null)"
    [[ "${kind_version_output}" =~ kind\ v([0-9]+)\.([0-9]+)\.([0-9]+) ]] || {
      echo 'Could not determine the installed Kind version.' >&2
      exit 1
    }
    installed_kind_version="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.${BASH_REMATCH[3]}"
    IFS='.' read -r installed_major installed_minor installed_patch <<<"${installed_kind_version}"
    IFS='.' read -r minimum_major minimum_minor minimum_patch <<<"${minimum_kind_version}"
    if (( 10#${installed_major} < 10#${minimum_major} ||
          (10#${installed_major} == 10#${minimum_major} && 10#${installed_minor} < 10#${minimum_minor}) ||
          (10#${installed_major} == 10#${minimum_major} && 10#${installed_minor} == 10#${minimum_minor} && 10#${installed_patch} < 10#${minimum_patch}) )); then
      echo "Kind ${minimum_kind_version} or newer is required; found ${installed_kind_version}." >&2
      exit 1
    fi
  fi
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

failure_stage="kind_inventory"
failure_code="KIND_LIST_FAILED"
if ! existing_clusters="$(kind get clusters 2>/dev/null)"; then
  echo 'Could not list existing Kind clusters; refusing to create a cluster.' >&2
  exit 1
fi
failure_stage="unknown"
failure_code="UNKNOWN"
if grep -Fxq "${cluster_name}" <<<"${existing_clusters}"; then
  echo "Kind cluster ${cluster_name} already exists; refusing to modify an unowned cluster." >&2
  echo 'Delete it explicitly or select a different OK_CONSOLE_KIND_CLUSTER.' >&2
  exit 1
fi
netstat_baseline="$("${failure_capture_helper}" snapshot-netstat 2>/dev/null || true)"
failure_stage="kind_create"
failure_code="KIND_CONFIG_OR_CREATE_FAILED"
if [[ -n "${kind_config}" ]]; then
  kind create cluster --config "${kind_config}" --name "${cluster_name}" --kubeconfig "${isolated_kubeconfig}" --wait 90s >/dev/null 2>&1
else
  kind create cluster --name "${cluster_name}" --wait 90s >/dev/null 2>&1
fi
created_cluster=true
failure_stage="image_deploy"
failure_code="IMAGE_OR_DEPLOY_FAILED"

if [[ "${candidate_image}" == "${default_image}" ]]; then
  docker build \
    --build-arg "VCS_REF=${source_revision}" \
    --tag "${candidate_image}" \
    "${repository_root}"
fi

if ! docker image inspect "${candidate_image}" >/dev/null 2>&1; then
  docker pull "${candidate_image}" >/dev/null 2>&1
fi
image_revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "${candidate_image}")"
[[ "${image_revision}" == "${expected_revision}" ]] || {
  echo "Image revision ${image_revision} does not match expected revision ${expected_revision}." >&2
  exit 1
}
if [[ "${candidate_image}" != ghcr.io/* ]]; then
  kind load docker-image --name "${cluster_name}" "${candidate_image}" >/dev/null 2>&1
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
select_current_pod
start_and_wait_for_port_forward

# A reported listener can still encounter a transient first-stream failure.
# Bound the probe budget independently of port-forward readiness: at most 30
# attempts of 5 seconds each, with a 1-second pause between attempts (~180s).
for ((attempt = 1; attempt <= 30; attempt++)); do
  if ! port_forward_filter_is_running; then
    echo 'port-forward output filter exited during live health probing.' >&2
    exit 1
  fi
  if ! kill -0 "${port_forward_pid}" 2>/dev/null; then
    echo "kubectl port-forward exited during live health probing for 127.0.0.1:${local_port}." >&2
    exit 1
  fi
  if curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${local_port}/health/live"; then
    if ! port_forward_filter_is_running; then
      echo 'port-forward output filter exited during live health probing.' >&2
      exit 1
    fi
    break
  fi
  if (( attempt == 30 )); then
    echo 'Live health probe failed after 30 attempts (5s per attempt).' >&2
    exit 1
  fi
  sleep 1
done
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
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
