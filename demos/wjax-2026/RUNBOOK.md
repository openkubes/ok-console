# OpenKubes — W-JAX 2026 Live Demo Runbook v1.0

**Event:** W-JAX 2026 · **Presentation:** 3 November 2026  
**Repository:** `openkubes/ok-console` · **Branch baseline:** `feature/wjax-diagnostics-agent` · **Last verified commit:** `d25cfd8`  
**Scope:** Local disposable kind cluster only. Not a production authorization service or OK-147 Runner.  
**Message:** **AI thinks. OpenKubes executes. Evidence proves.**

## 0. Operating rules

- Run commands from the `ok-console` repository root, unless stated otherwise.
- The **demo web UI** is at <http://127.0.0.1:8788/>. The **Console** is at <http://127.0.0.1:8790/#/clusters> and the **live kind view** at <http://127.0.0.1:8790/wjax-kind.html>.
- The source is `demos/wjax-2026/`; runtime credentials and local evidence are in `.wjax-local-runtime/` (gitignored). The former `../openkubes-wjax-local-demo/` remains a fallback; **do not use it for the primary path**.
- Approval is a local human click, not authenticated enterprise authorization. `evidence.jsonl` is a local, mutable audit log, **not** signed or tamper-proof.
- Diagnostics uses a local read-only provider with ADR-021-inspired contract, **not a deployed kagent integration**. Diagnosis → operation proposal is currently a **manual handoff**. Model output is not authorized execution.
- Keep all demo HTTP services bound to loopback. Never expose them publicly or use a real production context.
- Once the live demo is stable, avoid code changes during the talk.

## 1. Preparation (before opening the room)

### 1.1 Confirm the repository and safety boundary

```bash
cd ~/temp/kubernauts/ok/ok-console
git status --short
git branch --show-current
kubectl config current-context
kind get clusters
kubectl --context kind-wjax-demo -n wjax-demo get deployment wjax-nginx
```

Expected: no unintended edits; `kind-wjax-demo` exists; `wjax-nginx` exists. **Do not proceed with the deliberate drift unless the exact local kind context is available.** Note: `kubectl config current-context` may be another context; always use `--context kind-wjax-demo` for the drift command.

### 1.2 Preflight and startup

```bash
make wjax-demo-check
make wjax-demo
make wjax-demo-status
make wjax-demo-diagnose
```

Expected: executor's named-deployment get/patch/update and namespace-scoped create are allowed; named delete, namespace delete, and patch on foreign deployments are denied. All **four** services report HTTP OK. Diagnostics reports **PASS** for the healthy subject and foreign-workload rejection.

If the service is already running, **do not start a duplicate**: use `make wjax-demo-status`. To restart only launcher-owned services, use `make wjax-demo-stop` and then repeat check/start. If the executor token has expired, run `make wjax-demo-auth` and repeat the preflight; this requests a token for the *existing* demo ServiceAccount using the configured local issuer context.

### 1.3 Browser tabs (open in advance)

1. **OpenKubes Console:** <http://127.0.0.1:8790/#/clusters>
2. **Live kind state:** <http://127.0.0.1:8790/wjax-kind.html>
3. **Agentic Operations demo:** <http://127.0.0.1:8788/>

In the Agentic demo, click **Refresh live status**. Verify `aiMode: ollama` and desired/ready `2/2` in the cluster result. The model service must respond locally on `127.0.0.1:11434` (checked by the launcher). For a first-time rehearsal, run `ollama list` and make sure `llama3.2:latest` is installed.

### 1.4 Establish a known healthy baseline (only if needed)

```bash
kubectl --context kind-wjax-demo -n wjax-demo get deploy wjax-nginx
kubectl --context kind-wjax-demo -n wjax-demo rollout status deployment/wjax-nginx --timeout=90s
```

Expected: `2/2` ready. If the starting cluster is unhealthy, repair it **before** the audience demonstration; do not improvise an unreviewed recovery on stage.

## 2. Stage sequence — approx. 6 minutes

| Elapsed | Action | Show or say |
|---|---|---|
| 0:00–0:45 | **Healthy baseline:** show Console/live kind, then Agentic status (`2/2`). | “This is a real local Kubernetes cluster, not a simulated dashboard.” |
| 0:45–1:20 | **Introduce controlled drift:** in a dedicated terminal run the *exact* command below. Refresh live status; show `0/0`. | “The declared application intent is two replicas; the live workload now differs.” |
| 1:20–2:20 | **Diagnose and assess:** execute read-only diagnostics and assessment from the terminal; explain `MANUAL_REVIEW_REQUIRED` and `execution_allowed: false`. | “The AI provides guidance; it does not receive cluster credentials or permission to execute.” |
| 2:20–3:40 | **Propose, validate, approve:** in the Agentic UI use the exact allowlisted prompt and press **Generate candidate**, then **Approve exact proposal**. | “The deterministic policy restricts what may be executed. A human approves the *exact* digest.” |
| 3:40–4:35 | **Execute:** click **Execute authorized operation**. Refresh until ready; optionally show `kubectl rollout status`. | “The bounded executor performs one authorized local deployment reconciliation.” |
| 4:35–5:35 | **Verify evidence:** run `make wjax-demo-verify`, show `RECOVERY_VERIFIED` or a pre-existing `ALREADY_VERIFIED` when appropriate. | “Success is checked against Kubernetes state, not inferred from an AI response.” |
| 5:35–6:00 | **Negative test / wrap:** click **Try forbidden production request** and show the rejected proposal without approval/execution. | “Outside the allowlist, policy denies the request.” |

### 2.1 Controlled drift — **admin context, local kind only**

```bash
kubectl --context kind-wjax-demo -n wjax-demo scale deployment/wjax-nginx --replicas=0
kubectl --context kind-wjax-demo -n wjax-demo get deployment wjax-nginx
```

Expected: desired/ready `0/0`. This intentionally changes the demo deployment **only**; the limited executor kubeconfig is **not** used to introduce drift.

### 2.2 Diagnostics and AI assessment — read-only

These are currently **terminal/API operations**, not buttons in the small `index.html` UI. They do not automatically create or execute a proposal.

```bash
curl -fsS -X POST http://127.0.0.1:8788/api/diagnose \
  -H 'Content-Type: application/json' -d '{}' | python3 -m json.tool

curl -fsS -X POST http://127.0.0.1:8788/api/assess \
  -H 'Content-Type: application/json' -d '{}' | python3 -m json.tool
```

Expected under drift: diagnostics includes an intent-drift observation, and assessment returns `MANUAL_REVIEW_REQUIRED` with `execution_allowed: false`. If Ollama is unavailable, **do not** portray deterministic diagnostics as an AI assessment and **do not** silently fall back to rules mode.

### 2.3 Human-controlled remediation — Agentic browser UI

1. Set the intent text to **`Deploy nginx with two replicas to the demo cluster`**.
2. Click **Generate candidate**. Verify the `source` identifies Ollama, `allowed: true`, `reason`, exact candidate values and digest. If the candidate differs or policy denies, **stop**; do not loosen the policy to make the demo work.
3. Click **Approve exact proposal**. This is a local-browser human gate, not a cryptographic or corporate IAM approval.
4. Click **Execute authorized operation** **once**. The HTTP response may report `APPLY_SUBMITTED_NOT_READY` before Kubernetes reaches readiness. This is **not a failure** and **not yet verified recovery**.
5. Click **Refresh live status** until desired/ready reports `2/2`.

Optional terminal confirmation:

```bash
kubectl --context kind-wjax-demo -n wjax-demo rollout status deployment/wjax-nginx --timeout=90s
kubectl --context kind-wjax-demo -n wjax-demo get deployment wjax-nginx
```

### 2.4 Verify actual recovery and present the audit trail

```bash
make wjax-demo-verify
```

On a *new* approved execution, the verifier waits up to 90 seconds and appends `RECOVERY_VERIFIED` only if it observes a matching deployment UID, reconciled generation, image `nginx:1.27.5-alpine`, desired `2`, ready `2`, and available `2`. If a prior success already belongs to the **latest** `EXECUTOR_APPLIED`, it prints `ALREADY_VERIFIED` and does not duplicate the terminal event.

Inspect without revealing credentials:

```bash
python3 - <<'PY'
import json
from pathlib import Path
p = Path('.wjax-local-runtime/evidence.jsonl')
allowed = {'PROPOSAL_EVALUATED', 'HUMAN_APPROVED', 'EXECUTOR_APPLIED', 'KUBERNETES_OBSERVED', 'RECOVERY_VERIFIED', 'RECOVERY_VERIFICATION_FAILED'}
for line in p.read_text().splitlines()[-40:]:
    item = json.loads(line)
    if item.get('event') in allowed:
        print(item.get('at'), item.get('event'), item.get('result', ''), item.get('digest', '')[:12])
PY
```

**Presenter wording:** “This is an append-only *convention* in a local JSONL log, not a tamper-evident evidence ledger.”

### 2.5 Show the negative policy boundary

In the Agentic browser UI, click **Try forbidden production request**. Expect a denied proposal (`TARGET_NOT_ALLOWED`) and a disabled approval button. **Do not click Execute on a previous candidate** after this demonstration.

## 3. Troubleshooting and safe fallback

| Symptom | Safe response | What to say |
|---|---|---|
| `make wjax-demo-check` fails for token/RBAC | Run `make wjax-demo-auth`, then repeat `make wjax-demo-check`. Never replace demo kubeconfig with the admin kubeconfig. | “Executor credentials are constrained and must pass a preflight.” |
| Ollama not reachable / `/api/propose` returns `AI_UNAVAILABLE` | Check `ollama list` and whether its local service is running. Do not claim an AI result. If not quickly recoverable, show the already collected prior evidence and explain the expected flow. | “A failed AI assessment cannot bypass policy.” |
| Drift changes to `0/0`, but the live reader or diagnostics does not update | Retry **Refresh live status**, `make wjax-demo-status` and `make wjax-demo-diagnose`; show the exact `kubectl --context kind-wjax-demo` result. | “Read-side availability is separate from the policy-controlled execution path.” |
| Proposal denied or model returns an unexpected candidate | Do **not** change candidate, policy, or approval tokens by hand. Explain the fail-closed behavior; use the known baseline or a backup screenshot for the remainder. | “Unexpected model output is not trusted.” |
| Apply returns `APPLY_SUBMITTED_NOT_READY` | Wait for Kubernetes readiness and run the separate verifier. Do not announce success prematurely. | “Applying a manifest is not the same as verifying the result.” |
| Recovery verification fails | Do not edit `evidence.jsonl` or force `RECOVERY_VERIFIED`. Show observed Kubernetes state and disclose the failure. | “Evidence is meaningful precisely because we allow the demo to fail visibly.” |
| Local HTTP service stops | Check `make wjax-demo-status` and `.wjax-local-logs/*.log`. Restart with `make wjax-demo-stop && make wjax-demo-check && make wjax-demo` only if safe. | “The demo isolates read, authorization and execution paths.” |

**Recovery after rehearsal (not during the audience story):** to return the local kind workload to its expected healthy baseline, an operator may use the explicit **admin** context; this bypasses the *demo approval story* and must never be presented as an OpenKubes authorization outcome:

```bash
kubectl --context kind-wjax-demo -n wjax-demo scale deployment/wjax-nginx --replicas=2
kubectl --context kind-wjax-demo -n wjax-demo rollout status deployment/wjax-nginx --timeout=90s
```

If a complete fresh approval/evidence story is needed for a second rehearsal, preserve the old JSONL log outside Git and plan a new controlled drift/approval/execution. Note that the verifier examines the **latest** `EXECUTOR_APPLIED` entry and refuses to overwrite terminal failures; it is intentionally not a “reset button.”

## 4. Final checks: the evening before and on stage

```bash
# Quick health and security confirmation:
make wjax-demo-status
make wjax-demo-diagnose
make wjax-demo-check
kubectl --context kind-wjax-demo -n wjax-demo get deploy wjax-nginx

git status --short
git ls-files | grep -E '(^|/)(\.demo-kubeconfig\.json|evidence\.jsonl)$' \
  && echo 'STOP: unexpected runtime file tracked' \
  || echo 'PASS: runtime files not tracked'
```

Make sure the laptop is powered, the local Ollama model is cached, the demo browser tabs are open, terminal history does not show tokens, and no update/rebuild is running. **Do not delete the kind cluster or the evidence log before the talk.**

## 5. Release and documentation notes

- This runbook documents the known, locally verified flow at `d25cfd8`; it does not imply the current branch was merged into `main`.
- Existing `demos/wjax-2026/README.md` contains **legacy standalone** setup instructions (`./setup.sh`, credential location, port `8787`); for the integrated portable demo, **follow this runbook and root `Makefile` instead**. The readme can be refreshed in a separate documentation-only change.
- `make wjax-demo-verify` is a separate manual verification step. The demo's read-only provider is **not** a deployed kagent integration, and `MANUAL_REVIEW_REQUIRED` is advisory, not an autonomous execution authorization.
- Do not confuse the bounded local ServiceAccount with an enterprise-level authorization policy or signed evidence.

---

**One-line close:** **AI thinks. OpenKubes executes. Evidence proves.**
