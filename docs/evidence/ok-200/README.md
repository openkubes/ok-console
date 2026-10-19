# OK-200 `verify:kind` port-forward evidence (PR branch)

These are the transcripts for the `fix/ok-200-port-forward-current-pod` branch, recorded **before merge**. They are PR-branch evidence. Evidence from `main` after merge will be recorded separately.

## Source and environment

- Source revision of every run: `e25fb4c4537fd51ad34626136c6cfbab20a1b13f`, clean tree (`git status --porcelain` empty). The commit that adds this directory changes nothing outside `docs/evidence/ok-200/`.
- Date: 2026-10-18, runs between 04:53 and 05:00 UTC.
- Workstation: Linux (WSL2), Docker Engine 29.7.2 (Docker Desktop), kind v0.17.0 with node image `kindest/node:v1.25.3`, kubectl client v1.27.4, Node.js v24.4.1, pnpm 10.17.1.
- Command: `pnpm verify:kind`. Each run creates its own Kind cluster and deletes it at the end; `kind get clusters` listed none after the three runs and again after the negative control.
- The only redaction: the absolute checkout path is replaced with `<ok-console checkout>`. Hashes of the published files are in `SHA256SUMS`.

## What was run

| Transcript | Purpose | Result |
|---|---|---|
| `verify-kind-run-1.log` | consecutive run 1 | exit 0, `OK-169 local Kubernetes deployment proof passed.` |
| `verify-kind-run-2.log` | consecutive run 2 | exit 0, passed |
| `verify-kind-run-3.log` | consecutive run 3 | exit 0, passed |
| `verify-kind-occupied-port.log` | negative control: another local process already listening on 127.0.0.1:18787 when the run started | exit 1: `kubectl port-forward exited before reporting readiness for 127.0.0.1:18787.` followed by kubectl's `bind: address already in use` |

In each passing run the verifier prints `Selected Pod <name> of ReplicaSet <name> (Deployment revision 2)`. That is the single Ready, non-terminating Pod of the Deployment's current ReplicaSet after `rollout restart`. The verifier declares the tunnel ready only after kubectl prints `Forwarding from 127.0.0.1:18787 -> 8787`. It binds `--address 127.0.0.1` only, so a listener that already holds the port makes kubectl exit, and the run fails instead of passing.

## Remaining verifier timeouts

- Wait for leftover old-ReplicaSet Pods to disappear: 120 s.
- Wait for kubectl's exact `Forwarding from` line: 30 s.
- First `/health/live` probe after readiness: up to 30 attempts, `--max-time 5` each, 1 s apart (about 180 s). Before each attempt it checks that the forwarder is still running, and fails with the port-forward log if it has exited.
- The `/health/ready` and `/` probes: one attempt each, `--max-time 5`.

## Offline tests

`pnpm test:deployment` (7 files, 48 tests) includes `deploy/kubernetes/ok200.test.ts`. It runs the verifier's real `main` with stubbed `docker`/`kind`/`git`/`kubectl`/`curl` and covers:

- Pod selection: none, more than one, terminating, not Ready, leftover Pods of other ReplicaSets, zero or two current ReplicaSets, success exactly at the deadline.
- Port-forward readiness: process exit, an already-bound port, the wrong port in the `Forwarding` line, a stale log, the forwarder exiting right after readiness, the forwarder exiting during probing.
- Bounded probe retry: transient failure then success, persistent failure.
- Exact `--context`, `--namespace`, `pod/<name>` and probe URL arguments.

Fourteen mutation variants of the verifier (each removing or weakening one guard) were each caught by a failing test.

## Scope of this evidence

- **Signature 1** ("pod not found" for a Pod of the old ReplicaSet): reproduced on `main` `81d725b` on 2026-10-13. These runs show it fixed on the PR branch.
- **Signature 2** (an IPv4 connection timeout to 127.0.0.1:8787 inside the Pod network namespace, September 2026): an earlier investigation reproduced the same timeout by injecting a SYN drop. That reproduction does **not** establish the root cause of the September incident, and this change makes no claim about it. Its acceptance criterion remains open.
- This is local Kind evidence only. It is not live acceptance for any cluster environment.
