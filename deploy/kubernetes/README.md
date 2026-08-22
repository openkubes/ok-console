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
- The five referenced Secret objects are not included. Provision them through the
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
2. provision the five referenced Secrets outside Git, including the explicit
   producer CA and Console BFF workload certificate/key;
3. add narrow ingress, DNS, PostgreSQL, OIDC, and observed-state NetworkPolicies;
4. confirm the CNI enforces NetworkPolicy and the namespace enforces Restricted
   Pod Security;
5. validate resource sizing under concurrent scrypt attempts;
6. test readiness, rollout, disruption, database failure, and rollback; and
7. attach image SBOM, provenance/signature, vulnerability, and target-cluster
   policy Evidence to OK-166.

Apply only the completed overlay, not this fail-closed base directory.

## OK-169 local Kind deployment proof

The `overlays/local-kind` path is an intentionally separate, development-only
projection of the secure base. It runs one replica with the deterministic
fixture source and disables session persistence, OIDC, and exceptional local
accounts. It neither needs nor creates application Secrets. The base directory
retains every production safety stop described above.

Run the complete local proof from the repository root:

```bash
./deploy/kubernetes/verify-local-kind.sh
```

The verifier requires a clean source tree, builds the current revision, creates
the bounded `ok-console-ok169` Kind cluster, loads the image,
renders the overlay, rejects unresolved production placeholders, waits for the
rollout, verifies the requested image, OCI source revision, and runtime security
projection, proves a restart rollout, and exercises the liveness, readiness, and
Console routes. The verifier refuses to modify a pre-existing cluster with the
same name. Its newly created cluster is deleted after the proof.

To retain it for visual inspection:

```bash
OK_CONSOLE_KEEP_CLUSTER=true ./deploy/kubernetes/verify-local-kind.sh
kubectl --context kind-ok-console-ok169 \
  --namespace openkubes-console \
  port-forward service/ok-console 8787:8787
```

Then open <http://127.0.0.1:8787>. Delete the retained cluster explicitly when
finished:

```bash
kind delete cluster --name ok-console-ok169
```

To verify a published candidate, select it by digest, never only by tag:

```bash
OK_CONSOLE_IMAGE='ghcr.io/openkubes/ok-console@sha256:<64-hex-digest>' \
OK_CONSOLE_EXPECTED_REVISION='<40-hex-git-revision>' \
./deploy/kubernetes/verify-local-kind.sh
```

The local overlay preserves non-root execution, the read-only root filesystem,
dropped capabilities, disabled ServiceAccount token mounting, resource bounds,
probes, and default-deny policy. Kind's default CNI does not itself prove target
cluster NetworkPolicy enforcement; that remains an explicit later environment
gate.

## OK-170 ok-shared preview

The `overlays/ok-shared-preview` path is the first target-specific deployment
step for the shared OpenKubes development cluster. It pins the accepted rc.3
image digest and keeps the Console in fixture-backed, read-only preview mode.
OIDC, PostgreSQL, exceptional local access and the observed-state producer are
disabled until their real ok-shared dependencies and secret custody are
reviewed. It does not expose an unauthenticated Ingress.

Render and validate without changing the cluster:

```bash
./deploy/kubernetes/verify-ok-shared-preview.sh
```

After review, deployment requires an explicit apply gate:

```bash
OK_CONSOLE_APPLY=true ./deploy/kubernetes/verify-ok-shared-preview.sh
```

The verifier requires the exact `ok-shared-admin@ok-shared` context and refuses
to modify a pre-existing `openkubes-console` namespace unless it carries the
`openkubes.io/managed-by=ok-170` ownership label. The Phase A inventory and the
remaining live-integration gates are recorded in `docs/evidence/ok-170`.

## OK-172 ok-shared live slice

The `overlays/ok-shared-live` path is the render-first Phase B1 candidate. It
pins the accepted Console `dev-v0.1.0-rc.4` and observed-state producer
`console-observer-dev-v0.1.0-rc.3` digests. The Console uses PostgreSQL-backed
bootstrap sessions and the producer's explicit `hosting-cluster` source. The
source reads Kubernetes version, a bounded Node list, and the exact
`Deployment/openkubes-console/ok-console`; it installs and reads no Crossplane,
KubeVirt, or CAPI APIs.

The target-specific dependencies are the existing Ready
`ClusterIssuer/ok-shared-internal-ca`, CloudNativePG, `StorageClass/local-path`,
Traefik `IngressClass/ok-ingress`, CoreDNS, and Cilium's explicit
`kube-apiserver` entity. The verifier fails if those facts drift. Certificates
use separate server and client identities; the producer requires the exact
Console SPIFFE URI. NetworkPolicies permit only Traefik ingress, DNS,
PostgreSQL, producer mTLS, and the producer's Kubernetes API read path.
The CNPG operator may reach only the database instance-manager status port
`8000`; application traffic remains restricted to Console pods on `5432`.

Render, perform server-side admission dry-run, and change no cluster state:

```bash
./deploy/kubernetes/verify-ok-shared-live.sh
```

The live field manager explicitly takes ownership of the reviewed Console image
and mode fields previously owned by `ok-170-preview`. Both dry-run and apply use
the same bounded server-side conflict policy, so the Preview-to-Phase-B1
transition cannot be an accidental client-side merge.
The existing Preview ingress-policy identity is deliberately reused and
narrowed to Traefik, preventing the old same-namespace allow rule from
remaining as an additive policy after the transition.

Two application Secrets are deliberately absent from Git. Provision them from
an interactive TTY; the password is hidden, confirmed, never passed in process
arguments, and never printed. The provisioner refuses implicit rotation:

```bash
OK_CONSOLE_APPLY_BOOTSTRAP=true \
  node ./deploy/kubernetes/provision-ok-shared-bootstrap.mjs
```

Store the entered password immediately in the approved credential manager.
Then apply through the explicit live gate:

```bash
OK_CONSOLE_APPLY_LIVE=true ./deploy/kubernetes/verify-ok-shared-live.sh
```

The verifier waits for all certificates, the CNPG database, the producer and
the Console; checks both immutable images and producer allow/deny RBAC; and
proves health, readiness, static delivery, and unauthenticated API denial. It
does not print Secret data and contains no delete or rollback mutation.
The protected projection denial is the BFF contract's bounded `403 FORBIDDEN`;
credential rejection on the dedicated bootstrap authentication route remains
the separate `401` boundary.

The lab route is `https://console.ok-shared.internal:30443`. Resolve that name
to an `ok-shared` node and trust only the public CA certificate carried in
`Secret/ok-console-ingress-tls`. The initial username is `arash`; every login
also requires a 12–512 character operational reason and writes credential-free
audit Evidence to PostgreSQL. OIDC remains disabled until a separate reviewed
identity-provider step replaces bootstrap access.

## Development image publication

`.github/workflows/publish-dev-image.yaml` publishes only a `dev-v*` tag whose
revision is already reachable from `main`. All workflow actions are pinned to
full commit SHAs. The workflow verifies the source, publishes a multi-platform
GHCR image, applies the HIGH/CRITICAL development vulnerability gate, produces
an SPDX SBOM, records build and SBOM attestations, and keylessly signs the exact
digest.

After the implementation is merged and green, an authorized maintainer creates
and pushes an annotated candidate tag, for example:

```bash
git switch main
git pull --ff-only
git tag -s dev-v0.1.0-rc.1 -m 'OpenKubes Console development candidate 0.1.0-rc.1'
git push origin dev-v0.1.0-rc.1
```

The repository must protect the `dev-v*` tag pattern and restrict creation and
deletion to the release maintainers. The GHCR package should be public for the
community preview unless a reviewed distribution policy says otherwise.

Use the immutable identity printed in the workflow summary. Verify its GitHub
attestation and Sigstore identity before deployment:

```bash
gh attestation verify \
  'oci://ghcr.io/openkubes/ok-console@sha256:<64-hex-digest>' \
  --repo openkubes/ok-console

cosign verify \
  --certificate-identity \
  'https://github.com/openkubes/ok-console/.github/workflows/publish-dev-image.yaml@refs/tags/dev-v0.1.0-rc.1' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  'ghcr.io/openkubes/ok-console@sha256:<64-hex-digest>'
```

A mutable discovery tag is never a deployment identity. Publication here means
**development candidate**, not stable or production-ready release.
