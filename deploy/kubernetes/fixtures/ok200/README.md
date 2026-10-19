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

The two tunnel messages come from Kubernetes v1.37.1 (the fixture binary)
[`tunneling_dialer.go`](https://github.com/kubernetes/kubernetes/blob/v1.37.1/staging/src/k8s.io/client-go/tools/portforward/tunneling_dialer.go#L120):
`Before WebSocket Upgrade Connection...` and `Negotiation complete`.
These indicate WebSocket tunnel negotiation, including its successful completion.
Actual fallback uses the separate primary-to-secondary message in
[`fallback_dialer.go`](https://github.com/kubernetes/kubernetes/blob/v1.37.1/staging/src/k8s.io/client-go/tools/portforward/fallback_dialer.go#L74).

Both cited dialer files are byte-identical at v1.37.0.

The reconstructed bind errors follow the upstream `portforward.go` format strings
at [v1.27.4](https://github.com/kubernetes/kubernetes/blob/v1.27.4/staging/src/k8s.io/client-go/tools/portforward/portforward.go#L214-L282)
and [v1.37.1](https://github.com/kubernetes/kubernetes/blob/v1.37.1/staging/src/k8s.io/client-go/tools/portforward/portforward.go#L343-L411):

- `Unable to listen on port %d: %v\n` (per-port stderr).
- `fmt.Errorf("%s: %v", "Listeners failed to create with the following errors", errors)`
  (the listener errors slice renders inside square brackets).
- `unable to create listener: Error %s` (the Go network error wrapper).
- `unable to listen on any of the requested ports: %v` (the returned error;
  kubectl prefixes `error: `, and the port slice renders as `[{18787 8787}]`).

These fixed placeholders model an occupied IPv4-only listener. The expected
sanitized output retains only the helper's generic listen-error class, with no
bind address or requested-port list.
