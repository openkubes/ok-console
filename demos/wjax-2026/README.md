# OpenKubes W-JAX local mini demo

**Not** the OpenKubes Console, **not** the OK-147 Runner, **not** production-grade authorization.

## Start with the hands-on guide

Follow [TUTORIAL.md](TUTORIAL.md) for the complete fresh-clone macOS/Apple Silicon guide. Create the kind cluster, namespace and initial Deployment explicitly; provision the Reader and Executor separately; start Ollama; then use `make wjax-demo` from the repository root to launch four local services. No sibling Reader repository is required.

The two setup scripts only provision their respective RBAC and temporary credentials under `.wjax-local-runtime/`. They do not create a cluster or reset an application Deployment. They refuse existing credentials rather than renewing them silently. The tutorial explains safe new-session provisioning when tokens expire.

## Demo flow

1. Click **Generate candidate** for `Deploy nginx with two replicas to the demo cluster`.
2. Check approved proposal digest and click **Approve exact proposal**.
3. Click **Execute authorized operation**, then **Refresh live status** until Ready 2/2.
4. Click **Try forbidden production request**: `TARGET_NOT_ALLOWED`; no execution button.
5. Inspect `.wjax-local-runtime/evidence.jsonl` (or the selected runtime directory) for append-only **local demo log** (not signed/tamper-proof evidence). Actual Kubernetes observed state is from a read-only GET performed by the demo executor's limited service account.

## Security scope and truthfulness

- **Disposable local kind cluster only**. `setup.sh` validates the existing `kind-wjax-demo`; no writes to any other Kubernetes context. It never touches the existing OpenKubes Console.
- The executor has a requested 8-hour, namespace-limited token, **not** the user's admin kubeconfig. It can create Deployments in this *demo* namespace; due to Kubernetes RBAC limitations, create authorization cannot be restricted to a single resource name. Do **not** use this on a shared cluster.
- The trusted Python server, not the model, fixes Deployment name, image, namespace, replica count and manifest. The agent supplies only a proposed operation. The local browser approval is a demonstration of a human gate, not authenticated enterprise authorization.
- All HTTP binds to `127.0.0.1`. Do not port-forward/expose to a public address.
- It does **not** prove the OK-147 Lifecycle Executor, durable ledger, signed grants, independently signed evidence or atomic desired-state authorization. The local `evidence.jsonl` can be edited and is not cryptographically verifiable.
- An HTTP `apply` success is **not** readiness. Observe actual `readyReplicas` in Kubernetes. If the image cannot be pulled, show the actual failure.
- Preserve expired credentials and select a new runtime session as described in the tutorial. Setup refuses to overwrite them.

## Stop and test

From the repository root, `make wjax-demo-stop` stops launcher-owned services while preserving the cluster and local evidence. Run the focused tests without contacting Kubernetes:

```bash
python3 -m unittest discover -s demos/wjax-2026 -p 'test_*.py' -v
```
