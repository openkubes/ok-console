#!/usr/bin/env bash
set -euo pipefail

readonly expected_context="${OK_CONSOLE_KUBE_CONTEXT:-ok-shared-admin@ok-shared}"
readonly namespace="openkubes-console"
readonly overlay="deploy/kubernetes/overlays/ok-shared-preview"
readonly expected_image="ghcr.io/openkubes/ok-console@sha256:04e5541fe9af040b1ca330ce632a74b20fab58489619c16a41db9f8b2d28441d"

actual_context="$(kubectl config current-context)"
if [[ "${actual_context}" != "${expected_context}" ]]; then
  echo "Refusing to continue: current context '${actual_context}' is not '${expected_context}'." >&2
  exit 1
fi

if kubectl get namespace "${namespace}" >/dev/null 2>&1; then
  owner="$(kubectl get namespace "${namespace}" -o jsonpath='{.metadata.labels.openkubes\.io/managed-by}')"
  if [[ "${owner}" != "ok-170" ]]; then
    echo "Refusing to modify pre-existing namespace '${namespace}' without openkubes.io/managed-by=ok-170." >&2
    exit 1
  fi
fi

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
if grep -Eq 'REPLACE_|\.invalid|sha256:0{64}' "${rendered}"; then
  echo "Rendered preview contains an unresolved production placeholder." >&2
  exit 1
fi
if grep -Eq '^kind: Secret$' "${rendered}"; then
  echo "Rendered preview must not contain Secret values." >&2
  exit 1
fi
if ! grep -Fq "${expected_image}" "${rendered}"; then
  echo "Rendered preview does not select the accepted immutable candidate." >&2
  exit 1
fi

if [[ "${OK_CONSOLE_APPLY:-false}" != "true" ]]; then
  echo "Preflight passed for ${expected_context}. Set OK_CONSOLE_APPLY=true to apply the bounded preview."
  exit 0
fi

kubectl apply --server-side --field-manager=ok-170-preview -k "${overlay}"
kubectl --namespace "${namespace}" rollout status deployment/ok-console --timeout=180s

deployed_image="$(kubectl --namespace "${namespace}" get deployment ok-console -o jsonpath='{.spec.template.spec.containers[0].image}')"
if [[ "${deployed_image}" != "${expected_image}" ]]; then
  echo "Deployed image '${deployed_image}' does not match '${expected_image}'." >&2
  exit 1
fi

runtime_security="$(kubectl --namespace "${namespace}" get deployment ok-console -o jsonpath='{.spec.template.spec.automountServiceAccountToken}{" "}{.spec.template.spec.containers[0].securityContext.readOnlyRootFilesystem}{" "}{.spec.template.spec.containers[0].securityContext.allowPrivilegeEscalation}{" "}{.spec.template.spec.containers[0].securityContext.capabilities.drop[0]}')"
if [[ "${runtime_security}" != "false true false ALL" ]]; then
  echo "Unexpected runtime security projection: ${runtime_security}" >&2
  exit 1
fi

kubectl --namespace "${namespace}" port-forward service/ok-console 18787:8787 >"${port_forward_log}" 2>&1 &
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

running_image_id="$(kubectl --namespace "${namespace}" get pods -l app.kubernetes.io/name=ok-console -o jsonpath='{.items[0].status.containerStatuses[0].imageID}')"
echo "OK-170 preview verified."
echo "Context: ${actual_context}"
echo "Deployment image: ${deployed_image}"
echo "Running image ID: ${running_image_id}"
echo "Mode: fixture/read-only; OIDC, PostgreSQL, local access and observed-state producer disabled"
