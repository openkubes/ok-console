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
value or command-line argument. The mapping's `environmentId` scope must equal the environment the
observed-state source serves, otherwise every projection is denied.

## Rollback to bootstrap-only

1. Set `OK_CONSOLE_OIDC_ENABLED` to `false` (or remove it) and `OK_CONSOLE_LOCAL_ACCESS_MODE` to
   `bootstrap`, with a Bootstrap account file.
2. **Set a new, never-used `OK_CONSOLE_SESSION_EPOCH`.** Without it, OIDC sessions issued before
   the rollback stay valid until they expire; the epoch change is what rejects them.
3. Deploy the SPA built with `VITE_CONSOLE_AUTH_MODE=bootstrap`.
4. Verify: the sign-in page offers no identity provider; `GET /api/console/v0/auth/oidc/start`
   returns `403` without a redirect; a pre-rollback session cookie returns `401` on
   `GET /api/console/v0/auth/session`; a Bootstrap sign-in shows the "Bootstrap session" label.

Roll forward by restoring the OIDC configuration with another new epoch.

## Disposable proof

`pnpm test:e2e:oidc` (Docker required) runs the Console BFF against a digest-pinned Keycloak and
PostgreSQL on loopback, with a generated test CA, and exercises the configuration and rollback
above in a real browser: see `e2e/oidc/`. It is not part of `pnpm test:e2e`.
`deploy/kubernetes/ok173-image-digests.test.ts` keeps every deployable overlay digest-pinned.
