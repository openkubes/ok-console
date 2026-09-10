# OK-173 break-glass overlay

This overlay is a reviewed candidate profile; it is not the default live
profile. It inherits the bounded read-only `ok-shared-live` resources and
changes only the Console authentication boundary:

- immutable Console image `sha256:dc98054b...79261b` (development candidate
  `dev-breakglass-v0.1.0-rc.2`);
- OIDC enabled with the `openkubes` Keycloak realm;
- local access changed from Bootstrap to BreakGlass;
- internal Keycloak CA mounted through `NODE_EXTRA_CA_CERTS`;
- egress restricted to the existing Traefik HTTPS path and the approved internal
  browser endpoint (`192.168.100.207/32`);
- session epoch and authorization revision advanced for the Phase B2 slice.

The overlay requires these namespace-local Secrets before apply:

- `ok-console-oidc` with `client-secret` and `subjects.json`;
- `ok-console-oidc-ca` with `ca.crt` containing the approved
  `ok-shared-internal-ca` trust root.

Apply only through the OK-173 reviewed deployment gate after the immutable
image, OIDC callback, subject mapping, and browser evidence have been checked.

## Bootstrap-only rollback rehearsal

This is an operator-run recovery procedure, not an automatic runtime fallback.
Before applying the bootstrap profile, stop ingress exposure and verify that the
operator has the approved bootstrap credential. Apply the reviewed bootstrap
overlay with OIDC disabled and local access set to `bootstrap`, then advance
`OK_CONSOLE_SESSION_EPOCH` and roll the deployment. The epoch change invalidates
all existing opaque sessions; the PostgreSQL transaction cleanup must remove
expired and outstanding rows from `ok_console.oidc_transactions` before access
is reopened. Verify the browser/API bootstrap path, then restore the normal
OIDC profile and rotate the epoch again. Record both revisions and the browser
result in the OK-173 evidence bundle. Never delete secrets as an implicit part
of application startup.
