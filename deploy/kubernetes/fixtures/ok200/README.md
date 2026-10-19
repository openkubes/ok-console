# kubectl diagnostic fixtures

`kubectl-{1.27.4,1.37.1}-refused.log` contains actual non-secret stderr
captured with each real client on 2026-10-19 using:

```sh
kubectl --kubeconfig <throwaway-config> -v=6 --request-timeout=1s \
  port-forward pod/current-pod 18787:8787
```

The throwaway config selected `http://127.0.0.1:1`, with an empty user and no
credentials. Both commands exited 1. Only the loader line naming the temporary
config file was removed. `*-version.txt` contains the corresponding real
`kubectl version --client` stdout and stderr, including the legacy warning.
Tests use checked-in expected output rather than running kubectl or a cluster.

`*-occupied-port.reconstructed.log` reconstructs the raw input shape of the
occupied-port captures from the same clients. Timestamps, source locations,
verbs, statuses and timings come from the retained sanitized artifacts. Their
raw URLs, PIDs, object names and full bind errors were discarded at capture;
these fixtures use fixed non-secret placeholders for those unrecoverable fields.
They are not byte-for-byte original raw logs.

The two tunnel messages come from Kubernetes v1.37.0
[`tunneling_dialer.go`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/client-go/tools/portforward/tunneling_dialer.go#L120):
`Before WebSocket Upgrade Connection...` and `Negotiation complete`.
These indicate WebSocket tunnel negotiation, including its successful completion.
Actual fallback uses the separate primary-to-secondary message in
[`fallback_dialer.go`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/client-go/tools/portforward/fallback_dialer.go#L74).
