#!/usr/bin/env bash
set -euo pipefail

# OpenKubes W-JAX 2026 - Local Demo Setup
# Only for the disposable kind-wjax-demo cluster.
# Never intended for production clusters.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CTX="kind-wjax-demo"
NAMESPACE="wjax-demo"
SERVICE_ACCOUNT="wjax-demo-executor"
CONFIG="$SCRIPT_DIR/.demo-kubeconfig.json"

cd "$SCRIPT_DIR"
umask 077

# 1. Prerequisites
for cmd in kubectl kind python3; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "ERROR: Missing command: $cmd"
    exit 1
  }
done

# 2. Verify isolated kind cluster
echo "Checking W-JAX kind cluster..."

kind get clusters | grep -Fxq "wjax-demo" || {
  echo "ERROR: kind cluster wjax-demo not found"
  exit 1
}

SERVER="$(
  kubectl --context "$CTX" \
    config view --minify \
    -o jsonpath='{.clusters[0].cluster.server}'
)"

case "$SERVER" in
  https://127.0.0.1:*|https://localhost:*)
    ;;
  *)
    echo "ERROR: Refusing non-local Kubernetes API: $SERVER"
    exit 1
    ;;
esac

kubectl --context "$CTX" \
  get namespace kube-system >/dev/null

echo "Cluster verification: PASS"

# 3. Never silently overwrite credentials
if [ -e "$CONFIG" ]; then
  echo "ERROR: Dedicated kubeconfig already exists:"
  echo "$CONFIG"
  echo "Use make wjax-demo-auth to refresh existing credentials."
  exit 1
fi

# 4. Create namespace and bounded RBAC
echo "Configuring namespace and executor RBAC..."

kubectl --context "$CTX" \
  create namespace "$NAMESPACE" \
  --dry-run=client -o yaml |
  kubectl --context "$CTX" apply -f -

kubectl --context "$CTX" \
  -n "$NAMESPACE" apply -f "$SCRIPT_DIR/rbac.yaml"

# 5. Request temporary service-account token
echo "Creating time-limited executor credential..."

TOKEN="$(
  kubectl --context "$CTX" \
    -n "$NAMESPACE" \
    create token "$SERVICE_ACCOUNT" \
    --duration=8h
)"

KUBECONFIG_JSON="$(
  kubectl --context "$CTX" \
    config view --raw --minify -o json
)"

export TOKEN KUBECONFIG_JSON

# 6. Generate bounded kubeconfig
python3 - "$CONFIG" <<'PY'
import json
import os
import pathlib
import sys

cfg = json.loads(os.environ["KUBECONFIG_JSON"])
cluster = cfg["clusters"][0]["cluster"]

server = cluster["server"]

if not (
    server.startswith("https://127.0.0.1:")
    or server.startswith("https://localhost:")
):
    raise RuntimeError("Refusing non-local Kubernetes API")

ca = cluster.get("certificate-authority-data")
if not ca:
    raise RuntimeError("Missing Kubernetes CA data")

result = {
    "apiVersion": "v1",
    "kind": "Config",
    "clusters": [
        {
            "name": "wjax",
            "cluster": {
                "server": server,
                "certificate-authority-data": ca,
            },
        }
    ],
    "users": [
        {
            "name": "wjax-bounded-executor",
            "user": {
                "token": os.environ["TOKEN"],
            },
        }
    ],
    "contexts": [
        {
            "name": "wjax",
            "context": {
                "cluster": "wjax",
                "user": "wjax-bounded-executor",
                "namespace": "wjax-demo",
            },
        }
    ],
    "current-context": "wjax",
}

path = pathlib.Path(sys.argv[1])
path.write_text(json.dumps(result, indent=2))
path.chmod(0o600)
PY

unset TOKEN KUBECONFIG_JSON

# 7. Helper for explicit RBAC assertions
assert_permission() {
  local expected="$1"
  local label="$2"
  shift 2

  local actual
  actual="$(
    kubectl --kubeconfig "$CONFIG" \
      auth can-i "$@" 2>/dev/null
  )"

  if [ "$actual" != "$expected" ]; then
    echo "FAIL: $label (expected $expected, got $actual)"
    exit 1
  fi

  echo "PASS: $label"
}

echo
echo "Verifying bounded executor permissions..."

# Positive permissions
assert_permission yes \
  "Get named deployment" \
  get deployments.apps/wjax-nginx -n "$NAMESPACE"

assert_permission yes \
  "Patch named deployment" \
  patch deployments.apps/wjax-nginx -n "$NAMESPACE"

assert_permission yes \
  "Update named deployment" \
  update deployments.apps/wjax-nginx -n "$NAMESPACE"

assert_permission yes \
  "Create deployment in demo namespace" \
  create deployments.apps -n "$NAMESPACE"

# Negative permissions
assert_permission no \
  "Delete named deployment denied" \
  delete deployments.apps/wjax-nginx -n "$NAMESPACE"

assert_permission no \
  "Delete namespace denied" \
  delete namespaces

assert_permission no \
  "Patch other deployment denied" \
  patch deployments.apps/other-workload -n "$NAMESPACE"

echo
echo "======================================="
echo "OpenKubes W-JAX Demo Setup: PASS"
echo "======================================="
echo "Cluster:    $CTX"
echo "Namespace:  $NAMESPACE"
echo "Executor:   $SERVICE_ACCOUNT"
echo "Kubeconfig: $CONFIG"
echo
echo "Credentials are temporary and locally stored."
echo "No application deployment was modified."