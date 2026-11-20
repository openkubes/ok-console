# OK-shared bootstrap recovery profile

This is a deliberately explicit, reversible recovery profile for a controlled
maintenance window. It is not a startup fallback and must never be applied
automatically.

The checked-in overlays are templates. The post-recovery overlay pins the
reviewed break-glass rc.3 digest; the Bootstrap overlay pins the released
bootstrap build recorded in `image-provenance.json` (see Recovery image).
Generate a new single-use manifest pair for every recovery:

```bash
node deploy/kubernetes/render-ok-shared-recovery.mjs \
  /secure/operator/path/ok-shared-recovery-<change-id>
```

The renderer refuses an existing output directory and generates distinct random
Bootstrap and post-recovery deployment epochs and authorization revisions. Do
not apply the template overlays directly. Do not reuse a generated manifest
pair in a later recovery.

## Recovery image

The Bootstrap manifest must run a bootstrap-built image
(`VITE_CONSOLE_AUTH_MODE=bootstrap`, label `io.openkubes.console.auth-mode=bootstrap`):
the SPA mode is fixed at build time, so the break-glass rc.3 image would keep
offering the identity provider. `image-provenance.json` records that image and
`kustomization.yaml` pins the same digest. Until a bootstrap build is released,
both hold the all-zero sentinel and the renderer refuses to generate a bundle.

Releasing it is a separate, authorized step:

1. Check the build is reproducible:
   `deploy/kubernetes/verify-recovery-image.sh local <commit>`.
2. Publish a `dev-v*` tag of that commit (`publish-dev-image` builds `dev-v*` as
   bootstrap and `dev-breakglass-v*` as break-glass).
3. Verify the published image:
   `deploy/kubernetes/verify-recovery-image.sh registry ghcr.io/openkubes/ok-console@<digest> <updated image-provenance.json>`.
4. Record `releaseTag`, `revision` and `digest` in `image-provenance.json` and the
   same digest in `kustomization.yaml`, in a reviewed change.

## Rehearsal gate

1. Confirm operator custody of the approved bootstrap credential and announce
   the maintenance window.
2. Generate a new manifest pair. Record `recovery-evidence.json`, inspect both
   exact manifests, and do not continue if either digest or the context differs.
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
