# OK-169 first development image and local deployment evidence

Status: **implementation in progress — publication and independent review pending**

## Candidate contract

OK-169 separates three identities that must not be conflated:

1. `ok-console:local` or `ok-console:ok-169-<revision>` is a workstation build;
2. `ghcr.io/openkubes/ok-console@sha256:<digest>` is an immutable development
   deployment candidate when its supply-chain evidence passes; and
3. no production release exists until an environment-specific security and
   operational review accepts the remaining gates.

Only the digest is a deployment identity. Tags are discovery aids.

## Implemented evidence path

* trusted `dev-v*` tag publication with candidate revision ancestry on `main`;
* least-privilege GitHub permissions and immutable action SHAs;
* multi-platform GHCR build with OCI source revision;
* HIGH/CRITICAL development vulnerability gate;
* SPDX SBOM plus GitHub build and SBOM attestations;
* Sigstore keyless signing and identity verification;
* isolated local Kind overlay derived from the fail-closed base;
* fixture/read-only runtime without application Secrets or external services;
* automated rollout, requested-image, OCI-revision, probe, and UI checks; and
* bounded cleanup of only the cluster created by the verifier.

## Local implementation evidence

Final clean-tree implementation check on 2026-08-22:

```text
Source revision: 4683519668e517247818064fc534d846cf69c008
Verified OCI revision: 4683519668e517247818064fc534d846cf69c008
Requested image: ok-console:ok-169-4683519668e5
Runtime image ID: docker.io/library/import-2026-08-22@sha256:c9187b0a1f67a93101b0210a216198d87fc0317ac63fcae6b4156c2195d5e258
Runtime NODE_ENV: production
Runtime security projection: automount=false, runAsNonRoot=true,
  readOnlyRootFilesystem=true, allowPrivilegeEscalation=false, drop=ALL
Rollout restart: passed
Liveness, readiness, and Console root: passed
Cluster cleanup: passed
Vitest: 146 passed, 12 PostgreSQL integration tests skipped without the opt-in database URL
Deployment invariant tests: 8 passed
ESLint, TypeScript, Vite production build: passed
Actionlint 1.7.12 (checksum verified): passed
Independent reviewer: pending
```

## Publication evidence

Complete after the implementation PR is merged and the protected candidate tag
has executed successfully:

```text
Candidate tag: pending
Source revision: pending
Workflow run: pending
Immutable GHCR digest: pending
SBOM attestation: pending
Build provenance: pending
Cosign verification: pending
Vulnerability gate: pending
Local Kind deployment of published digest: pending
```

Do not mark OK-169 complete while these values are pending.

## Honest remaining boundary

The local Kind path demonstrates packaging and deployment mechanics. It does not
prove production OIDC, PostgreSQL, certificate custody, observed-state access,
NetworkPolicy enforcement, ingress/TLS termination, HA, SLOs, backup/restore,
or production rollback. The secure base remains deliberately unusable until a
target-specific overlay supplies and verifies those controls.
