# OK-170 ok-shared development integration evidence

Status: **STOP — Phase B development deployment observed; acceptance/promotion not approved**

This record supersedes the Phase-A-only acceptance wording below. The current
development deployment is useful for recovery work, but it is not a completed
live-integration claim. Independent review requires the predecessor tickets to
reach GO and a fresh Phase-B evidence bundle before promotion.

## Current Phase-B observation (2026-09-10)

- Console: 2/2 Ready on `ok-shared`, BreakGlass/OIDC/PostgreSQL profile;
  running digest `sha256:dc98054b520bb89b4b8aae1b77e1da8ffa86bbdf359efbeb9e350caa3a79261b`.
- Observed-state producer: 1/1 Ready, read-only mTLS path exercised;
  running digest `sha256:2af5f7fe9612a4fe006fbb931f47356d0e797339542d9012752a9208e8cd359c`.
- GitHub verify run `34454450914` is green, but CI does not replace independent
  review or live recovery evidence.

The following acceptance gates remain open: deploy an image containing the
merged tenant-scope fix, prove scalar redaction and strict partial semantics,
complete real browser OIDC/session/logout and adversarial-token evidence,
rehearse producer outage and bootstrap-only rollback with epoch/transaction
verification, and record the exact final rendered manifests and evidence.

Until those gates are complete, keep this environment in development status and
do not promote it as production-ready.

## Identified target

- Context: `ok-shared-admin@ok-shared`
- Cluster: `ok-shared`
- Purpose: shared OpenKubes development environment for the Console
- Kubernetes: v1.34.1
- Nodes: one control-plane and three workers
- Architecture/runtime: amd64, Talos v1.9.5, containerd 2.0.3
- CNI/policy surface: Cilium NetworkPolicy resources are available
- Ingress: Traefik with `ok-ingress`; external LoadBalancer allocation is pending
- Identity: Keycloak is healthy at `https://keycloak.ok-shared.internal/`
- Database: CloudNativePG controller is healthy
- Certificates: cert-manager and `ClusterIssuer/ok-shared-internal-ca` are healthy
- Secret delivery: Vault and Vault Secrets Operator are installed

The inventory was read-only. No Secret content was retrieved.

## Phase A: immutable visual preview

The `ok-shared-preview` overlay selects the accepted Console candidate by the
exact digest:

```text
ghcr.io/openkubes/ok-console@sha256:04e5541fe9af040b1ca330ce632a74b20fab58489619c16a41db9f8b2d28441d
```

It creates only the task-owned `openkubes-console` namespace and the existing
Console base resources. It preserves the restricted runtime and default-deny
policy. OIDC, PostgreSQL, local access and the observed-state producer are
disabled; data is fixture-backed and read-only. Access is initially bounded to
port-forwarding rather than publishing an unauthenticated Ingress.

Run a render-only preflight:

```bash
./deploy/kubernetes/verify-ok-shared-preview.sh
```

After the PR is reviewed and merged, explicitly apply and verify:

```bash
OK_CONSOLE_APPLY=true ./deploy/kubernetes/verify-ok-shared-preview.sh
```

The verifier refuses a different current context, refuses a pre-existing
namespace it does not own, rejects unresolved placeholders or Secret objects,
verifies rollout/image/security state, and exercises liveness, readiness and
the Console root through a bounded local port-forward.

## Phase B blockers for live observed state

The target currently has no OpenKubes, Crossplane or KubeVirt CRDs. In
particular, the producer's namespaced `KubeVirtClusterClaim` source does not
exist, so deploying it now would create a misleading partial integration.

Before Phase B:

1. establish the reviewed OpenKubes management-plane CRD/controller source in
   `ok-shared`, or revise the producer source contract explicitly;
2. publish and verify an immutable observed-state producer image;
3. create the reviewed Keycloak realm/client and subject mappings;
4. provision a dedicated Console CloudNativePG cluster and migration job;
5. issue producer/server and Console/client certificates through the accepted
   CA and Vault custody profile;
6. add narrow DNS, OIDC, PostgreSQL and producer egress policies; and
7. exercise failure, redaction, rollback and cleanup without silently falling
   back to fixtures.

Phase A is not acceptance evidence for OK-162, OK-163 or OK-168. It proves only
that the accepted GUI candidate can run safely on the identified target while
the live dependency gates remain explicit.

## Phase A deployment result

Deployment was performed on 2026-08-22 after PR #29 merged into `main` as
revision `358945a641ce77b039b2dfd8e210c99c0c1b893b`.

The guarded verifier completed successfully with:

```text
Context: ok-shared-admin@ok-shared
Namespace: openkubes-console
Deployment: ok-console
Desired / updated / available replicas: 2 / 2 / 2
Image: ghcr.io/openkubes/ok-console@sha256:04e5541fe9af040b1ca330ce632a74b20fab58489619c16a41db9f8b2d28441d
Runtime security: automount token=false, read-only root=true,
privilege escalation=false, capabilities dropped=ALL
Mode: fixture/read-only
```

Both Pods were Ready with zero restarts and scheduled on separate worker nodes.
The running container image IDs matched the accepted immutable candidate. The
namespace enforced Restricted Pod Security and carried the expected
`openkubes.io/managed-by=ok-170` ownership label. The Service remained
ClusterIP-only, the PodDisruptionBudget allowed one disruption, and both the
default-deny and same-namespace-only preview policies were present.

The verifier exercised `/health/live`, `/health/ready`, and the React root page
through a temporary local port-forward. No Ingress, Secret, OIDC client,
PostgreSQL database, certificate, producer, OpenKubes CRD, or mutation workflow
was created. The preview remains deployed for bounded inspection; its existence
must not be described as live observed-state or production authentication
evidence.

For another bounded visual session:

```bash
kubectl --context ok-shared-admin@ok-shared \
  --namespace openkubes-console \
  port-forward service/ok-console 8787:8787
```

Then open <http://127.0.0.1:8787>. Stopping the port-forward removes external
access but leaves the verified preview workload running.
