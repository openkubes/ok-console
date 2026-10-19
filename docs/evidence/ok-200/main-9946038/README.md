# OK-200 post-merge evidence on `main` (`9946038`)

Recorded 2026-10-19 on ok-console `main` at `9946038ca179473ab7211907ecf8e057f56d2260` (merge of PR #56), clean tree. This is separate from the PR-branch evidence in `../README.md` (head `e25fb4c`).

The only redactions replace the workstation checkout, workspace, home directory and kubeconfig paths with `<ok-console checkout>`, `<workspace>`, `<evidence dir>`, `<home>` and `<kubeconfig>`. `SHA256SUMS` covers the published files.

## 1. `pnpm verify:kind`, three consecutive runs on merged `main`

Environment (`verify-kind/env.txt`): WSL2 workstation, Docker Engine 29.7.2, kind v0.17.0 (node image `kindest/node:v1.25.3`), kubectl client v1.27.4, Node.js v24.4.1, pnpm 10.17.1. No kind cluster existed before or after.

| Run | Window (UTC) | Result |
|---|---|---|
| `verify-kind/verify-kind-run-1.log` | 06:27:35-06:30:34 | exit 0, `OK-169 local Kubernetes deployment proof passed.` |
| `verify-kind/verify-kind-run-2.log` | 06:30:34-06:33:10 | exit 0, passed |
| `verify-kind/verify-kind-run-3.log` | 06:33:10-06:35:14 | exit 0, passed |

Each run reports `Source revision: 9946038...` and selects the single Ready Pod of the Deployment's current ReplicaSet after `rollout restart`. Each run deletes its own cluster.

## 2. Signature 2: one time-bounded diagnostic pass

Signature 2 (September 2026) is an IPv4 connect timeout inside the Pod network namespace: `failed to execute portforward in network namespace ...: failed to connect to localhost:8787 inside namespace ...: dial tcp4 127.0.0.1:8787: connect: connection timed out`.

This pass (`signature-2-pass/`, 617 s before cleanup, kind cluster `ok200-sig2`) tested the hypotheses below. It claims no root cause for the September incident.

Environment facts captured: the kind node reported containerd v1.6.9; in the Pod network namespace `net.core.somaxconn=4096` and `net.ipv4.tcp_syn_retries=6`. `bff/server.mjs` calls `listen()` without an explicit backlog (Node default 511); the container image runs Node 22.

| Step | What was done | Observed | Reading |
|---|---|---|---|
| Baseline | `verify:kind` with the cluster kept | exit 0 | Environment healthy |
| E1 | `rollout restart` while a `-v=6` port-forward to the old Pod and 0.5 s curls ran | No dial timeout. The last successful request was at 06:37:27.749 UTC; curl then reported an empty reply and failure to connect to the local port-forward listener. The port-forward log reports that the old Pod's network namespace closed, followed by `lost connection to pod`. | One graceful termination did not produce signature 2. This run does not show an in-Pod connection refusal. |
| E2a | Liveness probe removed on the kind cluster only (no repository change); app process stopped (`SIGSTOP`); 3 curls through the tunnel | 3 x curl exit 28 (read timeout, 0 bytes); no port-forward dial error; `ListenOverflows 0` | A dial timeout was not observed during these three requests while the app was stopped. |
| E2b | App still stopped; about 700 concurrent connections through the tunnel for 150 s | The listening socket's receive queue reached `0x200` (512 pending connections); `ListenOverflows` and `ListenDrops` each rose from 0 to 712; 21 port-forward error lines contain the same IPv4 timeout text as the September message (`dial tcp4 127.0.0.1:8787: connect: connection timed out`). Locally each line also reports an IPv6 attempt (`dial tcp6 [::1]:8787: connect: connection refused`), which the September message does not contain. | Accept-queue saturation of a stopped listener reproduces the IPv4 timeout locally. The differing IPv6 part indicates a different runtime version or configuration on the September host. |
| E3 | conntrack and netfilter sampling | conntrack samples 194-330 of 65536; `iptables_lines=0` in the Pod network namespace | No sign of conntrack exhaustion or Pod-netns rules in these samples |

### Scope of this evidence
- Local kind on one workstation, with the app deliberately stopped and the queue deliberately flooded. E2b shows a mechanism that produces the same IPv4 timeout. It does not show that a stopped or stalled listener with more than 512 pending connections occurred in September, so the September root cause remains unestablished.
- E1 covers one graceful termination; no startup burst was run.
- The snapshots contain the kind Pod network's own addresses (10.244.0.0/16) in `/proc/net/tcp` hex form; they are ephemeral cluster-internal addresses.
- This is not live acceptance for any cluster environment.
