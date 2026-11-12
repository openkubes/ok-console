# Unified OpenKubes login UI v0.1 — verification

Tracking: [OK-214](https://kubernauts.atlassian.net/browse/OK-214). Base: `0608659d1c99cf20da2c17cef261c8c87a8b48bc` (`main`). Verified 2026-11-05 with Node 22.23.4, pnpm 10.17.1, Chromium/Playwright 1.62.1 and disposable PostgreSQL 16.

## Change and boundaries

`src/auth/AuthEntry.tsx` extracts the existing branded shell and places the ordinary local form inside it. The logo, story panel, colors, CSS, responsive rules and footer are reused. Local mode identifies itself as non-production `ok-local`, password authentication without MFA; it makes no federation claim. OIDC-only mode hides the unavailable exceptional-access placeholder. Bootstrap and BreakGlass retain separate exceptional-access forms and mode-specific hints.

The ordinary submit handler and exceptional reset/authentication handler block are byte-for-byte unchanged from the base. The existing session-retry callback is also available in the local service-error view. No BFF, database, session, authorization, auth client, stylesheet, endpoint, contract or ADR changes. Developer Workspaces and User & Project Management Preview implementation files are unchanged.

Method visibility follows the existing build-time `VITE_CONSOLE_AUTH_MODE` contract. It does not discover provider health or introduce a runtime capability endpoint. An unavailable configured OIDC provider still follows the existing OIDC error path. Operators must continue to match frontend mode to the BFF configuration; the backend retains enforcement of the non-production Local Identity boundary.

| Mode | Provider entries | Ordinary local form | Exceptional entry |
| --- | ---: | --- | --- |
| local | 0 | Yes | No |
| oidc | 1 | No | No |
| bootstrap | 0 | No | Bootstrap |
| breakglass | 1 | No | BreakGlass |
| prototype | 2 simulated | No | Explicit simulation |

## Results

| Check | Result |
| --- | --- |
| Auth, App, Workspaces and identity Preview regressions | 84 passed |
| PostgreSQL suite, browser lifecycle enabled | 26 passed, repeated sequentially: 26 passed |
| Existing Playwright journeys/failure states, desktop and compact | 14 passed |
| Five modes × desktop/mobile visual comparisons | 10 passed |
| Browser interaction checks across all five modes and both viewports | 10 passed |
| Lint; default, local and prototype builds | Passed |
| Full non-PostgreSQL test partition | 784 passed, **23 failed**, 0 skipped |
| Untouched base non-PostgreSQL partition | 768 passed, **23 failed**, 0 skipped |

The remaining failures match the base by exact file and test name: `deploy/kubernetes/ok170.test.ts` (2), `ok172.test.ts` (2), `ok200-capture.test.ts` (7), `ok200.test.ts` (12). No new failures. Missing Python `yaml` and existing deployment/script assumptions remain outside this UI change. **The full suite is not green.** [Machine-readable results and the exact baseline failures](test-results.json).

PostgreSQL tests used the existing serialized `test:postgres` command against a fresh disposable database. They exercise attended CLI initialization/create/list/disable, HTTPS local login, disabled-session rejection/restoration/rotation, recovery, races, audit rollback, runtime permissions, durable throttling, and discovery-independent startup. The real browser test logs an ordinary user into the built Console, verifies empty browser credential/session storage, disables that user and rejects session reuse. No PostgreSQL tests were skipped.

Initial verification attempts were unsuccessful: the local build caught unsupported Testing Library query options in the new tests, leaving stale Prototype assets; the ensuing browser run timed out. Those test options were corrected and the local assets rebuilt successfully. An intermediate repeat also overlapped the preceding destructive database run during teardown and was discarded. The two final runs above were sequential and both passed without backend/test-suppression changes.

The existing Playwright suite used an isolated server on port `18787` because another user-owned Console occupied `8787`. Temporary copies changed only that port in the configuration and the hard-coded same-origin assertion, with server reuse disabled. All assertions and both viewport projects ran; temporary copies were removed.

## Visual and accessibility evidence

Screenshots use 1440×1000 and 390×844 viewports, light theme and reduced motion. The reproducible component fixture loads the real component and unchanged stylesheet; callbacks are controlled test doubles, not external providers. Actual backend lifecycle verification is separate above.

| Mode | Desktop before → after | Mobile before → after |
| --- | --- | --- |
| Local | [Before](before/local-desktop.png) → [After](after/local-desktop.png) | [Before](before/local-mobile.png) → [After](after/local-mobile.png) |
| OIDC | [Before](before/oidc-desktop.png) → [After](after/oidc-desktop.png) | [Before](before/oidc-mobile.png) → [After](after/oidc-mobile.png) |
| Prototype | [Before](before/prototype-desktop.png) → [After](after/prototype-desktop.png) | [Before](before/prototype-mobile.png) → [After](after/prototype-mobile.png) |
| Bootstrap | [Before](before/bootstrap-desktop.png) → [After](after/bootstrap-desktop.png) | [Before](before/bootstrap-mobile.png) → [After](after/bootstrap-mobile.png) |
| BreakGlass | [Before](before/breakglass-desktop.png) → [After](after/breakglass-desktop.png) | [Before](before/breakglass-mobile.png) → [After](after/breakglass-mobile.png) |

OIDC and Prototype branding-panel PNG hashes are identical before/after at both sizes. Prototype entry DOM and card geometry are identical. OIDC intentionally loses the unavailable exceptional-access placeholder. No horizontal overflow or JavaScript page errors were observed. Screenshots were visually inspected for branding, spacing and responsive stacking.

Local entry and error views have zero automated WCAG A/AA findings. Keyboard-only username → password → submit navigation, visible input focus, Enter submission, pending protection, generic errors and password clearing passed at both sizes. [Desktop error](after/local-error-desktop.png), [mobile error](after/local-error-mobile.png). Existing Prototype keyboard navigation through sign-in and the Console main landmark also passed.

**Existing accessibility limitation:** Prototype, Bootstrap and BreakGlass entry views retain one `color-contrast` finding on `.auth-local-entry > span > small` (3.56:1 versus 4.5:1). This is present on the untouched base at both viewports; no new Axe violations were introduced. Fixing the shared hint color is outside the approved unchanged-style scope. Automated checks do not replace manual assistive-technology testing.

Detailed comparisons: [before](before-checks.json), [after](after-checks.json), [interaction checks](interaction-checks.json).

## Reproduce

From the repository root, with Node 22 and the pinned pnpm version:

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
node docs/evidence/ok-214/unified-login-ui/verify-ui.mjs
pnpm test:non-postgres src/auth src/App.test.tsx src/workspaces src/identity
pnpm lint
pnpm build
```

The visual utility uses loopback port `5177`, reads the pinned base from Git and removes its temporary fixture/server. It never adds an application method switcher or calls a real authentication provider.

For the PostgreSQL/browser path, use a **fresh disposable database only**; these tests destructively reset schemas/tables. Supply its superuser connection URL to the existing test harness, which creates its own restricted runtime role and test-only TLS material. Do not run separate destructive test processes against the same database concurrently.

```bash
VITE_CONSOLE_DATA_MODE=bff VITE_CONSOLE_AUTH_MODE=local pnpm build
export OK_CONSOLE_TEST_POSTGRES_URL='postgresql://USER:PASSWORD@127.0.0.1:PORT/DISPOSABLE_DB'
CI=true OK_CONSOLE_TEST_LOCAL_BROWSER=true pnpm test:postgres
CI=true OK_CONSOLE_TEST_LOCAL_BROWSER=true pnpm test:postgres
unset OK_CONSOLE_TEST_POSTGRES_URL
pnpm test:non-postgres
```

This path also requires OpenSSL and Python 3 for the existing TLS/attended CLI fixtures. The full non-PostgreSQL command still reports the 23 baseline deployment-test failures in this environment.

**Recommendation: GO for review of this UI-only change**, subject to reviewer acceptance of the separately documented baseline test and accessibility limitations. Keep the PR Draft until review approval; no merge or deployment performed.
