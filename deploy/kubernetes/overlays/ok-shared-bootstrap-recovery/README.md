# OK-shared bootstrap recovery profile

This is a deliberately explicit, reversible recovery profile for a controlled
maintenance window. It is not a startup fallback and must never be applied
automatically.

The profile is pinned to the reviewed Console rc.3 digest and changes only the
authentication boundary: OIDC is disabled, Bootstrap is enabled, and the
session epoch/authorization revision advance to invalidate prior sessions.

## Rehearsal gate

1. Confirm operator custody of the approved bootstrap credential and announce
   the maintenance window.
2. Render and inspect the exact manifest; do not apply if the digest or context
   differs.
3. Apply this overlay with the approved kubeconfig and wait for 2/2 readiness.
4. Verify the bootstrap route and that an old OIDC session is rejected.
5. Remove expired/outstanding rows from `ok_console.oidc_transactions` using the
   approved database operator procedure; never print credentials or tokens.
6. Restore the reviewed BreakGlass overlay, advance the epoch again, wait for
   readiness, and verify OIDC callback/session/logout before reopening access.

The repository records the rendered profile; the operator must record the
actual revisions, timestamps, and browser/API results in the OK-170 evidence.
