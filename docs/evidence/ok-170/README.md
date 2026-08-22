# OK-170 ok-shared development integration evidence

Status: **Phase A preview candidate — live integration not yet claimed**

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
