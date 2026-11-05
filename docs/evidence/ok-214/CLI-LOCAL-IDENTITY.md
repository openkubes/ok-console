# OK-214 Gate 2 verification — 2026-11-05

Scope: non-production, host-process `ok-local` only. Base `37294f2`;
architecture acceptance `openkubes/openkubes@5af40a5`. No architecture repository,
existing deployment overlay or Developer Workspace implementation was modified.

## Complete journey

`bff/security/localIdentity.integration.test.mjs` runs a disposable PostgreSQL 16
instance, generated short-lived loopback TLS certificate and the real BFF. HTTP runs
under a non-owner database role with bounded grants and INSERT-only audit privileges;
identity tables have a separate NOLOGIN owner from sessions.

Verified:

1. Existing named Bootstrap authentication issues the existing opaque cookie pair.
2. The authenticated one-time transition creates a named ordinary administrator.
3. The actual CLI, driven through a PTY with protected input, authenticates that admin,
   creates/lists an ordinary user, and disables that user. Passwords are not echoed.
4. An ordinary user signs in over verified HTTPS, restores a session and reads the
   configured Console projection without any external provider.
5. After disablement, password login, session restoration, rotation and protected
   reads reject the user, including across login/disable/rotation races.
6. Chromium signs the same class of ordinary user into the built Console. Application
   localStorage/sessionStorage remain empty; disablement returns 401 and reload returns
   to sign-in. The browser displays Local development, not BreakGlass/MFA.

Chromium uses a test-only certificate exception; API and actual CLI requests verify the
issued CA and IP SAN. The application/CLI has no insecure-TLS switch. The attended
provisioning helper also runs through a PTY and verifies 0700/0600 output permissions.

## Commands and results

| Verification | Result |
|---|---|
| `OK_CONSOLE_TEST_LOCAL_BROWSER=true pnpm test:postgres` after a local-mode build | **26 passed, zero skipped**: 14 local-identity/lifecycle tests plus 12 existing ADR-038 PostgreSQL tests |
| Focused BFF/auth/Workspace/identity/App regression run | **636 passed**; database suites run separately above |
| New startup/HTTP boundary unit suite | **18 passed**; included in regression/full-suite counts |
| `pnpm exec vitest run --reporter=json ...` | **768 passed, 23 baseline failures, 26 skipped**; database suites are deliberately skipped without their disposable URL |
| `pnpm lint` | Passed |
| `pnpm build` | Passed |
| `VITE_CONSOLE_DATA_MODE=bff VITE_CONSOLE_AUTH_MODE=local pnpm build` | Passed |
| `git diff --check` | Passed |

The last small auth-source wording change was separately verified by all **12 auth
client/component tests**, lint and build. No broader behavior changed afterward.

Security evidence includes:

- authenticated/non-admin/CSRF/Origin rejection; generic credential failures;
- single-use initialization and concurrent last-administrator protection;
- session-family rotation/revocation conformance and local account-revision checks;
- login/disable/rotate races across independent stores;
- audit-trigger failure rolls back user creation, disablement and session issuance;
- missing identity/session/throttle tables deny access;
- ordinary throttling is durable and does not consume exceptional-access buckets;
- unavailable external discovery does not prevent local startup/login;
- separately authorized, explicitly enabled recovery invalidates prior sessions;
- runtime role cannot modify audit history, create identity tables or alter sessions;
- unsupported production/public/wildcard/prototype/disabled-session configurations reject.

## Pre-existing failures — separate from OK-214

Untouched main was tested before implementation: **747 passed, 23 failed, 12 skipped**.
The full implementation suite has the identical 23 failing file/case identities; a
normalized comparison of baseline failure headings and current JSON results found no
new failing case. Files/counts:

- `deploy/kubernetes/ok170.test.ts`: 2
- `deploy/kubernetes/ok172.test.ts`: 2
- `deploy/kubernetes/ok200-capture.test.ts`: 7
- `deploy/kubernetes/ok200.test.ts`: 12

The full suite remains red. Prior baseline records describe missing Python YAML and
platform-specific deployment/diagnostic assumptions; this work does not claim to have
resolved or completely diagnosed them. They are not waived by the local identity tests.

## Limits, risk and effort

- No production acceptance, MFA enrollment, public exposure, Kubernetes overlay,
  cluster grants, Projects, general role administration, deletion or real admin UI.
- Only an explicitly authorized Console reader grant is created. Test fleet data is
  fixture data; no real Kubernetes authority was granted or exercised.
- Local PostgreSQL, protected recovery custody, private file permissions and trusted
  TLS material remain installation prerequisites. No HA/failover certification.
- Existing exceptional verifier parameters are preserved; ordinary users use the new
  reviewed scrypt profile. Password hashing can consume substantial local memory.
- A compromised BFF/host remains a trusted-boundary compromise. Deliberate republication
  by a host administrator is unsupported, not prevented by a profile label.
- Reads already authorized before a disable commit may finish; disclosed data cannot
  be retracted. Subsequent session use is rejected.
- OIDC discovery failure in this profile returns bounded 503s for OIDC routes; a restart
  retries discovery. No scheduler or new identity provider was added.
- Automated implementation and verification took approximately 25 minutes of one agent
  session, versus the 5–8 person-day planning estimate. This is elapsed automation time,
  not measured human engineering/review effort or production security certification.

Recommendation: **GO for human review and merge of this bounded non-production feature**,
subject to the repository's normal review/check policy. Keep the implementation PR Draft
until reviewed. No automatic merge or deployment.
