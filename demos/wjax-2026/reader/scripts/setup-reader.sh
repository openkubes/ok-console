#!/bin/sh
set -eu
: "${KIND_CONTEXT:=kind-wjax-demo}"
: "${OUT:=./wjax-reader.kubeconfig}"
[ ! -e "$OUT" ] || { echo 'Refusing to overwrite existing kubeconfig' >&2; exit 1; }
kubectl --context "$KIND_CONTEXT" -n wjax-demo create serviceaccount wjax-console-reader
kubectl --context "$KIND_CONTEXT" -n wjax-demo create role wjax-console-reader --verb=get,list --resource=pods,deployments
kubectl --context "$KIND_CONTEXT" -n wjax-demo create rolebinding wjax-console-reader --role=wjax-console-reader --serviceaccount=wjax-demo:wjax-console-reader
TOKEN=$(kubectl --context "$KIND_CONTEXT" -n wjax-demo create token wjax-console-reader --duration=8h)
SERVER=$(kubectl config view --raw --minify --context "$KIND_CONTEXT" -o jsonpath='{.clusters[0].cluster.server}')
CA=$(kubectl config view --raw --minify --context "$KIND_CONTEXT" -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')
[ -n "$SERVER" ] && [ -n "$CA" ] || { echo 'Missing API server or inline CA; stopping' >&2; exit 1; }
umask 077
cat > "$OUT" <<EOF
apiVersion: v1
kind: Config
clusters:
- name: wjax-demo
  cluster:
    server: "$SERVER"
    certificate-authority-data: "$CA"
users:
- name: wjax-reader
  user:
    token: "$TOKEN"
contexts:
- name: wjax-reader
  context:
    cluster: wjax-demo
    user: wjax-reader
    namespace: wjax-demo
current-context: wjax-reader
EOF
kubectl --kubeconfig "$OUT" auth can-i get pods -n wjax-demo
if [ "$(kubectl --kubeconfig "$OUT" auth can-i create deployments -n wjax-demo)" != "no" ]; then
  echo "ERROR: writer authorization found, refusing this reader profile" >&2
  exit 1
fi
printf 'Read-only kubeconfig: %s (token expires in <= 8h)\n' "$OUT"
