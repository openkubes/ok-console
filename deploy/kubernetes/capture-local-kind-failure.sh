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
  [[ "${line,,}" =~ (bearer|authorization|kubeconfig|secret|password|token|://|-----begin|apiversion|clusters:) ]]
}

filter_port_forward() {
  local output_file="$1" line count=0 used=0 klog_error_re normalized_re structured_response_re
  local diagnostic_class diagnostic_stamp diagnostic_source diagnostic_line lower path_class response_url response_path
  klog_error_re='^([IWEF][0-9]{4}[[:space:]][0-9:.]+)[[:space:]]+[0-9]+[[:space:]]+(portforward|round_trippers|httpstream|spdy|fallback_dialer|tunneling_dialer|helpers|memcache)\.go:([0-9]+)\]'
  normalized_re='^klog [IWEF][0-9]{4} [0-9:.]+ (portforward|round_trippers|httpstream|spdy|fallback_dialer|tunneling_dialer|helpers|memcache)\.go:[0-9]+ ((GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|CONNECT) (path=(pod-portforward|core-api|grouped-api|version|other) status=([0-9]{3}|none|unavailable) milliseconds=[0-9]+|(path=(pod-portforward|core-api|grouped-api|version|other) )?status=[0-9]{3} elapsed=[0-9]+(\.[0-9]+)? ?(ns|us|ms|s|m|nanoseconds?|microseconds?|milliseconds?|seconds?))|diagnostic=(other|connection-refused|connection-reset|i/o-timeout|eof|upgrade-failed|websocket-upgrade-start|websocket-upgrade-complete|fallback-to-spdy|tls-x509|tls|bind-or-listen-error))$'
  structured_response_re='^([IWEF][0-9]{4}[[:space:]][0-9:.]+)[[:space:]]+[0-9]+[[:space:]]+round_trippers\.go:([0-9]+)\][[:space:]]+"Response"[[:space:]]+verb="(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|CONNECT)"[[:space:]]+url="(https?://[^"[:space:]]+)"[[:space:]]+status="(([0-9]{3})([[:space:]][^"]*)?)?"[[:space:]]+milliseconds=([0-9]+)$'
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
    # kubectl 1.30+ uses structured logging. Classify the path without retaining
    # its host, object names, query string, or any URL-derived value.
    if [[ "${line}" =~ ${structured_response_re} ]]; then
      response_url="${BASH_REMATCH[4]}"
      response_path="${response_url#*://}"
      response_path="${response_path%%\?*}"
      if [[ "${response_path}" == */* ]]; then
        response_path="/${response_path#*/}"
      else
        response_path='/'
      fi
      case "${response_path}" in
        */portforward) path_class='pod-portforward' ;;
        /api|/api/*) path_class='core-api' ;;
        /apis|/apis/*) path_class='grouped-api' ;;
        /version) path_class='version' ;;
        *) path_class='other' ;;
      esac
      line="klog ${BASH_REMATCH[1]} round_trippers.go:${BASH_REMATCH[2]} ${BASH_REMATCH[3]} path=${path_class} status=${BASH_REMATCH[6]:-unavailable} milliseconds=${BASH_REMATCH[8]}"
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
    # Older kubectl releases omit the status between the URL and "in" when no
    # response was received. Preserve the request shape and timing without its URL.
    if [[ "${line}" =~ ^([IWE][0-9]{4}[[:space:]][0-9:.]+)[[:space:]]+[0-9]+[[:space:]]+round_trippers\.go:([0-9]+)\][[:space:]]+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|CONNECT)[[:space:]]+(https?://[^[:space:]]+)[[:space:]]{2,}in[[:space:]]+([0-9]+)[[:space:]]+milliseconds$ ]]; then
      response_url="${BASH_REMATCH[4]}"
      response_path="${response_url#*://}"
      response_path="${response_path%%\?*}"
      if [[ "${response_path}" == */* ]]; then
        response_path="/${response_path#*/}"
      else
        response_path='/'
      fi
      case "${response_path}" in
        */portforward) path_class='pod-portforward' ;;
        /api|/api/*) path_class='core-api' ;;
        /apis|/apis/*) path_class='grouped-api' ;;
        /version) path_class='version' ;;
        *) path_class='other' ;;
      esac
      line="klog ${BASH_REMATCH[1]} round_trippers.go:${BASH_REMATCH[2]} ${BASH_REMATCH[3]} path=${path_class} status=none milliseconds=${BASH_REMATCH[5]}"
      if (( used + ${#line} + 1 <= 16384 )); then
        printf '%s\n' "${line}" >>"${output_file}"
        used=$((used + ${#line} + 1))
      fi
      continue
    fi
    if [[ "${line}" =~ ^([IWE][0-9]{4}[[:space:]][0-9:.]+)[[:space:]]+[0-9]+[[:space:]]+round_trippers\.go:([0-9]+)\]\ (GET|POST|PUT|CONNECT)[[:space:]]+(https?://[^[:space:]]+)[[:space:]]+([0-9]{3})([[:space:]][A-Za-z][A-Za-z[:space:]]+)?[[:space:]]+in[[:space:]]+([0-9]+(\.[0-9]+)?[[:space:]]+(ns|us|ms|nanoseconds?|microseconds?|milliseconds?|seconds?|s))$ ]]; then
      response_url="${BASH_REMATCH[4]}"
      response_path="${response_url#*://}"
      response_path="${response_path%%\?*}"
      if [[ "${response_path}" == */* ]]; then
        response_path="/${response_path#*/}"
      else
        response_path='/'
      fi
      case "${response_path}" in
        */portforward) path_class='pod-portforward' ;;
        /api|/api/*) path_class='core-api' ;;
        /apis|/apis/*) path_class='grouped-api' ;;
        /version) path_class='version' ;;
        *) path_class='other' ;;
      esac
      line="klog ${BASH_REMATCH[1]} round_trippers.go:${BASH_REMATCH[2]} ${BASH_REMATCH[3]} path=${path_class} status=${BASH_REMATCH[5]} elapsed=${BASH_REMATCH[7]}"
      if (( used + ${#line} + 1 <= 16384 )); then
        printf '%s\n' "${line}" >>"${output_file}"
        used=$((used + ${#line} + 1))
      fi
      continue
    fi
    if [[ "${line}" =~ ${klog_error_re} ]]; then
      diagnostic_class='other'
      diagnostic_stamp="${BASH_REMATCH[1]}"
      diagnostic_source="${BASH_REMATCH[2]}"
      diagnostic_line="${BASH_REMATCH[3]}"
      lower="${line,,}"
      if [[ "${lower}" == *'connection refused'* ]]; then
        diagnostic_class='connection-refused'
      elif [[ "${lower}" == *'connection reset'* || "${lower}" == *'reset by peer'* ]]; then
        diagnostic_class='connection-reset'
      elif [[ "${lower}" == *'i/o timeout'* || "${lower}" == *'timed out'* ]]; then
        diagnostic_class='i/o-timeout'
      elif [[ "${diagnostic_source}" == tunneling_dialer && "${lower}" == *'before websocket upgrade connection'* ]]; then
        diagnostic_class='websocket-upgrade-start'
      elif [[ "${diagnostic_source}" == tunneling_dialer && "${lower}" == *'negotiation complete'* ]]; then
        diagnostic_class='websocket-upgrade-complete'
      # Kubernetes v1.37.1 (the fixture binary) logs "Before WebSocket Upgrade Connection..."
      # and "Negotiation complete" at tunneling_dialer.go:120 and :130. These mark
      # upgrade start and successful negotiation, not fallback. Both cited files are
      # byte-identical at v1.37.0. See
      # https://github.com/kubernetes/kubernetes/blob/v1.37.1/staging/src/k8s.io/client-go/tools/portforward/tunneling_dialer.go
      # The separate fallback_dialer.go message is "fallback to secondary dialer
      # from primary dialer err: %v" and keeps the fallback-to-spdy classification:
      # https://github.com/kubernetes/kubernetes/blob/v1.37.1/staging/src/k8s.io/client-go/tools/portforward/fallback_dialer.go
      elif [[ "${lower}" == *'fallback to spdy'* || ( "${diagnostic_source}" == fallback_dialer && "${lower}" == *'fallback to '* ) ]]; then
        diagnostic_class='fallback-to-spdy'
      elif [[ "${lower}" == *'address already in use'* || "${lower}" == *'bind:'* ]]; then
        diagnostic_class='bind-or-listen-error'
      elif [[ "${lower}" == *'x509:'* || "${lower}" == *'x.509'* ]]; then
        diagnostic_class='tls-x509'
      elif [[ "${lower}" =~ (^|[^[:alnum:]_])tls([^[:alnum:]_]|$) ]]; then
        diagnostic_class='tls'
      elif [[ "${lower}" == *'upgrade'* ]]; then
        diagnostic_class='upgrade-failed'
      elif [[ "${lower}" =~ (^|[^[:alnum:]_])eof([^[:alnum:]_]|$) ]]; then
        diagnostic_class='eof'
      fi
      line="klog ${diagnostic_stamp} ${diagnostic_source}.go:${diagnostic_line} diagnostic=${diagnostic_class}"
      if (( used + ${#line} + 1 <= 16384 )); then
        printf '%s\n' "${line}" >>"${output_file}"
        used=$((used + ${#line} + 1))
      fi
      continue
    fi
    # Keep a safe readiness-shaped marker for malformed Forwarding lines. The
    # verifier can then reject the unexpected endpoint immediately.
    if [[ "${line}" =~ ^Forwarding\ from\ (127\.0\.0\.1|0\.0\.0\.0|([0-9]{1,3}\.){3}[0-9]{1,3}|\[[0-9a-fA-F:.]+\]):([0-9]{1,6})(.*)$ ]]; then
      line="Forwarding from ${BASH_REMATCH[1]}:${BASH_REMATCH[3]} -> unexpected endpoint"
      if (( used + ${#line} + 1 <= 16384 )); then
        printf '%s\n' "${line}" >>"${output_file}"
        used=$((used + ${#line} + 1))
      fi
      continue
    fi
    # Normalize known error classes instead of retaining arbitrary error text,
    # which can include request headers or echoed kubeconfig content. Do this
    # before the generic sensitive-marker drop so safe fixed text survives.
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
    elif [[ "${line}" =~ ^error:[[:space:]]+(error[[:space:]]+)?upgrading[[:space:]]+connection ]] ||
         [[ "${line}" =~ ^error[[:space:]]+upgrading[[:space:]]+connection ]]; then
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
    contains_sensitive_marker "${line}" && continue
    if [[ "${#line}" -le 160 ]]; then
      if (( used + ${#line} + 1 <= 16384 )); then
        printf '%s\n' "${line}" >>"${output_file}"
        used=$((used + ${#line} + 1))
      fi
    fi
  done
}

remaining_seconds() {
  printf '%s\n' "$((deadline - SECONDS))"
}

snapshot_netstat() {
  local counters
  if [[ -r /proc/net/netstat ]]; then
    counters="$(awk '
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
        if (a == 0 || b == 0 || v[a] !~ /^[0-9]+$/ || v[b] !~ /^[0-9]+$/) exit 1
        printf "TcpExt ListenOverflows=%s ListenDrops=%s\n", v[a], v[b]
      }
    ' /proc/net/netstat 2>/dev/null || true)"
  fi
  if [[ "${counters:-}" =~ ^TcpExt\ ListenOverflows=[0-9]+\ ListenDrops=[0-9]+$ ]]; then
    printf '%s\n' "${counters}"
  else
    printf '%s\n' 'TcpExt ListenOverflows=unavailable ListenDrops=unavailable'
  fi
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
  # Artifacts are line-oriented. If either byte cap cut through a line, keep
  # only the complete LF-terminated prefix (or nothing if no full line fits).
  if [[ -n "${content}" && "${content}" != *$'\n' ]]; then
    if [[ "${content}" == *$'\n'* ]]; then
      content="${content%$'\n'*}"$'\n'
    else
      content=''
    fi
  fi
  if [[ -n "${content}" ]]; then
    printf '%s' "${content}" >>"${file}"
  fi
  return 0
}

sanitize_command_output() {
  local kind="$1" input="$2" line result=''
  local version_re='^(Client Version:|Kustomize Version:|kind v|containerd[[:space:]])[A-Za-z0-9 .:_/-]{1,220}$'
  local legacy_client_re='^Client Version:[[:space:]]+version\.Info\{[^}]*GitVersion:"(v[0-9]+\.[0-9]+\.[0-9]+[A-Za-z0-9.+-]*)"[^}]*\}$'
  local listener_re='^LISTEN[[:space:]]+[0-9]+[[:space:]]+[0-9]+[[:space:]]+(\[[0-9a-fA-F:]+\]|[0-9a-fA-F.*:%_-]+):[0-9]{1,5}[[:space:]]+(\[[0-9a-fA-F:]+\]|[0-9a-fA-F.*:%_-]+):(\*|[0-9]{1,5})[[:space:]]*$'
  while IFS= read -r line || [[ -n "${line}" ]]; do
    contains_sensitive_marker "${line}" && continue
    case "${kind}" in
      versions)
        if [[ "${line}" =~ ${version_re} ]]; then
          result+="${line}"$'\n'
        elif [[ "${line}" =~ ${legacy_client_re} ]]; then
          result+="Client Version: ${BASH_REMATCH[1]}"$'\n'
        fi
        ;;
      listener)
        if [[ "${line}" =~ ${listener_re} ]]; then
          result+="${line}"$'\n'
        fi
        ;;
    esac
  done <<<"${input}"
  # Callers preserve this trailing newline across command substitution with a
  # sentinel; otherwise Bash removes every final line ending from the value.
  printf '%s' "${result}"
}

run_capture_command() {
  local remaining command_limit
  (( SECONDS < deadline )) || return 124
  remaining="$(remaining_seconds)"
  [[ "${remaining}" =~ ^[0-9]+$ ]] || return 124
  (( remaining > 0 )) || return 124
  command_limit="${command_timeout}"
  (( remaining >= command_limit )) || command_limit="${remaining}"
  timeout --signal=TERM --kill-after=1s "${command_limit}s" "$@"
}

run_bounded() {
  local kind="$1" file="$2" budget="$3"; shift 3
  local raw sanitized
  if (( SECONDS >= deadline )); then
    append_file "${file}" $'skipped: total capture deadline reached\n' "${budget}"
    return 0
  fi
  # The command output stays in memory, is byte-bounded, and is sanitized before
  # any artifact write. stderr is discarded wholesale because it may echo config.
  raw="$(run_capture_command "$@" 2>/dev/null | head -c 32768 || true; printf '\001')"
  raw="${raw%$'\001'}"
  sanitized="$(sanitize_command_output "${kind}" "${raw}"; printf '\001')"
  sanitized="${sanitized%$'\001'}"
  [[ -n "${sanitized}" ]] || sanitized=$'unavailable or no allowlisted diagnostic output\n'
  append_file "${file}" "${sanitized}" "${budget}"
}

capture_workloads() {
  local output_file="$1" context="$2" content
  local name uid owner_uid phase ready deleting created revision desired current available
  : >"${output_file}"
  if (( SECONDS < deadline )); then
    content="$(run_capture_command kubectl --context "${context}" --namespace openkubes-console get pods -o 'jsonpath={range .items[*]}{.metadata.name}{"|"}{.metadata.uid}{"|"}{.metadata.ownerReferences[?(@.controller==true)].uid}{"|"}{.status.phase}{"|"}{.status.conditions[?(@.type=="Ready")].status}{"|"}{.metadata.deletionTimestamp}{"|"}{.metadata.creationTimestamp}{"\n"}{end}' 2>/dev/null | head -c 32768 || true)"
    while IFS='|' read -r name uid owner_uid phase ready deleting created; do
      [[ "${name}" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ && "${uid}" =~ ^[A-Za-z0-9-]+$ && ( -z "${owner_uid}" || "${owner_uid}" =~ ^[A-Za-z0-9-]+$ ) && "${phase}" =~ ^(Pending|Running|Succeeded|Failed|Unknown)$ && "${ready}" =~ ^(True|False|Unknown)$ ]] || continue
      contains_sensitive_marker "${name}" && continue
      contains_sensitive_marker "${uid}" && continue
      contains_sensitive_marker "${owner_uid}" && continue
      [[ -z "${deleting}" || "${deleting}" =~ ^[0-9TZ:.-]+$ ]] || continue
      [[ -z "${created}" || "${created}" =~ ^[0-9TZ:.-]+$ ]] || continue
      append_file "${output_file}" "Pod ${name} uid=${uid} ownerRS=${owner_uid:-unknown} phase=${phase} ready=${ready} deleting=${deleting:-none} created=${created:-unknown}
" 49152
    done <<<"${content}"
  fi
  if (( SECONDS < deadline )); then
    content="$(run_capture_command kubectl --context "${context}" --namespace openkubes-console get replicasets -o 'jsonpath={range .items[*]}{.metadata.name}{"|"}{.metadata.uid}{"|"}{.metadata.ownerReferences[?(@.controller==true)].uid}{"|"}{.metadata.annotations.deployment\.kubernetes\.io/revision}{"|"}{.spec.replicas}{"|"}{.status.replicas}{"|"}{.status.readyReplicas}{"|"}{.status.availableReplicas}{"|"}{.metadata.creationTimestamp}{"\n"}{end}' 2>/dev/null | head -c 32768 || true)"
    while IFS='|' read -r name uid owner_uid revision desired current ready available created; do
      [[ "${name}" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ && "${uid}" =~ ^[A-Za-z0-9-]+$ && ( -z "${owner_uid}" || "${owner_uid}" =~ ^[A-Za-z0-9-]+$ ) && "${revision}" =~ ^[0-9]+$ && "${desired}" =~ ^[0-9]+$ ]] || continue
      contains_sensitive_marker "${name}" && continue
      contains_sensitive_marker "${uid}" && continue
      contains_sensitive_marker "${owner_uid}" && continue
      [[ -z "${current}" || "${current}" =~ ^[0-9]+$ ]] || continue
      [[ -z "${ready}" || "${ready}" =~ ^[0-9]+$ ]] || continue
      [[ -z "${available}" || "${available}" =~ ^[0-9]+$ ]] || continue
      [[ -z "${created}" || "${created}" =~ ^[0-9TZ:.-]+$ ]] || continue
      append_file "${output_file}" "ReplicaSet ${name} uid=${uid} ownerDeployment=${owner_uid:-unknown} revision=${revision} desired=${desired} current=${current:-0} ready=${ready:-0} available=${available:-0} created=${created:-unknown}
" 49152
    done <<<"${content}"
  fi
  if [[ ! -s "${output_file}" ]]; then
    append_file "${output_file}" $'No allowlisted Pod or ReplicaSet state was returned\n' 49152
  fi
}

capture() {
  local output_dir="$1" cluster_name="$2" local_port="$3" pod_name="$4" elapsed="$5" forward_log="$6"
  local netstat_start="${7:-}"
  local context="kind-${cluster_name}" node_container="${cluster_name}-control-plane"
  local start=$SECONDS deadline content netstat_end netstat_content start_overflows start_drops end_overflows end_drops
  [[ -d "${output_dir}" ]] || fail 'artifact directory must exist'
  [[ "${cluster_name}" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]] || fail 'invalid cluster name'
  [[ "${local_port}" =~ ^[0-9]{4,5}$ ]] || fail 'invalid local port'
  [[ -z "${pod_name}" || "${pod_name}" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || fail 'invalid Pod name'
  [[ "${elapsed}" =~ ^[0-9]+$ ]] || elapsed=unknown
  [[ ! -e "${output_dir}/capture.txt" ]] || fail 'capture artifact already exists'
  artifact_dir="${output_dir}"
  deadline=$((start + total_timeout))
  if [[ ! "${netstat_start}" =~ ^TcpExt\ ListenOverflows=[0-9]+\ ListenDrops=[0-9]+$ ]]; then
    netstat_start='TcpExt ListenOverflows=unavailable ListenDrops=unavailable'
  fi
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
      content="$(cat "${output_dir}/port-forward.filtered"; printf '\001')"
      content="${content%$'\001'}"
      append_file "${output_dir}/port-forward.txt" "${content}" 16384
      rm -f "${output_dir}/port-forward.filtered"
    fi
  else
    append_file "${output_dir}/port-forward.txt" $'no port-forward diagnostic lines captured\n' 16384
  fi

  : >"${output_dir}/listener.txt"
  run_bounded listener "${output_dir}/listener.txt" 32768 ss -ltn "sport = :${local_port}"

  : >"${output_dir}/versions.txt"
  run_bounded versions "${output_dir}/versions.txt" 16384 kubectl version --client
  run_bounded versions "${output_dir}/versions.txt" 16384 kind version
  run_bounded versions "${output_dir}/versions.txt" 16384 docker exec "${node_container}" containerd --version

  capture_workloads "${output_dir}/workloads.txt" "${context}"

  : >"${output_dir}/netstat.txt"
  netstat_end="$(snapshot_netstat)"
  if [[ "${netstat_start}" =~ ^TcpExt\ ListenOverflows=([0-9]+)\ ListenDrops=([0-9]+)$ ]]; then
    start_overflows="${BASH_REMATCH[1]}"
    start_drops="${BASH_REMATCH[2]}"
  fi
  if [[ "${netstat_end}" =~ ^TcpExt\ ListenOverflows=([0-9]+)\ ListenDrops=([0-9]+)$ ]]; then
    end_overflows="${BASH_REMATCH[1]}"
    end_drops="${BASH_REMATCH[2]}"
  fi
  if [[ -n "${start_overflows:-}" && -n "${end_overflows:-}" ]] &&
     (( end_overflows >= start_overflows && end_drops >= start_drops )); then
    netstat_content="start ${netstat_start}
end ${netstat_end}
delta TcpExt ListenOverflows=$((end_overflows - start_overflows)) ListenDrops=$((end_drops - start_drops))
"
  else
    netstat_content="start ${netstat_start}
end ${netstat_end}
delta TcpExt ListenOverflows=unavailable ListenDrops=unavailable
"
  fi
  append_file "${output_dir}/netstat.txt" "${netstat_content}" 8192
  append_file "${output_dir}/capture.txt" "Capture ended UTC: $(date -u +%Y-%m-%dT%H:%M:%SZ)
Capture duration: $((SECONDS - start))s
" 4096
}

main() {
case "${1:-}" in
  filter-port-forward)
    [[ "$#" == 2 ]] || fail 'usage: capture-local-kind-failure.sh filter-port-forward OUTPUT'
    filter_port_forward "$2"
    ;;
  snapshot-netstat)
    [[ "$#" == 1 ]] || fail 'usage: capture-local-kind-failure.sh snapshot-netstat'
    snapshot_netstat
    ;;
  capture)
    [[ "$#" == 7 || "$#" == 8 ]] || fail 'usage: capture-local-kind-failure.sh capture DIR CLUSTER PORT POD ELAPSED FORWARD_LOG [NETSTAT_BASELINE]'
    capture "$2" "$3" "$4" "$5" "$6" "$7" "${8:-}"
    ;;
  *)
    fail 'usage: capture-local-kind-failure.sh {filter-port-forward|snapshot-netstat|capture} ...'
    ;;
esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
