#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export LC_ALL=C

readonly total_cap=262144
readonly command_timeout=3
readonly total_timeout=26

fail() {
  printf '%s\n' "$1" >&2
  exit 2
}

contains_sensitive_marker() {
  local line="$1"
  [[ "${line,,}" =~ (bearer|authorization|kubeconfig|secret|password|token|://|-----begin|apiVersion|clusters:) ]]
}

filter_port_forward() {
  local output_file="$1" line count=0 used=0 klog_error_re normalized_re
  klog_error_re='^([EWI][0-9]{4}[[:space:]][0-9:.]+)[[:space:]]+[0-9]+[[:space:]]+(portforward|round_trippers)\.go:([0-9]+)\]'
  normalized_re='^klog [IWE][0-9]{4} [0-9:.]+ (portforward|round_trippers)\.go:[0-9]+ ((GET|POST|PUT|CONNECT) status=[0-9]{3} elapsed=[0-9]+(\.[0-9]+)? ?(ns|us|ms|s|m|nanoseconds?|microseconds?|milliseconds?|seconds?)|diagnostic=(other|timeout|connection-refused|bind-or-listen-error|upgrade-error))$'
  [[ ! -e "${output_file}" || ! -s "${output_file}" ]] || fail 'port-forward sanitized log already contains data'
  : >"${output_file}"
  while IFS= read -r line || [[ -n "${line}" ]]; do
    ((count += 1))
    (( count <= 4096 )) || continue
    if [[ "${line}" =~ ${normalized_re} ]] ||
       [[ "${line}" =~ ^Forwarding\ from\ (127\.0\.0\.1|0\.0\.0\.0|([0-9]{1,3}\.){3}[0-9]{1,3}|\[[0-9a-fA-F:.]+\]):[0-9]{1,6}\ \-\>\ 8787$ ]] ||
       [[ "${line}" =~ ^Handling\ connection\ for\ (127\.0\.0\.1:[0-9]{1,5}|[0-9]{1,5})$ ]]; then
      if (( used + ${#line} + 1 <= 16384 )); then
        printf '%s\n' "${line}" >>"${output_file}"
        used=$((used + ${#line} + 1))
      fi
      continue
    fi
    # Keep only timestamp, source location, HTTP status and elapsed time from
    # kubectl's verbose port-forward request trace. Discard the URL wholesale.
    if [[ "${line}" =~ ^([IWE][0-9]{4}[[:space:]][0-9:.]+)[[:space:]]+[0-9]+[[:space:]]+portforward\.go:([0-9]+)\]\ GET\ https?://[^[:space:]]+\ \(([0-9]{3})\)\ ([0-9]+(\.[0-9]+)?(ns|us|ms|s|m|nanoseconds?|microseconds?|milliseconds?|seconds?))$ ]]; then
      line="klog ${BASH_REMATCH[1]} portforward.go:${BASH_REMATCH[2]} GET status=${BASH_REMATCH[3]} elapsed=${BASH_REMATCH[4]}"
      if (( used + ${#line} + 1 <= 16384 )); then
        printf '%s\n' "${line}" >>"${output_file}"
        used=$((used + ${#line} + 1))
      fi
      continue
    fi
    if [[ "${line}" =~ ^([IWE][0-9]{4}[[:space:]][0-9:.]+)[[:space:]]+[0-9]+[[:space:]]+round_trippers\.go:([0-9]+)\]\ (GET|POST|PUT|CONNECT)[[:space:]]+https?://[^[:space:]]+[[:space:]]+([0-9]{3})([[:space:]][A-Za-z][A-Za-z[:space:]]+)?[[:space:]]+in[[:space:]]+([0-9]+(\.[0-9]+)?[[:space:]]+(ns|us|ms|nanoseconds?|microseconds?|milliseconds?|seconds?|s))$ ]]; then
      line="klog ${BASH_REMATCH[1]} round_trippers.go:${BASH_REMATCH[2]} ${BASH_REMATCH[3]} status=${BASH_REMATCH[4]} elapsed=${BASH_REMATCH[6]}"
      if (( used + ${#line} + 1 <= 16384 )); then
        printf '%s\n' "${line}" >>"${output_file}"
        used=$((used + ${#line} + 1))
      fi
      continue
    fi
    if [[ "${line}" =~ ${klog_error_re} ]]; then
      local diagnostic_class='other'
      [[ "${line,,}" == *'i/o timeout'* || "${line,,}" == *'timed out'* ]] && diagnostic_class='timeout'
      [[ "${line,,}" == *'connection refused'* ]] && diagnostic_class='connection-refused'
      [[ "${line,,}" == *'address already in use'* || "${line,,}" == *'bind:'* ]] && diagnostic_class='bind-or-listen-error'
      [[ "${line,,}" == *'upgrade'* ]] && diagnostic_class='upgrade-error'
      line="klog ${BASH_REMATCH[1]} ${BASH_REMATCH[2]}.go:${BASH_REMATCH[3]} diagnostic=${diagnostic_class}"
      if (( used + ${#line} + 1 <= 16384 )); then
        printf '%s\n' "${line}" >>"${output_file}"
        used=$((used + ${#line} + 1))
      fi
      continue
    fi
    contains_sensitive_marker "${line}" && continue
    # Normalize known error classes instead of retaining arbitrary error text,
    # which can include request headers or echoed kubeconfig content.
    if [[ "${line}" =~ ^error:\ unable\ to\ forward ]]; then
      line='error: kubectl was unable to forward the requested port (details omitted)'
    elif [[ "${line}" =~ ^error:\ an\ error\ occurred\ forwarding ]]; then
      line='error: kubectl reported a forwarding error (details omitted)'
    elif [[ "${line}" =~ ^error:\ forwarding\ failed ]]; then
      line='error: kubectl reported that forwarding failed (details omitted)'
    elif [[ "${line}" =~ ^error:\ lost\ connection ]]; then
      line='error: kubectl reported a lost port-forward connection (details omitted)'
    elif [[ "${line}" =~ ^error:\ unable\ to\ listen ]]; then
      line='error: kubectl could not listen on the requested port (details omitted)'
    elif [[ "${line}" =~ ^unable\ to\ upgrade\ connection ]]; then
      line='error: kubectl port-forward upgrade failed (details omitted)'
    elif [[ "${line}" =~ ^error\ dialing\ backend: ]]; then
      line='error: kubectl reported a backend connection failure (details omitted)'
    elif [[ "${line}" =~ ^unable\ to\ listen\ on\ port ]]; then
      line='error: kubectl could not listen on the requested port (details omitted)'
    else
      case "${line}" in
        'error: kubectl was unable to forward the requested port (details omitted)'|\
        'error: kubectl reported a forwarding error (details omitted)'|\
        'error: kubectl reported that forwarding failed (details omitted)'|\
        'error: kubectl reported a lost port-forward connection (details omitted)'|\
        'error: kubectl could not listen on the requested port (details omitted)'|\
        'error: kubectl port-forward upgrade failed (details omitted)'|\
        'error: kubectl reported a backend connection failure (details omitted)') ;;
        *) continue ;;
      esac
    fi
    if [[ "${#line}" -le 160 ]]; then
      if (( used + ${#line} + 1 <= 16384 )); then
        printf '%s\n' "${line}" >>"${output_file}"
        used=$((used + ${#line} + 1))
      fi
    fi
  done
}

append_file() {
  local file="$1" content="$2" file_limit="$3" used remaining existing total=0
  used=0
  [[ ! -f "${file}" ]] || used=$(wc -c <"${file}")
  remaining=$((file_limit - used))
  (( remaining > 0 )) || return 0
  # LC_ALL=C makes the byte count and substring bound agree.
  content="${content:0:remaining}"
  for existing in "${artifact_dir}"/*; do
    [[ -f "${existing}" ]] || continue
    total=$((total + $(wc -c <"${existing}")))
  done
  if (( total >= total_cap )); then
    content=''
  elif (( total + ${#content} > total_cap )); then
    content="${content:0:$((total_cap - total))}"
  fi
  if [[ -n "${content}" ]]; then
    printf '%s' "${content}" >>"${file}"
  fi
  return 0
}

sanitize_command_output() {
  local kind="$1" input="$2" line result=''
  local version_re='^(Client Version:|Kustomize Version:|kind v|containerd[[:space:]])[A-Za-z0-9 .:_/-]{1,220}$'
  local listener_re='^LISTEN[[:space:]]+[0-9]+[[:space:]]+[0-9]+[[:space:]]+(\[[0-9a-fA-F:]+\]|[0-9a-fA-F.*:%_-]+):[0-9]{1,5}[[:space:]]+(\[[0-9a-fA-F:]+\]|[0-9a-fA-F.*:%_-]+):(\*|[0-9]{1,5})[[:space:]]*$'
  while IFS= read -r line || [[ -n "${line}" ]]; do
    contains_sensitive_marker "${line}" && continue
    case "${kind}" in
      versions)
        if [[ "${line}" =~ ${version_re} ]]; then
          result+="${line}"$'\n'
        fi
        ;;
      listener)
        if [[ "${line}" =~ ${listener_re} ]]; then
          result+="${line}"$'\n'
        fi
        ;;
    esac
  done <<<"${input}"
  printf '%s' "${result}"
}

run_bounded() {
  local kind="$1" file="$2" budget="$3"; shift 3
  local raw sanitized remaining command_limit
  if (( SECONDS >= deadline )); then
    append_file "${file}" $'skipped: total capture deadline reached\n' "${budget}"
    return 0
  fi
  remaining=$((deadline - SECONDS))
  command_limit="${command_timeout}"
  if (( remaining < command_limit )); then
    command_limit="${remaining}"
  fi
  # The command output stays in memory, is byte-bounded, and is sanitized before
  # any artifact write. stderr is discarded wholesale because it may echo config.
  raw="$(timeout --signal=TERM --kill-after=1s "${command_limit}s" "$@" 2>/dev/null | head -c 32768 || true)"
  sanitized="$(sanitize_command_output "${kind}" "${raw}")"
  [[ -n "${sanitized}" ]] || sanitized=$'unavailable or no allowlisted diagnostic output\n'
  append_file "${file}" "${sanitized}" "${budget}"
}

capture() {
  local output_dir="$1" cluster_name="$2" local_port="$3" pod_name="$4" elapsed="$5" forward_log="$6"
  local context="kind-${cluster_name}" node_container="${cluster_name}-control-plane"
  local start=$SECONDS deadline content netstat_content
  [[ -d "${output_dir}" ]] || fail 'artifact directory must exist'
  [[ "${cluster_name}" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]] || fail 'invalid cluster name'
  [[ "${local_port}" =~ ^[0-9]{4,5}$ ]] || fail 'invalid local port'
  [[ -z "${pod_name}" || "${pod_name}" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || fail 'invalid Pod name'
  [[ "${elapsed}" =~ ^[0-9]+$ ]] || elapsed=unknown
  [[ ! -e "${output_dir}/capture.txt" ]] || fail 'capture artifact already exists'
  artifact_dir="${output_dir}"
  deadline=$((start + total_timeout))
  : >"${output_dir}/capture.txt"
  local capture_started_utc
  capture_started_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  append_file "${output_dir}/capture.txt" "Failure diagnostics for local Kind verification
Capture started UTC: ${capture_started_utc}
Elapsed before capture: ${elapsed}s
Per-command timeout: ${command_timeout}s
Total capture budget: ${total_timeout}s
Aggregate artifact cap: ${total_cap} bytes
" 4096

  : >"${output_dir}/port-forward.txt"
  if [[ -f "${forward_log}" ]]; then
    content="$(head -c 16384 "${forward_log}" 2>/dev/null || true)"
    # The input is already filtered before disk, but re-filter to enforce the
    # allowlist again at the artifact boundary.
    if [[ ! -e "${output_dir}/port-forward.filtered" ]]; then
      printf '%s' "${content}" | filter_port_forward "${output_dir}/port-forward.filtered" >/dev/null 2>&1 || true
    fi
    if [[ -f "${output_dir}/port-forward.filtered" ]]; then
      content="$(cat "${output_dir}/port-forward.filtered")"
      append_file "${output_dir}/port-forward.txt" "${content}" 16384
      rm -f "${output_dir}/port-forward.filtered"
    fi
  else
    append_file "${output_dir}/port-forward.txt" $'no port-forward diagnostic lines captured\n' 16384
  fi

  : >"${output_dir}/listener.txt"
  run_bounded listener "${output_dir}/listener.txt" 32768 ss -ltn "sport = :${local_port}"
  : >"${output_dir}/netstat.txt"
  if [[ -r /proc/net/netstat ]]; then
    netstat_content="$(awk '
      $1 == "TcpExt:" {
        if (header == "") {
          header=$0
          header_count=NF
          for (i=2; i<=header_count; i++) positions[$i]=i
        } else values=$0
      }
      END {
        if (header == "" || values == "") exit 1
        split(values, v)
        a=positions["ListenOverflows"]; b=positions["ListenDrops"]
        if (a == 0 || b == 0) exit 1
        printf "TcpExt ListenOverflows=%s ListenDrops=%s\n", v[a], v[b]
      }
    ' /proc/net/netstat 2>/dev/null || true)"
    [[ "${netstat_content}" =~ ^TcpExt\ ListenOverflows=[0-9]+\ ListenDrops=[0-9]+$ ]] || netstat_content=$'ListenOverflows/ListenDrops unavailable\n'
  else
    netstat_content=$'ListenOverflows/ListenDrops unavailable\n'
  fi
  append_file "${output_dir}/netstat.txt" "${netstat_content}" 8192

  : >"${output_dir}/versions.txt"
  run_bounded versions "${output_dir}/versions.txt" 16384 kubectl version --client
  run_bounded versions "${output_dir}/versions.txt" 16384 kind version
  run_bounded versions "${output_dir}/versions.txt" 16384 docker exec "${node_container}" containerd --version

  : >"${output_dir}/workloads.txt"
  if (( SECONDS < deadline )); then
    content="$(timeout --signal=TERM --kill-after=1s "${command_timeout}s" kubectl --context "${context}" --namespace openkubes-console get pods -o 'jsonpath={range .items[*]}{.metadata.name}{"|"}{.metadata.uid}{"|"}{.metadata.ownerReferences[?(@.controller==true)].uid}{"|"}{.status.phase}{"|"}{.status.conditions[?(@.type=="Ready")].status}{"|"}{.metadata.deletionTimestamp}{"|"}{.metadata.creationTimestamp}{"\n"}{end}' 2>/dev/null | head -c 32768 || true)"
    while IFS='|' read -r name uid owner_uid phase ready deleting created; do
      [[ "${name}" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ && "${uid}" =~ ^[A-Za-z0-9-]+$ && ( -z "${owner_uid}" || "${owner_uid}" =~ ^[A-Za-z0-9-]+$ ) && "${phase}" =~ ^(Pending|Running|Succeeded|Failed|Unknown)$ && "${ready}" =~ ^(True|False|Unknown)$ ]] || continue
      contains_sensitive_marker "${name}" && continue
      contains_sensitive_marker "${uid}" && continue
      contains_sensitive_marker "${owner_uid}" && continue
      [[ -z "${deleting}" || "${deleting}" =~ ^[0-9TZ:.-]+$ ]] || continue
      [[ -z "${created}" || "${created}" =~ ^[0-9TZ:.-]+$ ]] || continue
      append_file "${output_dir}/workloads.txt" "Pod ${name} uid=${uid} ownerRS=${owner_uid:-unknown} phase=${phase} ready=${ready} deleting=${deleting:-none} created=${created:-unknown}
" 49152
    done <<<"${content}"
  fi
  if (( SECONDS < deadline )); then
    content="$(timeout --signal=TERM --kill-after=1s "${command_timeout}s" kubectl --context "${context}" --namespace openkubes-console get replicasets -o 'jsonpath={range .items[*]}{.metadata.name}{"|"}{.metadata.uid}{"|"}{.metadata.ownerReferences[?(@.controller==true)].uid}{"|"}{.metadata.annotations.deployment\.kubernetes\.io/revision}{"|"}{.spec.replicas}{"|"}{.status.replicas}{"|"}{.status.readyReplicas}{"|"}{.status.availableReplicas}{"|"}{.metadata.creationTimestamp}{"\n"}{end}' 2>/dev/null | head -c 32768 || true)"
    while IFS='|' read -r name uid owner_uid revision desired current ready available created; do
      [[ "${name}" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ && "${uid}" =~ ^[A-Za-z0-9-]+$ && ( -z "${owner_uid}" || "${owner_uid}" =~ ^[A-Za-z0-9-]+$ ) && "${revision}" =~ ^[0-9]+$ && "${desired}" =~ ^[0-9]+$ ]] || continue
      contains_sensitive_marker "${name}" && continue
      contains_sensitive_marker "${uid}" && continue
      contains_sensitive_marker "${owner_uid}" && continue
      [[ -z "${current}" || "${current}" =~ ^[0-9]+$ ]] || continue
      [[ -z "${ready}" || "${ready}" =~ ^[0-9]+$ ]] || continue
      [[ -z "${available}" || "${available}" =~ ^[0-9]+$ ]] || continue
      [[ -z "${created}" || "${created}" =~ ^[0-9TZ:.-]+$ ]] || continue
      append_file "${output_dir}/workloads.txt" "ReplicaSet ${name} uid=${uid} ownerDeployment=${owner_uid:-unknown} revision=${revision} desired=${desired} current=${current:-0} ready=${ready:-0} available=${available:-0} created=${created:-unknown}
" 49152
    done <<<"${content}"
  fi
  if [[ ! -s "${output_dir}/workloads.txt" ]]; then
    append_file "${output_dir}/workloads.txt" $'No allowlisted Pod or ReplicaSet state was returned\n' 49152
  fi
  append_file "${output_dir}/capture.txt" "Capture ended UTC: $(date -u +%Y-%m-%dT%H:%M:%SZ)
Capture duration: $((SECONDS - start))s
" 4096
}

case "${1:-}" in
  filter-port-forward)
    [[ "$#" == 2 ]] || fail 'usage: capture-local-kind-failure.sh filter-port-forward OUTPUT'
    filter_port_forward "$2"
    ;;
  capture)
    [[ "$#" == 7 ]] || fail 'usage: capture-local-kind-failure.sh capture DIR CLUSTER PORT POD ELAPSED FORWARD_LOG'
    capture "$2" "$3" "$4" "$5" "$6" "$7"
    ;;
  *)
    fail 'usage: capture-local-kind-failure.sh {filter-port-forward|capture} ...'
    ;;
esac
