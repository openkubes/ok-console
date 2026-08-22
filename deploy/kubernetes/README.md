# OK-166 secure runtime deployment scaffold

This directory is a fail-closed starting point, not a directly deployable
production bundle. Every resource is JSON, which is also valid Kubernetes input
and allows the repository tests to inspect the complete object without a YAML
parser ambiguity.

## Deliberate safety stops

- The Deployment image uses an all-zero, syntactically valid digest. Replace it
  with the verified digest produced by the reviewed release workflow.
- `.invalid` origins and endpoints prevent accidental connection to a real
  identity provider or observed-state producer.
- `REPLACE_*` authority values must come from reviewed environment policy.
- The referenced Secret objects are not included. Provision them through the
  accepted secret-delivery system with the keys and file contracts documented
  in `.env.example`; never commit their values.
- The included NetworkPolicy is default-deny only. A target-specific overlay
  must explicitly allow trusted Gateway ingress plus DNS, PostgreSQL, OIDC, and
  observed-state egress using selectors/CIDRs that are valid for that cluster.
  Do not add a generic allow-all egress rule.
- The namespace is intentionally not created here. The operator must supply an
  existing `openkubes-console` namespace enforcing the Restricted Pod Security
  Standard and the required Secret/RBAC policy.

## Build and local inspection

```bash
docker build \
  --build-arg VCS_REF="$(git rev-parse HEAD)" \
  --tag ok-console:ok-166 \
  .

docker inspect ok-console:ok-166
```

The image builds the Vite application, retains only production Node.js
dependencies, runs as the image's non-root `node` user, writes no application
state, and serves both static assets and `/api/console/v0` from port 8787.

## Target-cluster completion

Before applying these objects, a deployment owner must:

1. replace the image digest and every `.invalid` / `REPLACE_*` value;
2. provision the four referenced Secrets outside Git;
3. add narrow ingress, DNS, PostgreSQL, OIDC, and observed-state NetworkPolicies;
4. confirm the CNI enforces NetworkPolicy and the namespace enforces Restricted
   Pod Security;
5. validate resource sizing under concurrent scrypt attempts;
6. test readiness, rollout, disruption, database failure, and rollback; and
7. attach image SBOM, provenance/signature, vulnerability, and target-cluster
   policy Evidence to OK-166.

Apply only the completed overlay, not this fail-closed base directory.
