# OpenKubes AI Thinkers — local HOTL spike

**Status: experimental / not production safe.** Original W-JAX HITL demo remains unchanged. This is a separate opt-in HOTL supervisor, intentionally scoped to the disposable local kind cluster only. It reuses the **Executor** ServiceAccount from the W-JAX lab; the AI receives no kubeconfig.

## Scope

- Trusted intent: existing \`wjax-demo/wjax-nginx\` should have exactly 2 replicas of \`nginx:1.27.5-alpine\`.
- Only action: atomically change \`spec.replicas\` **0 to 2** after two consistent 0/0 observations and an exact Ollama proposal.
- Before patch: verify same UID, generation and resourceVersion, only that name, namespace, image, selector, and local API.
- Fails closed on unexpected output, missing service, concurrent changes or unsuccessful verification.
- Logs HOTL-specific events into \`ai-thinkers-evidence.jsonl\`. This is **not cryptographically authenticated or independently verified evidence**. The read-back verification uses the same executor credentials and process.
- No production namespaces, generic remediation, background agents, or automatic cleanup. HOTL opt-in grants permission for the whole running process; Ctrl-C prevents future actions, but cannot cancel a submitted Kubernetes API request.
- Unlike the original HITL demo, this performs an automated one-shot action; **do not** confuse it with the W-JAX \`make wjax-demo-verify\` mechanism, which requires explicit HUMAN_APPROVED evidence.

## Before the demo

Use your **existing** local W-JAX kind lab (do not recreate it). From repo root:

\`\`\`bash
export DOCKER_CONTEXT=colima
export WJAX_DEMO_RUNTIME_DIR="$PWD/.wjax-local-runtime/recreated-20261125-044033"
kubectl --context kind-wjax-demo -n wjax-demo get deploy wjax-nginx
make wjax-demo-check
make wjax-demo-status
curl -fsS http://127.0.0.1:11434/api/tags >/dev/null
\`\`\`

**The runtime path above is an example from the 25 November session; use your actual active runtime.** Ensure the existing Deployment is healthy at 2/2. The original browser UI at port 8788 is still the HITL demo; it is *not* the HOTL supervisor UI.

## Show HOTL in two terminals

In terminal **A**, run the supervisor with explicit consent (only on local kind):

\`\`\`bash
export AI_THINKERS_HOTL=I_ACCEPT_LOCAL_KIND_ONLY
python3 demos/ai-thinkers/hotl.py --enable-hotl --once \
  --runtime-dir "$WJAX_DEMO_RUNTIME_DIR"
\`\`\`

Terminal A waits and observes. In terminal **B** introduce the demo drift:

\`\`\`bash
kubectl --context kind-wjax-demo -n wjax-demo scale deploy/wjax-nginx --replicas=0
kubectl --context kind-wjax-demo -n wjax-demo get deploy wjax-nginx
\`\`\`

Expected terminal A progression:

\`\`\`text
HOTL_ENABLED
DRIFT_CONFIRMED
AI_PROPOSAL
HOTL_EXECUTED
HOTL_RECOVERY_VERIFIED / READY_VERIFIED
\`\`\`

Verify with **admin observation** on the disposable lab:

\`\`\`bash
kubectl --context kind-wjax-demo -n wjax-demo get deploy wjax-nginx
\`\`\`

The HOTL log is separate from the old HITL log. The original \`make wjax-demo-verify\` is **not** valid for this flow because it intentionally refuses executions without a prior HUMAN_APPROVED event.

## Safe fallback

If the HOTL run fails or the Ollama model is slow, stop terminal A with Ctrl-C and return to the already-tested W-JAX HITL demo. Do not modify the stored JSONL evidence to simulate success. Manual admin recovery of the disposable demo is:

\`\`\`bash
kubectl --context kind-wjax-demo -n wjax-demo scale deploy/wjax-nginx --replicas=2
kubectl --context kind-wjax-demo -n wjax-demo rollout status deploy/wjax-nginx --timeout=120s
\`\`\`

Any manual recovery must be disclosed as **manual**, not HOTL evidence.

## Limitations to address before production

The implementation has no enterprise identity, tamper-evident audit, independent verifier, trusted GitOps intent, revoke protocol, scoped signed grants, escalation workflow or sophisticated retry budget. The Kubernetes RBAC from the original disposable demo can create deployments namespace-wide; that privilege must be reduced before any production use. Also add unit/integration tests and an isolated E2E test before relying on the HOTL flow in a live presentation.
