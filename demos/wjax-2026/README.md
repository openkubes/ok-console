# OpenKubes W-JAX local mini demo

**Not** the OpenKubes Console, **not** the OK-147 Runner, **not** production-grade authorization.

## Requirements

Docker running, `kind`, `kubectl`, Python 3.10+. On macOS: `brew install kind kubectl` if needed.

## Start

```bash
./setup.sh
python3 demo.py
```

Open http://127.0.0.1:8788, next to the existing OpenKubes Console at http://127.0.0.1:8787.

### Optional real AI with Ollama

By default `AI_MODE=rules` uses **a deterministic intent parser (NOT AI)**, clearly labeled in UI. If Ollama is installed and its local model pulled:

```bash
ollama pull llama3.2
AI_MODE=ollama OLLAMA_MODEL=llama3.2 python3 demo.py
```

If Ollama is down, proposal fails, with **no silent fallback**. Agent output is untrusted and validated against exact field schema and policy. The model never gets Kubernetes credentials.

## Demo flow

1. Click **Generate candidate** for `Deploy nginx with two replicas to the demo cluster`.
2. Check approved proposal digest and click **Approve exact proposal**.
3. Click **Execute authorized operation**, then **Refresh live status** until Ready 2/2.
4. Click **Try forbidden production request**: `TARGET_NOT_ALLOWED`; no execution button.
5. Inspect `evidence.jsonl` for append-only **local demo log** (not signed/tamper-proof evidence). Actual Kubernetes observed state is from a read-only GET performed by the demo executor's limited service account.

## Security scope and truthfulness

- **Disposable local kind cluster only**. `setup.sh` creates `kind-wjax-demo`; no writes to any other Kubernetes context. It never touches the existing OpenKubes Console.
- The executor has a 2-hour, namespace-limited token, **not** the user's admin kubeconfig. It can create Deployments in this *demo* namespace; due to Kubernetes RBAC limitations, create authorization cannot be restricted to a single resource name. Do **not** use this on a shared cluster.
- The trusted Python server, not the model, fixes Deployment name, image, namespace, replica count and manifest. The agent supplies only a proposed operation. The local browser approval is a demonstration of a human gate, not authenticated enterprise authorization.
- All HTTP binds to `127.0.0.1`. Do not port-forward/expose to a public address.
- It does **not** prove the OK-147 Lifecycle Executor, durable ledger, signed grants, independently signed evidence or atomic desired-state authorization. The local `evidence.jsonl` can be edited and is not cryptographically verifiable.
- An HTTP `apply` success is **not** readiness. Observe actual `readyReplicas` in Kubernetes. If the image cannot be pulled, show the actual failure.
- Run `./setup.sh` again after the short-lived token expires.

## Cleanup

```bash
kind delete cluster --name wjax-demo
rm -f .demo-kubeconfig.json evidence.jsonl
```

## Local smoke test

```bash
python3 -m unittest test_demo.py -v
```
