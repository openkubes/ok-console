# OpenKubes AI Thinkerers — local HOTL spike

**Status: experimental / not production safe.** Original W-JAX HITL demo remains unchanged. This is a separate opt-in HOTL supervisor, intentionally scoped to the disposable local kind cluster only. It reuses the **Executor** ServiceAccount from the W-JAX lab; the AI receives no kubeconfig.

## Scope

- Trusted intent: existing `wjax-demo/wjax-nginx` should have exactly 2 replicas of `nginx:1.27.5-alpine`.
- Only action: atomically change `spec.replicas` **0 to 2** after two consistent 0/0 observations and an exact Ollama proposal.
- Before patch: verify same UID, generation and resourceVersion, only that name, namespace, image, selector, and local API.
- Fails closed on unexpected output, missing service, concurrent changes or unsuccessful verification.
- Logs HOTL-specific events into `ai-thinkers-evidence.jsonl`. This is **not cryptographically authenticated or independently verified evidence**. The read-back verification uses the same executor credentials and process.
- No production namespaces, generic remediation, background agents, or automatic cleanup. HOTL opt-in grants permission for the whole running process; Ctrl-C prevents future actions, but cannot cancel a submitted Kubernetes API request.
- Unlike the original HITL demo, this performs a strictly scoped automated action; **do not** confuse it with the W-JAX `make wjax-demo-verify` mechanism, which requires explicit HUMAN_APPROVED evidence.

## Before the demo

Use your **existing** local W-JAX kind lab (do not recreate it). From repo root:

```bash
export DOCKER_CONTEXT=colima
export WJAX_DEMO_RUNTIME_DIR="/path/to/your/private/wjax-runtime"
kubectl --context kind-wjax-demo -n wjax-demo get deploy wjax-nginx
make wjax-demo-check
make wjax-demo-status
curl -fsS http://127.0.0.1:11434/api/tags >/dev/null
```

**The runtime path above is an example from the 25 November session; use your actual active runtime.** Ensure the existing Deployment is healthy at 2/2. The original browser UI at port 8788 is still the HITL demo; it is *not* the HOTL supervisor UI.

## Modes: one-shot vs continuous

Choose exactly one flag: `--once` for one verified recovery then exit, or `--always` to continuously watch for *new* confirmed drift events. Both require `--enable-hotl` and explicit `AI_THINKERS_HOTL=I_ACCEPT_LOCAL_KIND_ONLY` consent. `--always` holds the same runtime lock, never retries a drift generation already handled, and **exits fail closed on any error**, including an LLM or verification failure. It does not have an autonomy budget, cooldown, maintenance detection, automatic backoff, or independent verification; use only on the disposable local kind lab. Stop the foreground process using Ctrl-C to prevent future attempts (an in-flight patch cannot be revoked).

```bash
# Choose this INSTEAD of --once to remain watching for later drift:
python3 demos/ai-thinkers/hotl.py --enable-hotl --always \
  --runtime-dir "$WJAX_DEMO_RUNTIME_DIR"
```

## Supervisor heartbeat and dashboard status

The read-only dashboard now has four summary cards: **Supervisor mode**, **Current state**, **Last recovery**, and **Recorded events**. The supervisor atomically updates a private `ai-thinkers-status.json` file every ~2 seconds and at state transitions. The dashboard accepts only a heartbeat bound to the latest `HOTL_ENABLED` session ID. A live state older than 8 seconds becomes **UNKNOWN**, never falsely **MONITORING**. After normal `--once` completion, **STOPPED** is retained as the last reported terminal state; failures report **FAILED CLOSED**. Both are recorded states, not independent process attestations.

**Last recovery** is derived from the most recent `HOTL_RECOVERY_VERIFIED` in the current session and stays **VERIFIED** after the supervisor stops or resumes monitoring. This is historical, mutable JSONL and read-back evidence, not a signed receipt, an independent verifier, or a Kubernetes health probe. A supervisor can still crash between heartbeats and a status may briefly appear current until the freshness threshold expires. Do not use the display as an authorization control.

To see new UI code, restart `dashboard.py` (port 8794) from this branch and reload the browser. Do not start a second dashboard on the occupied port. To test `--once` and `--always`, start each supervisor in foreground with explicit opt-in; never run two against the same runtime.

## Makefile shortcuts (foreground only)

From the repository root, set the existing private runtime and explicitly consent:

```bash
export DOCKER_CONTEXT=colima
export WJAX_DEMO_RUNTIME_DIR="/path/to/your/private/wjax-runtime"
export AI_THINKERS_HOTL=I_ACCEPT_LOCAL_KIND_ONLY

# Choose ONE:
make ai-thinkers-hotl-once
# or: make ai-thinkers-hotl-always
```

These targets invoke the same guarded Python supervisor, do not bypass its checks,
do not launch a background process, and do not create or reset the kind cluster.
Run only one supervisor per runtime; the existing process lock rejects another.
Use Ctrl-C in the foreground terminal to stop future attempts. The dashboard
is separate and remains at http://127.0.0.1:8794/.

## Show HOTL in two terminals

In terminal **A**, run the supervisor with explicit consent (only on local kind):

```bash
export AI_THINKERS_HOTL=I_ACCEPT_LOCAL_KIND_ONLY
python3 demos/ai-thinkers/hotl.py --enable-hotl --once \
  --runtime-dir "$WJAX_DEMO_RUNTIME_DIR"
```

Terminal A waits and observes. In terminal **B** introduce the demo drift:

```bash
kubectl --context kind-wjax-demo -n wjax-demo scale deploy/wjax-nginx --replicas=0
kubectl --context kind-wjax-demo -n wjax-demo get deploy wjax-nginx
```

Expected terminal A progression:

```text
HOTL_ENABLED
DRIFT_CONFIRMED
AI_PROPOSAL
HOTL_EXECUTED
HOTL_RECOVERY_VERIFIED / READY_VERIFIED
```

Verify with **admin observation** on the disposable lab:

```bash
kubectl --context kind-wjax-demo -n wjax-demo get deploy wjax-nginx
```

The HOTL log is separate from the old HITL log. The original `make wjax-demo-verify` is **not** valid for this flow because it intentionally refuses executions without a prior HUMAN_APPROVED event.

## Safe fallback

If the HOTL run fails or the Ollama model is slow, stop terminal A with Ctrl-C and return to the already-tested W-JAX HITL demo. Do not modify the stored JSONL evidence to simulate success. Manual admin recovery of the disposable demo is:

```bash
kubectl --context kind-wjax-demo -n wjax-demo scale deploy/wjax-nginx --replicas=2
kubectl --context kind-wjax-demo -n wjax-demo rollout status deploy/wjax-nginx --timeout=120s
```

Any manual recovery must be disclosed as **manual**, not HOTL evidence.

## Limitations to address before production

The implementation has no enterprise identity, tamper-evident audit, independent verifier, trusted GitOps intent, revoke protocol, scoped signed grants, escalation workflow or sophisticated retry budget. The Kubernetes RBAC from the original disposable demo can create deployments namespace-wide; that privilege must be reduced before any production use. Also add unit/integration tests and an isolated E2E test before relying on the HOTL flow in a live presentation.

## Read-only presentation dashboard (optional)

From the same repository and with the **same** `WJAX_DEMO_RUNTIME_DIR` as the supervisor, run in a third terminal:

```bash
python3 demos/ai-thinkers/dashboard.py --runtime-dir "$WJAX_DEMO_RUNTIME_DIR"
```

Open **http://127.0.0.1:8794/**. The dashboard polls only the local HOTL JSONL event log, shows a five-step timeline, and does not send Kubernetes API calls or change cluster resources. The displayed mode indicates the **recorded** session mode, not whether a running supervisor is currently authorized. A prior successful run remains visible in the file; this is historical evidence, not real-time liveness. The dashboard never displays the full candidate, UID, or credentials. The current UI cannot pause or stop a supervisor; use Ctrl-C in the supervisor terminal. To do another `--once` run, restart the supervisor explicitly before creating drift.

### Smoke tests (no Kubernetes writes)

```bash
python3 -m py_compile demos/ai-thinkers/hotl.py demos/ai-thinkers/dashboard.py
python3 -m unittest discover -s demos/ai-thinkers -p 'test_*.py' -v
```

### Live presentation order

1. Show original W-JAX HITL UI at http://127.0.0.1:8788/ and explain manual approval.
2. Show HOTL dashboard at http://127.0.0.1:8794/.
3. Start the opt-in one-shot supervisor in a terminal.
4. Scale **only** disposable `wjax-demo/wjax-nginx` to zero from a second terminal.
5. Show timeline through `HOTL_RECOVERY_VERIFIED`, then confirm `2/2` with `kubectl --context kind-wjax-demo`.
6. Point out: evidence from the HOTL process is not independently verified and does not imply unattended production safety.
