# OK-shared bootstrap recovery profile

This is a deliberately explicit, reversible recovery profile for a controlled
maintenance window. It is not a startup fallback and must never be applied
automatically.

The checked-in overlays are templates pinned to the Console digest recorded for
each overlay in `../expected-digests.json`. The bootstrap entry is deliberately unreleased: an all-zero digest, empty platforms,
and null provenance values. The renderer refuses before creating output. The break-glass
entry retains its reviewed image and cannot substitute for a bootstrap build.

Complete the separately authorized [bootstrap recovery image release step](../../../../docs/evidence/ok-170/maintenance-procedure.md#bootstrap-recovery-image-release)
first. No bypass or provenance override is supported. After release, generate a new
single-use manifest pair for every recovery:

```bash
node deploy/kubernetes/render-ok-shared-recovery.mjs \
  /secure/operator/path/ok-shared-recovery-<change-id>
```

The renderer refuses an existing output directory and generates distinct random
Bootstrap and post-recovery deployment epochs and authorization revisions. Do
not apply the template overlays directly. Do not reuse a generated manifest
pair in a later recovery.

Offline checks prove the record is well-formed, distinct from the recorded break-glass image and that the unreleased sentinel blocks rendering. They do not prove which build an image is. Bootstrap build identity (auth-mode=bootstrap label, GitHub build attestation from publish-dev-image, exact platform map) is established only by `verify-recovery-image.sh registry` against the staged release tree, and its output is attached to the reviewed release PR.

`verify-recovery-image.sh local <rev>` validates the working tree’s record and overlay pins, then builds a clean archive of `<rev>`. This allows review of a staged release record before committing it; a released record must name that revision.

## Rehearsal gate

1. Confirm operator custody of the approved bootstrap credential and announce
   the maintenance window.
2. Generate a new manifest pair. Record `recovery-evidence.json`, inspect both
   exact manifests, and do not continue if the digest or context differs.
3. Apply `bootstrap.yaml` with the approved kubeconfig and wait for 2/2
   readiness.
4. Verify the bootstrap route and that an old OIDC session is rejected.
5. Remove expired/outstanding rows from `ok_console.oidc_transactions` using the
   approved database operator procedure; never print credentials or tokens.
6. Apply `post-recovery.yaml`, wait for readiness, then prove the old session and
   transaction remain rejected and verify OIDC callback/session/logout before
   reopening access.

The repository records templates only. The generated files are single-use
operator artifacts and must not be committed. Record their non-secret epoch and
revision identifiers, timestamps, bounded database result, and browser/API
results in the OK-170 evidence.
