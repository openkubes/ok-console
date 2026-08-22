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

Record the final pre-PR execution here after the complete local check:

```text
Source revision: pending
Requested image: pending
Runtime image ID: pending
Tests: pending
Reviewer: pending
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
