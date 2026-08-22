#!/usr/bin/env bash
set -euo pipefail

readonly expected_context="${OK_CONSOLE_KUBE_CONTEXT:-ok-shared-admin@ok-shared}"
readonly namespace="openkubes-console"
readonly overlay="deploy/kubernetes/overlays/ok-shared-live"
readonly expected_console_image="ghcr.io/openkubes/ok-console@sha256:10cfb281bc5d0d14aaea34ca072ea4b92d69183df617c1a2d19c1d3a5d6aac6b"
readonly expected_producer_image="ghcr.io/openkubes/observed-state-producer@sha256:2af5f7fe9612a4fe006fbb931f47356d0e797339542d9012752a9208e8cd359c"

actual_context="$(kubectl config current-context)"
if [[ "${actual_context}" != "${expected_context}" ]]; then
  echo "Refusing to continue: current context '${actual_context}' is not '${expected_context}'." >&2
  exit 1
fi

owner="$(kubectl --context "${expected_context}" get namespace "${namespace}" -o jsonpath='{.metadata.labels.openkubes\.io/managed-by}')"
if [[ "${owner}" != "ok-170" ]]; then
  echo "Refusing to modify namespace '${namespace}' without openkubes.io/managed-by=ok-170." >&2
  exit 1
fi

issuer_ready="$(kubectl --context "${expected_context}" get clusterissuer ok-shared-internal-ca -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}')"
[[ "${issuer_ready}" == "True" ]] || { echo "ClusterIssuer/ok-shared-internal-ca is not Ready." >&2; exit 1; }
kubectl --context "${expected_context}" get crd clusters.postgresql.cnpg.io >/dev/null
kubectl --context "${expected_context}" get crd ciliumnetworkpolicies.cilium.io >/dev/null
kubectl --context "${expected_context}" get storageclass local-path >/dev/null
kubectl --context "${expected_context}" get ingressclass ok-ingress >/dev/null

rendered="$(mktemp)"
port_forward_log="$(mktemp)"
port_forward_pid=""
cleanup() {
  if [[ -n "${port_forward_pid}" ]]; then
    kill "${port_forward_pid}" >/dev/null 2>&1 || true
    wait "${port_forward_pid}" >/dev/null 2>&1 || true
  fi
  rm -f "${rendered}" "${port_forward_log}"
}
trap cleanup EXIT

kubectl kustomize "${overlay}" >"${rendered}"
if grep -Eq 'REPLACE_|\.invalid|sha256:0{64}|image: .+:latest' "${rendered}"; then
  echo "Rendered live overlay contains an unresolved or mutable deployment identity." >&2
  exit 1
fi
if grep -Eq '^kind: Secret$' "${rendered}"; then
  echo "Rendered live overlay must not contain Secret values." >&2
  exit 1
fi
grep -Fq "${expected_console_image}" "${rendered}"
grep -Fq "${expected_producer_image}" "${rendered}"
kubectl --context "${expected_context}" apply --server-side --force-conflicts --dry-run=server --field-manager=ok-172-live -f "${rendered}" >/dev/null

if [[ "${OK_CONSOLE_APPLY_LIVE:-false}" != "true" ]]; then
  echo "OK-172 live preflight passed for ${expected_context}; no cluster state was changed."
  echo "Provision bootstrap Secrets, then set OK_CONSOLE_APPLY_LIVE=true to apply."
  exit 0
fi

session_key_present="$(kubectl --context "${expected_context}" --namespace "${namespace}" get secret ok-console-session -o go-template='{{if index .data "keys.json"}}true{{else}}false{{end}}')"
local_keys_present="$(kubectl --context "${expected_context}" --namespace "${namespace}" get secret ok-console-local-access -o go-template='{{if and (index .data "accounts.json") (index .data "pepper")}}true{{else}}false{{end}}')"
[[ "${session_key_present}" == "true" ]] || { echo "Secret/ok-console-session is incomplete." >&2; exit 1; }
[[ "${local_keys_present}" == "true" ]] || { echo "Secret/ok-console-local-access is incomplete." >&2; exit 1; }

kubectl --context "${expected_context}" apply --server-side --force-conflicts --field-manager=ok-172-live -k "${overlay}"
for certificate in observed-state-producer-server ok-console-observed-state-client ok-console-ingress; do
  kubectl --context "${expected_context}" --namespace "${namespace}" wait --for=condition=Ready "certificate/${certificate}" --timeout=180s
done
kubectl --context "${expected_context}" --namespace "${namespace}" wait --for=condition=Ready cluster.postgresql.cnpg.io/ok-console-db --timeout=300s
kubectl --context "${expected_context}" --namespace "${namespace}" rollout status deployment/observed-state-producer --timeout=180s
kubectl --context "${expected_context}" --namespace "${namespace}" rollout status deployment/ok-console --timeout=180s

deployed_console_image="$(kubectl --context "${expected_context}" --namespace "${namespace}" get deployment ok-console -o jsonpath='{.spec.template.spec.containers[0].image}')"
deployed_producer_image="$(kubectl --context "${expected_context}" --namespace "${namespace}" get deployment observed-state-producer -o jsonpath='{.spec.template.spec.containers[0].image}')"
[[ "${deployed_console_image}" == "${expected_console_image}" ]] || { echo "Unexpected Console image '${deployed_console_image}'." >&2; exit 1; }
[[ "${deployed_producer_image}" == "${expected_producer_image}" ]] || { echo "Unexpected producer image '${deployed_producer_image}'." >&2; exit 1; }

readonly producer_identity="system:serviceaccount:${namespace}:observed-state-producer"
[[ "$(kubectl --context "${expected_context}" auth can-i get nodes --as="${producer_identity}")" == "yes" ]]
[[ "$(kubectl --context "${expected_context}" auth can-i list nodes --as="${producer_identity}")" == "yes" ]]
[[ "$(kubectl --context "${expected_context}" auth can-i get /version --as="${producer_identity}")" == "yes" ]]
[[ "$(kubectl --context "${expected_context}" auth can-i get deployment/ok-console --namespace "${namespace}" --as="${producer_identity}")" == "yes" ]]
[[ "$(kubectl --context "${expected_context}" auth can-i get secrets --namespace "${namespace}" --as="${producer_identity}")" == "no" ]]
[[ "$(kubectl --context "${expected_context}" auth can-i get pods --namespace "${namespace}" --as="${producer_identity}")" == "no" ]]
[[ "$(kubectl --context "${expected_context}" auth can-i create deployments --namespace "${namespace}" --as="${producer_identity}")" == "no" ]]

kubectl --context "${expected_context}" --namespace "${namespace}" port-forward service/ok-console 18787:8787 >"${port_forward_log}" 2>&1 &
port_forward_pid="$!"
for _ in $(seq 1 30); do
  if curl --fail --silent --show-error http://127.0.0.1:18787/health/live >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl --fail --silent --show-error http://127.0.0.1:18787/health/live >/dev/null
curl --fail --silent --show-error http://127.0.0.1:18787/health/ready >/dev/null
curl --fail --silent --show-error http://127.0.0.1:18787/ | grep -Fq '<div id="root"></div>'
unauthorized_status="$(curl --silent --output /dev/null --write-out '%{http_code}' http://127.0.0.1:18787/api/console/v0/overview)"
[[ "${unauthorized_status}" == "403" ]] || { echo "Unauthenticated overview returned ${unauthorized_status}, expected contract-level 403." >&2; exit 1; }

echo "OK-172 live slice verified."
echo "Context: ${actual_context}"
echo "Console image: ${deployed_console_image}"
echo "Producer image: ${deployed_producer_image}"
echo "Mode: PostgreSQL bootstrap sessions plus authenticated hosting-cluster observations"
