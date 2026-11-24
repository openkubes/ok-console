# OK-173: OIDC provider configuration and rollback to bootstrap-only

This page defines the configuration that a reviewed environment supplies to run the Console with
OIDC as the primary sign-in and local break-glass as the exceptional path, and the procedure that
rolls it back to bootstrap-only. Protocol behaviour, the subject-mapping file format and the
exceptional-access rules are specified in [`bff/README.md`](../../bff/README.md). This page does
not approve any live change: applying it to a shared environment is a separate, reviewed step.

## Provider registration

| Provider setting | Required value |
| --- | --- |
| Client type | Confidential client, client-secret authentication |
| Flow | Authorization Code only (no implicit, no direct grant) |
| PKCE | Required, `S256` |
| Redirect URI | Exactly `${OK_CONSOLE_ORIGIN}/api/console/v0/auth/oidc/callback` |
| Subject | Stable, issuer-scoped `sub`; this is the only claim that selects a mapping |

## Console configuration (OIDC primary + break-glass)

| Variable | Value |
| --- | --- |
| `OK_CONSOLE_OIDC_ENABLED` | `true` |
| `OK_CONSOLE_OIDC_PROVIDER_ID` | Stable provider identifier recorded in sessions and audit |
| `OK_CONSOLE_OIDC_ISSUER` | Exact HTTPS issuer identifier (must equal discovery `issuer`) |
| `OK_CONSOLE_OIDC_CLIENT_ID` | Registered client ID |
| `OK_CONSOLE_OIDC_CLIENT_SECRET_FILE` | Mounted Secret file with the client secret |
| `OK_CONSOLE_OIDC_SUBJECT_MAPPINGS_FILE` | Mounted reviewed subject mapping (`version: v1`) |
| `OK_CONSOLE_OIDC_TIMEOUT_SECONDS` | Optional, 1–30 (default 5) |
| `OK_CONSOLE_LOCAL_ACCESS_MODE` | `breakglass` |
| `OK_CONSOLE_LOCAL_ACCESS_ACCOUNTS_FILE` | Mounted BreakGlass account file |
| `OK_CONSOLE_LOCAL_ACCESS_PEPPER_FILE` | Mounted 32-byte base64 pepper (also keys the authentication audit) |
| `NODE_EXTRA_CA_CERTS` | Only when the issuer certificate chains to a private CA |
| SPA build | `VITE_CONSOLE_DATA_MODE=bff`, `VITE_CONSOLE_AUTH_MODE=breakglass` |

Secrets stay in Kubernetes Secrets mounted as files; none of them is passed as an environment
value or command-line argument. Sessions are scoped to `OK_CONSOLE_ENVIRONMENT_ID`, which must
equal the environment the observed-state source serves, otherwise every projection is denied.

## Rollback to bootstrap-only

1. Set `OK_CONSOLE_OIDC_ENABLED` to `false` (or remove it) and `OK_CONSOLE_LOCAL_ACCESS_MODE` to
   `bootstrap`, with a Bootstrap account file.
2. **Set a new, never-used `OK_CONSOLE_SESSION_EPOCH`.** The BFF already rejects any session
   whose sign-in method the current mode does not enable, so OIDC and BreakGlass sessions fail
   closed under bootstrap-only even with the old epoch. The new epoch is defense in depth: it
   also ends every pre-rollback session for good, so a later roll-forward cannot revive one.
3. Deploy an image whose SPA was built with `VITE_CONSOLE_AUTH_MODE=bootstrap` (image label
   `io.openkubes.console.auth-mode=bootstrap`). The SPA mode is fixed at build time: a
   break-glass build keeps offering the identity provider even when the BFF runs bootstrap-only.
   For ok-shared, use the bootstrap entry and provenance in
   `deploy/kubernetes/overlays/expected-digests.json`, checked by
   `deploy/kubernetes/verify-recovery-image.sh`. Its unreleased sentinel prevents rendering
   until the separately authorized bootstrap recovery image release step is complete.
4. Verify: the sign-in page offers no identity provider; an unauthenticated
   `GET /api/console/v0/auth/oidc/start` returns `403` with no redirect to the issuer; a
   pre-rollback session cookie returns `401` on `GET /api/console/v0/auth/session`; a Bootstrap
   sign-in shows the "Bootstrap session" label.

Roll forward by restoring the OIDC configuration with another new epoch.

## Disposable proof

`pnpm test:e2e:oidc` (Docker required) runs the Console BFF against a digest-pinned Keycloak and
PostgreSQL on loopback, with a generated test CA, and exercises the configuration and rollback
above in a real browser: see `e2e/oidc/`. It is not part of `pnpm test:e2e`.
`deploy/kubernetes/ok173-image-digests.test.ts` keeps every deployable overlay digest-pinned
(`image`, CloudNativePG `imageName` and image-volume `reference`).

The harness builds one SPA per auth mode into `dist-e2e-oidc/`, serves them through `dist/`, and
restores any existing `dist/` when it stops. Do not run it in parallel with `pnpm test:e2e` in
the same checkout.

| Variable | Effect |
| --- | --- |
| `OK_OIDC_E2E_KC_PORT`, `OK_OIDC_E2E_PG_PORT`, `OK_OIDC_E2E_BFF_PORT`, `OK_OIDC_E2E_ISSUER_PROXY_PORT`, `OK_OIDC_E2E_PROXY_PORT` | Fixed loopback ports instead of free ones |
| `OK_OIDC_E2E_SKIP_BUILD=true` | Reuse existing `dist-e2e-oidc/` builds |
| `OK_OIDC_E2E_TMPDIR` | Parent of the run directory; use a directory your Docker runtime shares (for example under `$HOME` on Colima) |
| `OK_OIDC_E2E_KEEP=true` | Keep the run directory for debugging |

The run directory holds the generated client secret, passwords and test CA key; Playwright traces
of failed tests record the typed test passwords. All of it is disposable and git-ignored, and
none of it belongs in a ticket or pull request.
