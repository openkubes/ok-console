# OK-173 break-glass overlay

This overlay is a reviewed candidate profile; it is not the default live
profile. It inherits the bounded read-only `ok-shared-live` resources and
changes only the Console authentication boundary:

- immutable Console image `sha256:20860b2f...68600f`;
- OIDC enabled with the `openkubes` Keycloak realm;
- local access changed from Bootstrap to BreakGlass;
- internal Keycloak CA mounted through `NODE_EXTRA_CA_CERTS`;
- egress restricted to the existing Traefik HTTPS path;
- session epoch and authorization revision advanced for the Phase B2 slice.

The overlay requires these namespace-local Secrets before apply:

- `ok-console-oidc` with `client-secret` and `subjects.json`;
- `ok-console-oidc-ca` with `ca.crt` containing the approved
  `ok-shared-internal-ca` trust root.

Apply only through the OK-173 reviewed deployment gate after the immutable
image, OIDC callback, subject mapping, and browser evidence have been checked.
