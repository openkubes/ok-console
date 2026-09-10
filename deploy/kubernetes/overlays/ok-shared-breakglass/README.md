# OK-173 break-glass overlay

This overlay is a reviewed candidate template; it is not the default live
profile and must not be applied directly. It inherits the bounded read-only
`ok-shared-live` resources and defines this Console authentication boundary:

- immutable Console image `sha256:705edc32...e8ccbc` (development candidate
  `dev-breakglass-v0.1.0-rc.3`);
- OIDC enabled with the `openkubes` Keycloak realm;
- local access changed from Bootstrap to BreakGlass;
- internal Keycloak CA mounted through `NODE_EXTRA_CA_CERTS`;
- egress restricted to the existing Traefik HTTPS path and the approved internal
  browser endpoint (`192.168.100.207/32`); and
- generated, single-use post-recovery session epoch and authorization revision.

The overlay requires these namespace-local Secrets before apply:

- `ok-console-oidc` with `client-secret` and `subjects.json`;
- `ok-console-oidc-ca` with `ca.crt` containing the approved
  `ok-shared-internal-ca` trust root.

Apply only through the OK-173 reviewed deployment gate after the immutable
image, OIDC callback, subject mapping, and browser evidence have been checked.

## Bootstrap-only rollback rehearsal

This is an operator-run recovery procedure, not an automatic runtime fallback.
Before applying it, stop ingress exposure and verify custody of the approved
bootstrap credential. Generate a new single-use Bootstrap/post-recovery pair:

```bash
node deploy/kubernetes/render-ok-shared-recovery.mjs \
  /secure/operator/path/ok-shared-recovery-<change-id>
```

The renderer creates distinct random epochs and authorization revisions and
refuses an existing output directory. Never apply the checked-in templates,
reuse generated manifests, or restore a prior epoch/revision.

Apply the generated Bootstrap manifest, prove prior sessions are rejected, and
remove expired/outstanding `ok_console.oidc_transactions` rows through the
approved database procedure. Apply the generated post-recovery manifest, prove
old sessions and transactions remain rejected, and verify browser OIDC callback,
session, and logout before reopening access. Record the non-secret generated
identifiers and results in the evidence bundle. Never delete Secrets as an
implicit part of application startup.
