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

## Initial implementation commands and results

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
client/component tests**, lint and build. The later CI-only correction below changes
test selection/execution, not authentication behavior.

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
The initial full implementation run without a database URL had the identical 23
failing file/case identities. That comparison did not cover database-enabled parallel
execution: the subsequent read-only review reproduced two additional failures from
shared-database test interference. The CI correction below addresses that distinct
blocker. The 23 baseline failures remain in these files:

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

## CI PostgreSQL isolation correction — 2026-11-05

The default parallel Vitest run allowed both PostgreSQL suites to truncate the same
database concurrently. The read-only review reproduced failures in the complete local
identity lifecycle and existing session cleanup. This was a new CI-runner issue,
separate from the 23 baseline deployment-test failures above.

Only `package.json`, the verification/tagged-image workflows and this evidence file
change for the correction. No IAM implementation, test assertions or deployment
manifests change. Both database-enabled workflows now use:

1. `pnpm test:non-postgres`: all other suites retain normal file parallelism; only the
   two PostgreSQL files are selected out of this phase.
2. A local-mode frontend build followed by
   `OK_CONSOLE_TEST_LOCAL_BROWSER=true pnpm test:postgres`: the existing
   `--no-file-parallelism` mechanism executes both PostgreSQL files serially, including
   the actual browser test. Neither suite nor any individual case is suppressed.

The tagged-image workflow now provisions Chromium and its dependencies using the same
installation sequence as the existing verification workflow; enabling the browser case
must not depend on a runner cache. No image publication or deployment was invoked.

The PostgreSQL step uses `if: ${{ !cancelled() }}` so a failure in another test does not
prevent database verification. There is no `continue-on-error`: previous failures still
fail the job. The normal build remains after verification; image publishing conditions
are not relaxed. This partitions CI entrypoints rather than changing Vitest's global
parallelism or the generic `pnpm test` command.

### Reproduction and results

Verified on macOS arm64 with **Node 22.23.4**, matching CI's Node major, pnpm 10.17.1,
OpenSSL and Python 3. The official Node archive was checked against its published
SHA-256. A fresh disposable PostgreSQL 16 container was bound only to loopback, using
image digest `sha256:0cefaabd882e42bcb2a2f3dc56d3ce4770560ba62fd7f197f1a2e008fd5731ab`.
No hosted GitHub Actions success is claimed by these local results.

With `OK_CONSOLE_TEST_POSTGRES_URL` pointing only to that disposable database:

```sh
# Parallel phase; its nonzero baseline failure status remains visible.
CI=true pnpm test:non-postgres

# Separate CI step: runs even when the preceding test phase fails.
VITE_CONSOLE_DATA_MODE=bff VITE_CONSOLE_AUTH_MODE=local pnpm build
CI=true OK_CONSOLE_TEST_LOCAL_BROWSER=true pnpm test:postgres
```

| Check | Result |
|---|---|
| Database-enabled parallel phase, run twice | Each run: **768 passed, 23 known baseline failures, zero skipped** |
| Serialized PostgreSQL phase, three consecutive runs against the same fresh database | Each run: **26 passed, zero failed, zero skipped**; **78 passing executions** in total |
| Combined case catalog | **817 cases covered exactly once**: 791 parallel plus 26 serialized; no omissions or cross-phase duplicates, preserving parameterized-case multiplicity |
| Combined result for one pass through both phases | **794 passed, 23 known baseline failures, zero skipped** — not a green full suite |
| Remaining-failure comparison | Both parallel runs match all 23 baseline file/case identities exactly; no additional failure |
| Scoped authentication/runtime/OIDC/Bootstrap/BreakGlass/local-profile/Workspace/App regressions | **118 passed, zero skipped** |
| Lint; default and local-mode builds; diff whitespace check | Passed |
| Both workflow YAML files and CI command partition | Syntax and structure verified; neither workflow invokes the unpartitioned parallel database path |

The result catalogs were compared with the pre-correction full-run catalog, including
parameterized test multiplicity. Database suites were executed with the required URL
and browser flag, not counted as skipped or inferred from discovery alone. The
disposable database was removed after verification.

Recommendation after the isolation correction: **GO for review and merge of the bounded
non-production feature**, subject to normal review/check policy and separate tracking
of the 23 baseline failures. Keep PR #148 Draft until approved. No merge or deployment.
