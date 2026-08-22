# OpenKubes read-only Console BFF

This directory implements the OK-158 provider side of the first read-only
Console slice. It is a separate Node.js process behind the browser's same-origin
`/api/console/v0` boundary; Vite proxies that path during local development.

## Run locally

Use two terminals:

```bash
# Terminal 1: read-only BFF
pnpm start:bff

# Terminal 2: Console configured for the BFF adapter
VITE_CONSOLE_DATA_MODE=bff pnpm dev
```

Open the Vite URL and complete the prototype sign-in flow. The browser keeps
using `ConsoleDataPort`; only its adapter changes.

## Resources

| Method and path | Presentation kind | Required permission |
| --- | --- | --- |
| `GET /api/console/v0/session` | `SessionContext` | `platform.read` |
| `GET /api/console/v0/overview` | `PlatformOverview` | `platform.read` |
| `GET /api/console/v0/clusters` | `ClusterList` | `clusters.read` |
| `GET /api/console/v0/clusters/{id}` | `ClusterDetail` | `clusters.read` |
| `GET /api/console/v0/evidence/{id}` | `EvidenceReference` | `evidence.read` |
| `GET /api/console/v0/auth/session` | `ConsoleSession` | valid opaque session |
| `POST /api/console/v0/auth/session/rotate` | `ConsoleSession` + rotated cookies | valid session + exact Origin + CSRF |
| `DELETE /api/console/v0/auth/session` | empty `204` + cleared cookies | valid session + exact Origin + CSRF |
| `GET /api/console/v0/auth/oidc/start` | `302` to the configured issuer | OIDC enabled |
| `GET /api/console/v0/auth/oidc/callback` | `303` + opaque Console cookies | valid one-time flow + mapped subject |

All other paths return a bounded `NOT_FOUND` response. Non-`GET` resource
methods fail closed; there is no generic Kubernetes proxy or platform mutation
endpoint. The two session mutations only rotate or revoke an already
authenticated session.

### Session HTTP boundary

Inject `sessionStore` and the Console's exact `expectedOrigin` into
`createConsoleBffHandler` to enable the session lifecycle routes. The runtime
does not select the in-memory test store implicitly. Without an injected store,
these routes return `503 SESSION_UNAVAILABLE`.

The BFF never exposes a `POST` that turns browser-supplied identity data into a
session. A later reviewed OIDC callback or exceptional-access verifier must
create the server-side session. The readable `__Host-ok_console_csrf` cookie
lets browser code copy the session-bound value into `X-CSRF-Token`; the opaque
`__Host-ok_console_session` cookie remains `HttpOnly`. Rotation and logout also
require an exact configured Origin and clear or replace both cookies.

## Runtime boundary

- `server.mjs` owns process startup and graceful shutdown.
- `app.mjs` owns routing, contract envelopes, correlation IDs, authorization
  hooks, security headers, bounded errors, and a credential-free request
  observation hook.
- `presentation.mjs` maps observed state through explicit allowlists. It never
  spreads backend objects into responses.
- `adapters/fixtureObservedState.mjs` is the deterministic local/test source.
- `adapters/openKubesObservedState.mjs` queries a controlled OpenKubes HTTP(S)
  endpoint and immediately normalizes the response through an explicit
  allowlist. Unknown backend and Kubernetes fields never enter the canonical
  BFF snapshot.
- `source.mjs` selects the source explicitly at process startup. It never falls
  back silently after a real-source failure.
- `contract.mjs` provides producer response helpers and a final recursive
  credential-field guard.
- `security/postgresSessionStore.mjs` implements the ADR-038 asynchronous store
  port with database-time expiry, transactional rotation, cross-replica
  session-family revocation and authorization-revision validation.
- `security/envelope.mjs` encrypts the minimal authorization context with
  AES-256-GCM before it crosses the store port. The database holds only opaque
  reference and CSRF digests plus encrypted context.

The default authorizer is deliberately marked as a prototype. Production OIDC,
RBAC, tenancy policy, and credential transport remain separate security work.
The hook is evaluated at the point of use for every resource and is covered by
provider tests.

## PostgreSQL session-store profile

Apply the numbered files in `security/postgres` through the deployment's
reviewed migration workflow. The BFF does not run schema migrations at request
startup. Use a separate migration identity; the runtime role needs only bounded
session-table DML. Construct `PostgresSessionStore` with:

- a `pg.Pool` connected to the read/write primary through verified TLS;
- a `SessionEnvelopeCodec` whose 32-byte keys come from the accepted Secret
  Contract;
- the current deployment session epoch; and
- an authorization-revision validator backed by the current identity mapping.

The adapter never falls back to memory. Missing envelope keys, stale or
unverified authorization revisions, database errors, invalid epochs and
ambiguous rotation outcomes fail closed. PostgreSQL replicas must not serve
session authorization reads.

### Secure runtime selection

`server.mjs` selects the store only through
`OK_CONSOLE_SESSION_STORE_MODE=disabled|postgres`. The default `disabled` mode
preserves the local fixture prototype and returns `503 SESSION_UNAVAILABLE` on
session routes. It never creates a hidden in-memory store. A non-fixture
observed-state source is rejected in this mode so real observations cannot be
exposed through the prototype authorizer.

The `postgres` mode is atomic: process startup creates the PostgreSQL store,
installs session-backed point-of-use authorization, and configures exact-Origin
CSRF checks together. Missing or invalid inputs stop startup. Configure the
non-secret values and mount the database URL, CA certificate, and envelope keys
as files as shown in `.env.example`. The key file is a bounded JSON object whose
values are base64-encoded 32-byte AES keys; keep old keys present while their
envelopes can still exist, and select the write key by ID.

Verified TLS is mandatory. The only exception is the explicit
`OK_CONSOLE_POSTGRES_ALLOW_INSECURE_LOOPBACK=true` development switch, which is
rejected unless the database host is loopback. Database URL query parameters
cannot override the trusted TLS profile. The configured deployment epoch
invalidates sessions from another deployment epoch, while the authorization
revision must exactly match the deployed mapping revision before every
protected read.

The static revision comparison is the bounded first runtime implementation. A
later identity-policy adapter can replace it with live revision validation
without changing the session-store port.

### OIDC Authorization Code flow

Apply `security/postgres/002_oidc_transactions.sql` and enable
`OK_CONSOLE_OIDC_ENABLED=true` only with the PostgreSQL runtime. The BFF uses
the pinned `openid-client` library for issuer discovery, JWKS/signature and
token-claim validation, Authorization Code exchange, PKCE S256, State, and
Nonce validation. Discovery starts from the configured issuer identifier over
HTTPS with a bounded timeout.

PKCE verifier, State, and Nonce are encrypted in PostgreSQL for five minutes.
The browser receives only a digest-backed `Secure`, `HttpOnly`, `SameSite=Lax`
transaction reference, which is atomically deleted before callback validation;
failed and replayed callbacks cannot reuse it. Provider tokens are neither
stored nor returned to the browser.

The confidential client secret and a versioned subject mapping are read from
bounded mounted files. The mapping file shape is:

```json
{
  "version": "v1",
  "subjects": [{
    "providerSubject": "issuer-scoped-opaque-subject",
    "identityId": "openkubes-user-id",
    "displayName": "Mapped display name",
    "assurance": ["Federated"],
    "tenantIds": ["platform"],
    "permissions": ["platform.read", "clusters.read"]
  }]
}
```

Only the cryptographically validated `sub` selects a reviewed mapping. Email,
display-name, role, and group claims never grant authority. Unmapped subjects,
duplicate mappings, missing ID Tokens, stale transactions, provider errors,
and configuration ambiguity fail closed with bounded errors. Register the exact
callback `${OK_CONSOLE_ORIGIN}/api/console/v0/auth/oidc/callback` at the provider.

Build the browser with `VITE_CONSOLE_AUTH_MODE=oidc` and
`VITE_CONSOLE_DATA_MODE=bff` to activate the live handoff. React restores only
`GET /auth/session`, redirects sign-in to `GET /auth/oidc/start`, and invokes
CSRF-bound `DELETE /auth/session` for logout. The prototype mode remains the
explicit default. Local/bootstrap authentication is disabled in live mode until
its independent verifier, rate limit, audit, and recovery boundary is accepted.

Rotation retains an internal digest-only session-family identifier. Logout
locks the presented reference and revokes that entire family in one transaction,
so a concurrent rotation cannot leave a newly issued reference active.

The integration suite is skipped unless an explicit disposable database URL is
provided:

```bash
OK_CONSOLE_TEST_POSTGRES_URL=postgresql://postgres:test@127.0.0.1:5432/ok_console_test \
pnpm test:postgres
```

The GitHub verification job supplies a temporary PostgreSQL 16 service, so all
store conformance cases run on every pull request. The test schema is truncated;
never point this variable at a non-disposable database.

## Local failure injection

Failure injection is disabled by default. For local verification only:

```bash
OK_CONSOLE_BFF_ENABLE_FAILURE_INJECTION=true pnpm start:bff
```

Append one of these query values to a resource:

| Query | Expected behavior |
| --- | --- |
| `?failure=forbidden` | `403 FORBIDDEN` |
| `?failure=unavailable` | retryable `503 SOURCE_UNAVAILABLE` |
| `?failure=stale` | successful response with `Stale` freshness |
| `?failure=degraded` | successful response with `PARTIAL_DATA` warning |
| `?failure=incompatible` | fail-closed `502 CONTRACT_INCOMPATIBLE` |

Do not enable this switch in a shared or production environment.

## OpenKubes observed-state mode

The real-source path consumes the versioned read-only query envelope
`observed.openkubes.io/v0alpha1` / `ConsoleObservedState`. Configure the BFF
process—not the browser—with:

```bash
OK_CONSOLE_OBSERVED_STATE_MODE=openkubes \
OK_CONSOLE_OBSERVED_STATE_URL=https://platform.example/api/console-observed-state/v0alpha1 \
OK_CONSOLE_OBSERVED_STATE_TIMEOUT_MS=5000 \
OK_CONSOLE_OBSERVED_STATE_STALE_AFTER_MS=300000 \
pnpm start:bff
```

Only HTTPS endpoints are accepted outside loopback; embedded URL credentials
and redirects are rejected. The adapter uses GET with the versioned JSON
profile, a bounded timeout and a streaming 2 MiB response limit. It
requires exactly one management plane, validates readiness enums and Evidence
references, derives freshness locally, and converts upstream partial status to
a safe `PARTIAL_DATA` warning. Upstream diagnostic text is never forwarded.

Authentication for the upstream query is deliberately not invented here; it is
part of OK-163. The process now requires the PostgreSQL session runtime before
this source can be selected, so browser reads are session-authorized even in a
controlled network integration environment.

### Explicit rollback to fixtures

Stop the BFF, set `OK_CONSOLE_OBSERVED_STATE_MODE=fixture`, and restart it. A
real-source outage produces a retryable, redaction-safe `SOURCE_UNAVAILABLE`
response and does not silently show fixture data as if it were current reality.

## Verification

```bash
pnpm test:bff
pnpm test:contract
pnpm test:postgres # requires OK_CONSOLE_TEST_POSTGRES_URL
pnpm test
pnpm lint
pnpm build
```

Provider tests start the handler on a short-lived local port and validate every
resource with the shared TypeScript Presentation Contract validator. A separate
vertical-slice test then flows observed state through the real HTTP handler and
the browser-owned `BffConsoleAdapter`. Together they cover authorization,
redaction, arbitrary proxy rejection, mutation rejection, source failure,
freshness, compatibility, and bounded failure injection.

## Recommended production evolution

Keep the BFF in `openkubes/ok-console` while the first vertical slice and its
contract are evolving together. Extract it only when release cadence, runtime
ownership, or independent scaling creates a real boundary. Replace the fixture
adapter with an OpenKubes query adapter; keep presentation mapping, redaction,
authorization, session lifecycle, CSRF, and provider tests at this HTTP
boundary.
