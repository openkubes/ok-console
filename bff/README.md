# OpenKubes read-only Console BFF

This directory implements the OK-158 provider side of the first read-only
Console slice. It is a separate Node.js process behind the browser's same-origin
`/api/console/v0` boundary; Vite proxies that path during local development.

## Run locally

Use two terminals:

```bash
# Terminal 1: read-only BFF with explicit local prototype authorization
OK_CONSOLE_DEV_PROTOTYPE_ENABLED=true pnpm start:bff

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
| `POST /api/console/v0/auth/local` | `ConsoleSession` + opaque Console cookies | explicitly enabled Bootstrap/BreakGlass mode + exact Origin |

All other paths return a bounded `NOT_FOUND` response. Non-`GET` resource
methods fail closed; there is no generic Kubernetes proxy or platform mutation
endpoint. The two session mutations only rotate or revoke an already
authenticated session.

### Session HTTP boundary

Inject `sessionStore` and the Console's exact `expectedOrigin` into
`createConsoleBffHandler` to enable the session lifecycle routes. The runtime
does not select the in-memory test store implicitly. Without an injected store,
these routes return `503 SESSION_UNAVAILABLE`.

Only the fixed exceptional-access route can turn submitted local credentials
into a session, and it is absent unless its server-side mode and mounted secret
contracts pass startup validation. The readable `__Host-ok_console_csrf` cookie
lets browser code copy the session-bound value into `X-CSRF-Token`; the opaque
`__Host-ok_console_session` cookie remains `HttpOnly`. Rotation and logout also
require an exact configured Origin and clear or replace both cookies.

## Runtime boundary

- `server.mjs` owns process startup and graceful shutdown.
- `runtimeHttp.mjs` serves the allowlisted production build under the same origin,
  delegates only the fixed API prefix, and owns empty liveness/readiness probes.
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
`OK_CONSOLE_SESSION_STORE_MODE=disabled|postgres`. Disabled sessions require
the explicit server-side `OK_CONSOLE_DEV_PROTOTYPE_ENABLED=true` opt-in. The
server rejects the mode without that setting and only permits it on a loopback
bind (`127.0.0.1`, `::1`, or `localhost`) outside `NODE_ENV=production`.
`OK_CONSOLE_DISPOSABLE_LOCAL_CLUSTER_ACKNOWLEDGED=true` is a separate
acknowledgement for disposable local clusters that need a Pod bind or production
Node runtime; it is set by the local-kind overlay and disposable CI smoke
container. These settings control
BFF authorization and are independent of browser `VITE_CONSOLE_AUTH_MODE`.
Disabled sessions return `503 SESSION_UNAVAILABLE` on session routes and never
create a hidden in-memory store. A non-fixture observed-state source is rejected
in this mode so real observations cannot be exposed through the prototype
authorizer.

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

### Health semantics

`GET` or `HEAD /health/live` returns an empty `204` while the process can answer
HTTP; it intentionally does not probe PostgreSQL or external providers.
`GET` or `HEAD /health/ready` returns an empty `204` only when the selected
runtime can safely serve sessions. PostgreSQL mode verifies connectivity and all
schema relations required by the enabled session, OIDC, and exceptional-access
features; failures return an empty `503` without exposing dependency details.

Both endpoints are unauthenticated for kubelet probing, accept no mutation
methods, and return `Cache-Control: no-store`. Identity-provider and
observed-state availability do not drive liveness, avoiding dependency-induced
restart storms.

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

Build the browser with `VITE_CONSOLE_DATA_MODE=bff` and select
`VITE_CONSOLE_AUTH_MODE=oidc|bootstrap|breakglass` to activate the matching live
handoff. React restores only `GET /auth/session`; OIDC profiles redirect through
`GET /auth/oidc/start`, and exceptional profiles submit credentials once to
`POST /auth/local`. Logout invokes CSRF-bound `DELETE /auth/session`. The
prototype mode remains the explicit default.

### Exceptional local access

Exceptional access is disabled by default. The explicit PostgreSQL runtime can
enable `OK_CONSOLE_LOCAL_ACCESS_MODE=bootstrap|breakglass`; Bootstrap is
accepted only while OIDC is disabled, and BreakGlass only while OIDC is enabled.
Both modes require migrations `003_local_access_throttle.sql` and
`004_local_access_audit.sql`, plus bounded mounted account and pepper files.
No environment variable or browser bundle contains the credential material.

`POST /api/console/v0/auth/local` accepts only same-origin JSON after validating
the exact configured Origin and content type before reading its 16 KiB-bounded
body. Credential and input failures share one redaction-safe `401`; unavailable
throttle, audit, KDF, or session dependencies fail closed with a bounded `503`.
Success returns only the public `ConsoleSession` projection and the same opaque
session/CSRF cookies used by OIDC.

Accounts are explicit authority mappings with salted scrypt verifiers; unknown
usernames execute the same asynchronous KDF path. Parameters are fixed to
`N=32768`, `r=8`, `p=1` with a 64 MiB ceiling. The mounted JSON shape is:

```json
{
  "version": "v1",
  "accounts": [{
    "username": "recovery-admin",
    "enabled": true,
    "salt": "base64-encoded-16-byte-salt",
    "verifier": "base64-encoded-32-byte-scrypt-output",
    "identityId": "reviewed-stable-identity",
    "displayName": "Recovery Administrator",
    "environmentId": "production",
    "tenantIds": ["platform"],
    "permissions": ["platform.read", "clusters.read"]
  }]
}
```

Migration `003_local_access_throttle.sql` adds digest-only, database-time
throttling shared by all BFF replicas. Five failed attempts in a 15-minute
window block that principal for 15 minutes; 50 failures across rotating
principals also activate a shared global bucket. The digest is HMAC-peppered so
the table does not disclose configured usernames. Edge/IP rate limiting remains
a deployment control because the BFF does not invent trust in proxy headers.

Every attempt requires a 12–512 character operational reason and writes
credential-free, correlation-ID-bearing Evidence through migration `004`.
Granted access is revoked if its Evidence cannot be stored. Configure the BFF
runtime database identity with only `INSERT` on `local_access_audit`; migration
and retention identities own update/delete policy. Operators must not put
secrets into the reason, and deployments must define access and retention.
Credential custody, recovery exercises, MFA feasibility, and production
acceptance remain open. The browser handoff does not weaken this boundary: its
mode only controls which entry UI is visible, while the BFF independently
enforces all activation and credential policy.

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
OK_CONSOLE_DEV_PROTOTYPE_ENABLED=true \
OK_CONSOLE_BFF_ENABLE_FAILURE_INJECTION=true pnpm start:bff
```

Append one of these query values to a resource:

| Query | Expected behavior |
| --- | --- |
| `?failure=forbidden` | `403 FORBIDDEN` |
| `?failure=unavailable` | retryable `503 SOURCE_UNAVAILABLE` |
| `?failure=stale` | successful response with `Stale` freshness; the stale-response verdict makes readiness and lifecycle `Unknown` and current metric leaves (`ready`, `pending`, `failed`, `unknown`, and open findings total/critical) null, while inventory totals remain |
| `?failure=degraded` | successful response with `PARTIAL_DATA` warning |
| `?failure=incompatible` | fail-closed `502 CONTRACT_INCOMPATIBLE` |

Do not enable this switch in a shared or production environment.

## OpenKubes observed-state mode

The real-source path consumes the versioned read-only query envelope
`observed.openkubes.io/v0alpha2` / `ConsoleObservedState`. Every cluster,
capability, placement and evidence object carries `ownership`
(`environmentId`, `tenantId`), and metrics arrive as one bucket per owner.
The BFF rejects an envelope with missing or inconsistent ownership, duplicate
ids or unresolved or cross-owner references, then filters every object to the
tenants the session may see (its tenants intersected with
`OK_CONSOLE_TENANT_ID`) before any projection. An object of another tenant
returns the same 404 as an unknown id. Ownership-free `v0alpha1` envelopes are
rejected. Configure the BFF
process—not the browser—with:

```bash
OK_CONSOLE_OBSERVED_STATE_MODE=openkubes \
OK_CONSOLE_OBSERVED_STATE_URL=https://platform.example/api/console-observed-state/v0alpha2 \
OK_CONSOLE_OBSERVED_STATE_CA_FILE=/run/secrets/ok-console/observed-state/ca.crt \
OK_CONSOLE_OBSERVED_STATE_CLIENT_CERT_FILE=/run/secrets/ok-console/observed-state/tls.crt \
OK_CONSOLE_OBSERVED_STATE_CLIENT_KEY_FILE=/run/secrets/ok-console/observed-state/tls.key \
OK_CONSOLE_OBSERVED_STATE_TIMEOUT_MS=5000 \
OK_CONSOLE_OBSERVED_STATE_STALE_AFTER_MS=300000 \
pnpm start:bff
```

Only HTTPS endpoints are accepted outside loopback; embedded URL credentials
and redirects are rejected. HTTPS sources require an explicit CA plus a client
certificate/private-key pair from bounded mounted files. The client verifies
the producer DNS identity and presents its certificate without using ambient
machine trust or bearer credentials. The adapter uses GET with the versioned JSON
profile, a bounded timeout and a streaming 2 MiB response limit. It
requires exactly one management plane, validates readiness enums and Evidence
references, derives freshness locally, and converts upstream partial status to
a safe `PARTIAL_DATA` warning. Upstream diagnostic text is never forwarded.

The producer additionally authorizes the exact Console BFF SPIFFE URI SAN. The
process requires the PostgreSQL session runtime before this source can be
selected, so browser reads are session-authorized as well as workload-authenticated.
Certificate issuance, rotation overlap, revocation and recovery remain explicit
deployment exercises rather than runtime fallbacks.

### Explicit rollback to fixtures

Stop the BFF, set `OK_CONSOLE_OBSERVED_STATE_MODE=fixture`, and restart it. A
real-source outage produces a retryable, redaction-safe `SOURCE_UNAVAILABLE`
response and does not silently show fixture data as if it were current reality.

## Verification

```bash
pnpm test:bff
pnpm test:contract
pnpm test:deployment
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

### Upstream failure diagnostics

Source reads retain the safe 503 `SOURCE_UNAVAILABLE` response and retry policy.
An optional, closed `error.reason` distinguishes certificate verification,
transport failure, deadlines before a response or during the body, ambiguous
transport/peer TLS alerts, TLS protocol failure,
HTTP identity rejection (401/403), producer 5xx, other HTTP non-success, and an
unclassified failure. Contract incompatibility retains its existing 502 response.
No browser UI change is required.

Each failed source read emits one JSON event, bounded to 2048 bytes including
newline for the current closed vocabulary and 16-entry trail. The API body,
contract version and UI are unchanged. Fields:

| Field | Values / bounds | Operator conclusion |
| --- | --- | --- |
| time | UTC ISO timestamp | Wall time of logging; subject to host clock corrections. |
| stage | Last reached member of the lifecycle stage enum below; SOURCE_ATTEMPT_START when there is no request context | Pairs the last completed request step with failedStage, the attempt phase that failed. |
| route | OVERVIEW, CLUSTERS, CLUSTER_DETAIL, EVIDENCE, EVIDENCE_DETAIL, OTHER | Projection class, with no resource ID. |
| correlationId | server-generated corr-UUID; otherwise OTHER | Joins the response and request access line. |
| class | TRUST_REJECTED, SOURCE_UNREACHABLE, INCONCLUSIVE, CONTRACT_INCOMPATIBLE | Observed failure category, never a diagnosis inferred from error text. Pre-header timeouts after TLS_ESTABLISHED are INCONCLUSIVE. |
| reason | CERTIFICATE_VERIFICATION, TRANSPORT_FAILURE, TRANSPORT_AMBIGUOUS, PEER_TLS_ALERT, TLS_PROTOCOL_FAILURE, UNCLASSIFIED, DEADLINE_EXCEEDED, BODY_DEADLINE_EXCEEDED, IDENTITY_REJECTED, HTTP_SERVER_ERROR, HTTP_NON_SUCCESS, CONTRACT_VALIDATION | Closed reason vocabulary; see classification semantics below. |
| nodeCode | closed Node certificate verification / transport code, normalized allowlisted peer alert name, EPROTO, or OTHER | Identifies the verifier or transport observation. Arbitrary error codes are withheld. Exact membership lives in sourceFailure.mjs and its table-driven tests. |
| httpStatus | NONE, IDENTITY_REJECTED, 5XX, OTHER | Parsed HTTP response category; no raw status text. |
| failedStage | DNS, CONNECT, TLS_HANDSHAKE, AWAIT_HEADERS, BODY, VALIDATION, OTHER | Attempt phase at failure. HTTP rejection, including Fetch response-header construction rejection, is AWAIT_HEADERS; OTHER includes transports without event instrumentation. This is the phase field; there is no duplicate phase key. |
| elapsedMs | integer 0–600000 or null | Monotonic time from source attempt start to failure. |
| phaseMs | object with optional dns, connect, tls, headers; each integer 0–600000 | Completed transport phase durations. Missing means no completion event; IP literals have no DNS phase. Connect includes setup since the last completion; headers ends at the response event. |
| wallClockStepMs | signed integer −86400000–86400000 or null | Largest absolute Date.now vs performance.now delta divergence observed inside this attempt window, retaining its sign. Values with absolute magnitude <= 2 ms are reported as 0: no step beyond that deadband within this window, not a claim that the clock never moved. Process observations occur at attempt starts and finishes, including overlapping attempts. |
| clockStepSinceLastObservationMs | signed integer −86400000–86400000 or null | Divergence measured at attempt start since the previous process-wide observation, including time between attempts. The same <= 2 ms deadband applies; 0 means no step beyond it in that preceding interval. On the first observation it is 0; lastObservationAgeMs is null. |
| clockOffsetMs | signed integer −86400000–86400000 or null before the first process observation | Cumulative wall-versus-monotonic divergence since the first process observation, with a 2 ms deadband applied to the running total (telescoping), rather than each interval. Persists across healthy attempts and later failures; bounded only when serialized. |
| lastObservationAgeMs | integer 0–86400000 or null | Monotonic age of the previous process-wide observation at attempt start; null on the first attempt of the process. |
| stages | at most 16 objects, each exactly stage and atMs | Ordered request progress reached before failure. atMs is monotonic from REQUEST_RECEIVED, integer 0–600000. |

clockOffsetMs is persisting state; the two step fields are events. It measures
cumulative divergence relative to the process's first observation, NOT the clock's
current error. Corrections applied by slewing (adjtime/NTP) are invisible because
CLOCK_MONOTONIC follows slewing. Skew present before process start reads 0; a suspend
leaves a persistent positive value when monotonic time pauses. A value of 0 does
not rule out a skewed clock. Preemption between
the wall and monotonic reads can produce an opposite-sign pair above 2 ms; read
the pair together, as it cancels in clockOffsetMs after an ordinary observation.
Preemption inside the FIRST observation leaves a permanent offset indistinguishable
from a suspend. A line whose own start observation was preempted shows the
uncancelled half of the pair until the next observation. A negative offset alongside a
certificate rejection is consistent with a backward step; co-occurrence does not
establish causation.

For elapsedMs and both step fields, null = not measured: an error without attempt data has failedStage OTHER, empty phaseMs, and null lastObservationAgeMs. A VM/process suspend can appear as a positive step without an explicit wall-clock adjustment when the monotonic clock pauses while wall time advances.

The closed nodeCode vocabulary is:

- Local verifier codes: `UNSPECIFIED`, `UNABLE_TO_GET_ISSUER_CERT`, `UNABLE_TO_GET_CRL`, `UNABLE_TO_DECRYPT_CERT_SIGNATURE`, `UNABLE_TO_DECRYPT_CRL_SIGNATURE`, `UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY`, `CERT_SIGNATURE_FAILURE`, `CRL_SIGNATURE_FAILURE`, `CERT_NOT_YET_VALID`, `CERT_HAS_EXPIRED`, `CRL_NOT_YET_VALID`, `CRL_HAS_EXPIRED`, `ERROR_IN_CERT_NOT_BEFORE_FIELD`, `ERROR_IN_CERT_NOT_AFTER_FIELD`, `ERROR_IN_CRL_LAST_UPDATE_FIELD`, `ERROR_IN_CRL_NEXT_UPDATE_FIELD`, `DEPTH_ZERO_SELF_SIGNED_CERT`, `SELF_SIGNED_CERT_IN_CHAIN`, `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `CERT_CHAIN_TOO_LONG`, `CERT_REVOKED`, `INVALID_CA`, `PATH_LENGTH_EXCEEDED`, `INVALID_PURPOSE`, `CERT_UNTRUSTED`, `CERT_REJECTED`, `HOSTNAME_MISMATCH`, `ERR_TLS_CERT_ALTNAME_INVALID`, `ERR_TLS_CERT_ALTNAME_FORMAT`.
- Transport/fallback codes: `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `ENETDOWN`, `EHOSTDOWN`, `EHOSTUNREACH`, `ENETUNREACH`, `ETIMEDOUT`, `ECONNRESET`, `EPIPE`, `ERR_STREAM_PREMATURE_CLOSE`, `EPROTO`, `OTHER`.
- Normalized peer alert names: `UNKNOWN_CA`, `BAD_CERTIFICATE`, `CERTIFICATE_UNKNOWN`, `CERTIFICATE_EXPIRED`, `CERTIFICATE_REVOKED`, `UNSUPPORTED_CERTIFICATE`, `HANDSHAKE_FAILURE`, `ACCESS_DENIED`, `DECRYPT_ERROR`, `CERTIFICATE_REQUIRED`. These describe a peer alert and retain INCONCLUSIVE classification.

All nodeCode values are fixed tokens (maximum 34 characters).

The closed lifecycle stage enum is REQUEST_RECEIVED, AUTHZ_CHECKED,
SOURCE_ATTEMPT_START, DNS_RESOLVED, TCP_CONNECTED, TLS_ESTABLISHED,
HEADERS_RECEIVED, BODY_COMPLETE, CONTRACT_VALIDATED, RESPONSE_SENT.
Authorization is recorded after its check, including a denial; RESPONSE_SENT
comes from the response finish event and therefore follows a source failure line.
Each attempt has its own timings, and each request has its own bounded trail.
The access log keeps its `METHOD path · correlationId` text prefix and appends
`stage=REQUEST_RECEIVED`. OIDC start
failures carry the reached stage, correlation ID (or OTHER), fixed event
OIDC_START_FAILED and a closed cause naming the start step: TRANSACTION_STORE,
AUDIT, AUTHORIZATION_URL, PKCE or OTHER. Discovery runs only at startup. A separate
errorCode selects the deepest defined own data code in a cycle-bounded chain of Error causes, retaining an outer code when deeper causes have none. Parsed IdP JSON is never followed as a cause or a source of codes:
ECONNREFUSED, ENOTFOUND, EAI_AGAIN, ECONNRESET, 57P01, 53300, 28P01,
PG_CONNECT_TIMEOUT, PG_CONNECTION_TERMINATED, PG_POOL_TIMEOUT, PG_QUERY_TIMEOUT, PG_STATEMENT_TIMEOUT,
OAUTH_TIMEOUT, OAUTH_INVALID_RESPONSE, OAUTH_RESPONSE_BODY_ERROR,
AUDIT_INPUT_INVALID, PG_UNIQUE_VIOLATION (23505), PG_CHECK_VIOLATION (23514),
DECRYPT_FAILED, the TLS/token codes below, OTHER, or null when absent. ETIMEDOUT remains allowlisted;
runtime connectionTimeoutMillis makes the pg-specific timeout values the expected
DB timeout observations. Only at the pg query wrapper boundary, the exact pg 8.23.0 / pg-pool 3.14.0
messages "Connection terminated due to connection timeout", "Connection terminated
unexpectedly" and "timeout exceeded when trying to connect" map to the three PG
values respectively. "Query read timeout" maps to PG_QUERY_TIMEOUT. Tests pin
pg 8.23.0 and pg-pool 3.14.0 so an upgrade requires rechecking these
strings. Audit validation failures use AUDIT_INPUT_INVALID before any DB operation.
Inherited properties, accessors and issuer URLs are never read or emitted; raw
error text is never emitted.

Callback exceptions emit OIDC_CALLBACK_FAILED with the same five fields and bounded
errorCode walker. Callback causes name the failed step: TRANSACTION_STORE (consume),
TOKEN_EXCHANGE (URL construction, token exchange and ID-token validation inside the
protocol adapter), SUBJECT_MAP, SESSION_STORE, AUDIT or OTHER (response writing).
A failure of the rejection audit emits its own AUDIT line as well as the original
failure line. Missing/invalid server correlation context fails closed before any
store/audit call, with cause WIRING and errorCode CORRELATION_MISSING on the
appropriate start/callback event. The handler accepts only the bounded corr- UUID
shape; an injected correlationId factory must return `corr-<uuid>`, otherwise OIDC
answers 503 WIRING / CORRELATION_MISSING. The handler returns the server ID in X-Correlation-ID; client headers are never used.

PG_POOL_TIMEOUT means no free pool slot within connectionTimeoutMillis. Slots may
be held by in-flight connects: a silent DB with max=10 and 12 starts all arriving
inside the connect window produces ten PG_CONNECT_TIMEOUT and two PG_POOL_TIMEOUT
lines. With 30 ms spacing and a 250 ms connect window, the same twelve starts
produce twelve PG_CONNECT_TIMEOUT and zero PG_POOL_TIMEOUT lines. Read pool timeouts
together with PG_CONNECT_TIMEOUT lines; they do not establish that connected
clients are busy.

OK_CONSOLE_POSTGRES_QUERY_TIMEOUT_MS sets pg's client query_timeout (default
statement_timeout + 1000 ms, therefore 6000 ms at the default statement timeout;
bounded 250..61000). An explicit value <= statement_timeout is rejected at startup.
All six boundedInteger settings accept decimal digits only (`/^[0-9]+$/`):
OK_CONSOLE_POSTGRES_STATEMENT_TIMEOUT_MS, OK_CONSOLE_POSTGRES_QUERY_TIMEOUT_MS,
OK_CONSOLE_POSTGRES_POOL_MAX, OK_CONSOLE_POSTGRES_CONNECT_TIMEOUT_MS,
OK_CONSOLE_POSTGRES_IDLE_TIMEOUT_MS and OK_CONSOLE_OIDC_TIMEOUT_SECONDS.
Whitespace, hex and exponent notation are rejected. The statement_timeout + 1000 ms
default assumes round-trip plus server overhead stays below one second. PG_QUERY_TIMEOUT means no reply within
query_timeout, including a DB that completes startup then stops answering.
PG_STATEMENT_TIMEOUT means server cancellation SQLSTATE 57014, matched by code
at the pg boundary. SQLSTATE 57014 means statement timeout or operator cancel;
pg_cancel_backend produces the same code. Failed rotate/revoke transactions release
with the error, destroying the client without queuing ROLLBACK. Statements before
COMMIT roll back on disconnect; a COMMIT-step failure has an unknown outcome.
After a network partition the server may hold the row lock until keepalive or
idle_in_transaction_session_timeout ends the connection or transaction.

Session route dependency failures emit SESSION_FAILED, once per failed operation,
with stage, correlationId, event, cause, errorCode and bounded elapsedMs (0..600000).
The closed cause enum is SESSION_STORE (resolve), SESSION_ROTATE, SESSION_REVOKE,
SESSION_ROTATE_COMMIT, SESSION_REVOKE_COMMIT, AUDIT, SESSION_ROTATE_COMPENSATION
and SESSION_PURGE. COMMIT causes identify the point whose outcome is unknown.
A failed compensating revoke emits its own SESSION_ROTATE_COMPENSATION line
while retaining the original AUDIT failure line. purgeExpired has no production
caller today; its store boundary emits SESSION_PURGE if invoked and failing.
The errorCode vocabulary and own-code rule match
OIDC. The original SessionStoreError codes and HTTP response bodies are unchanged;
preserved causes are diagnostic inputs and never response fields.
For all these lines, `stage` is the lifecycle stage reached; `cause` names the
failing step.

Unexpected exceptions escaping a route emit REQUEST_FAILED with cause OTHER,
errorCode from the shared classifier (OTHER only when no code is available), and
the lifecycle stage reached. An authorize failure retains cause OTHER because
the catch-all also handles non-store exceptions; its errorCode still identifies
the underlying session-store failure, such as ECONNREFUSED or PG_QUERY_TIMEOUT. The stage distinguishes authorize failures (REQUEST_RECEIVED) from dry-run body or runner failures (AUTHZ_CHECKED). A client abort can read ECONNRESET. The app catch-all records only
errors that the request lifecycle has not already recorded at a named dependency
step; this prevents a rethrown session failure from producing a duplicate line.
Projection and response-writing exceptions therefore remain visible.

Local-access dependency failures emit LOCAL_ACCESS_FAILED once for the unavailable
operation, at the reached lifecycle stage (normally REQUEST_RECEIVED). The closed
cause steps are THROTTLE_CHECK, THROTTLE_FAILURE, THROTTLE_RESET, KDF,
SESSION_STORE and AUDIT, with OTHER for an unknown step. These identify the exact
verifier operation without adding lifecycle stages. errorCode uses the preserved
cause and the shared classifier. A failed compensating revoke adds a
LOCAL_ACCESS_COMPENSATION line after the original AUDIT line. Credential rejection
still returns LOCAL_ACCESS_REJECTED with no failure line; response bodies are unchanged.

Token exchange keeps strict TLS verification. These bounded codes preserve the
real Node/openid-client/oauth4webapi failure category without logging error text:

| Real producer observation | errorCode | Meaning |
| --- | --- | --- |
| ERR_TLS_CERT_ALTNAME_INVALID | ERR_TLS_CERT_ALTNAME_INVALID | Certificate does not match the endpoint host. |
| UNABLE_TO_VERIFY_LEAF_SIGNATURE | UNABLE_TO_VERIFY_LEAF_SIGNATURE | Issuer chain cannot be verified. |
| DEPTH_ZERO_SELF_SIGNED_CERT | DEPTH_ZERO_SELF_SIGNED_CERT | Endpoint certificate is self-signed and untrusted. |
| SELF_SIGNED_CERT_IN_CHAIN | SELF_SIGNED_CERT_IN_CHAIN | Presented chain includes an untrusted self-signed root. |
| UNABLE_TO_GET_ISSUER_CERT_LOCALLY | UNABLE_TO_GET_ISSUER_CERT_LOCALLY | Presented intermediate has no locally trusted issuer. |
| CERT_HAS_EXPIRED | CERT_HAS_EXPIRED | Endpoint certificate has expired. |
| CERT_NOT_YET_VALID | CERT_NOT_YET_VALID | Endpoint certificate validity has not begun. |
| OAUTH_WWW_AUTHENTICATE_CHALLENGE (any non-200 token response carrying WWW-Authenticate) | OAUTH_WWW_AUTHENTICATE_CHALLENGE | Token endpoint returned a non-200 response with a WWW-Authenticate header. |
| OAUTH_RESPONSE_IS_NOT_CONFORM (HTTP 500) | OAUTH_RESPONSE_IS_NOT_CONFORM | Token endpoint response does not conform to the expected response. |
| OAUTH_RESPONSE_IS_NOT_JSON | OAUTH_RESPONSE_IS_NOT_JSON | Token endpoint response has a non-JSON content type. |
| OAUTH_PARSE_ERROR | OAUTH_PARSE_ERROR | Token endpoint advertises JSON but its body cannot be parsed as JSON. |
| OAUTH_INVALID_RESPONSE with own token-response context lacking id_token | OIDC_ID_TOKEN_MISSING | Token endpoint omitted the required ID token. |
| OAUTH_INVALID_RESPONSE with state-check context | OAUTH_INVALID_RESPONSE | State or another response validation failed. |

The same TLS codes appear on TRANSACTION_STORE, SESSION_STORE, AUDIT and LOCAL_ACCESS_FAILED lines over pg TLS.

The missing-ID-token distinction reads only the library's own response-body
context marker, its own nonempty access_token and token_type strings, and the
presence of id_token; it never reads codes from that JSON.
A rejected grant remains OAUTH_RESPONSE_BODY_ERROR even if IdP JSON contains
code or cause.code. PG_UNIQUE_VIOLATION and PG_CHECK_VIOLATION distinguish database
constraints from DECRYPT_FAILED when a sealed session's key left the keyset.

The d4R10 and d4R11 wire suites use the real pg client against a protocol-level
fake server. Real-server evidence comes from real-pg.sh and the PostgreSQL
integration test against local Docker postgres:16-alpine.

Set OK_CONSOLE_TRACE=stages to emit one JSON line per reached stage, default off.
Each trace line contains exactly stage, atMs and correlationId with the bounds
above. It includes no endpoint, certificate identity, header or raw error text.
This option follows the BFF process environment. The source failure event also
contains none of those values. The access line retains its existing request path.

For example, failedStage=TLS_HANDSHAKE with nodeCode=CERT_NOT_YET_VALID identifies
a local verifier rejection. A large negative wallClockStepMs records a backward
divergence inside that attempt; a negative clockStepSinceLastObservationMs
records one in the preceding observation interval, including between attempts.
A future fixture without an injected step identifies the verifier cause but
does not assert that the host clock moved.
failedStage=CONNECT with ECONNREFUSED identifies refusal; AWAIT_HEADERS with
DEADLINE_EXCEEDED identifies the adapter deadline before response headers;
BODY with BODY_DEADLINE_EXCEEDED identifies a stalled response body;
AWAIT_HEADERS with HTTP_SERVER_ERROR and 5XX identifies a parsed producer error;
VALIDATION with CONTRACT_VALIDATION identifies an incompatible response.

Strict TLS experiments on Node 22.23.4 and 24.4.1 with rejectUnauthorized:true
show that rejected leaf validity bounds are not exposed under rejectUnauthorized:true
at the documented error events; obtainable only by disabling verification
(documented getPeerCertificate with rejectUnauthorized:false) or via the
undocumented internal 'secure' event; neither is used in production. The experiment
records the documented API observation as well as the internal and error events.
certValiditySkewS remains omitted, including for ERROR_IN_CERT_NOT_BEFORE_FIELD /
ERROR_IN_CERT_NOT_AFTER_FIELD. Verification remains strict; there is no insecure
retry or manual re-verification.

The per-test WALL_VS_MONOTONIC clock output measures net drift between the test's
start and finish, not the largest step. Opposite steps can cancel in that output;
the attempt monitor instead retains the largest observed in-window divergence.

OK_CONSOLE_D4_HEALTHY_REPETITIONS is test-only: it repeats the healthy-source
regression case and has no production effect. A soak pass is regression evidence;
the guard-removal campaign names the discriminating tests.

Classification uses observed transport phases and the error's own data `code`,
never messages or nested causes. `TRUST_REJECTED` means the local certificate verifier rejected the peer.
`SOURCE_UNREACHABLE` observes refusal, name not found / resolver unavailable,
routing/network-down errors, or a socket timeout / adapter deadline before TLS
completes. Once this attempt reached `TLS_ESTABLISHED`, a pre-header timeout is
`INCONCLUSIVE`: the producer was reachable but has not returned headers. The
adapter deadline retains `DEADLINE_EXCEEDED` and `nodeCode: OTHER`. After headers,
the adapter deadline is `INCONCLUSIVE` / `BODY_DEADLINE_EXCEEDED` with
`nodeCode: OTHER`. When the body stream surfaces an own-code `ETIMEDOUT` from e.g. a kernel
socket timeout, the adapter uses the same body-phase reason and retains
`nodeCode: ETIMEDOUT`. The mTLS transport forwards request socket errors to the response
stream after headers, preserving the original own code before Node can replace
it with an aborted-stream reset. Before headers, `ETIMEDOUT` is reported as
`SOURCE_UNREACHABLE` / `TRANSPORT_FAILURE` before TLS completes and
`INCONCLUSIVE` / `TRANSPORT_FAILURE` after `TLS_ESTABLISHED`; `nodeCode: ETIMEDOUT`
is retained in both cases.
If the private deadline already fired before headers, it takes precedence as
`DEADLINE_EXCEEDED` with `nodeCode: OTHER`. Other
unreachable-set codes after headers are `INCONCLUSIVE` / `TRANSPORT_AMBIGUOUS`,
retaining their closed `nodeCode`. Resets,
broken pipes, premature closes and peer alerts remain `INCONCLUSIVE`.
HTTP 401/403 from the producer or any intermediary is `IDENTITY_REJECTED`, even
if cancelling its response body fails; it does not establish a TLS cause.
These observations do not establish the producer's ultimate health or cause.

The mTLS client requires TLS 1.3. The producer TLS context at `openkubes` revision
`ad351c9` uses `PROTOCOL_TLS_SERVER`, minimum TLS 1.2 and no maximum, permitting
TLS 1.3; `CERT_OPTIONAL` verifies any client certificate presented. The
local tests measured named peer alerts for expired, not-yet-valid, wrong-EKU and
untrusted client certificates against a Python OpenSSL stand-in configured with
`CERT_OPTIONAL`, rather than the producer image. The Console always presents its
client certificate. A Node-style
TLS 1.3 server rejecting a presented client certificate can instead reset the
connection: `ECONNRESET` / `TRANSPORT_AMBIGUOUS`.

`ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED` is emitted by a server or intermediary
that requires a client certificate and sees none. It does not describe the
`CERT_OPTIONAL` producer or the Console's configured client-certificate path.

Alert-family spellings vary with the Node/OpenSSL build. The classifier accepts
`ERR_SSL_(SSLV3|TLSV1|TLSV13|SSL/TLS)_ALERT_<NAME>` with the closed names
`UNKNOWN_CA`, `BAD_CERTIFICATE`, `CERTIFICATE_UNKNOWN`, `CERTIFICATE_EXPIRED`,
`CERTIFICATE_REVOKED`, `UNSUPPORTED_CERTIFICATE`, `HANDSHAKE_FAILURE`,
`ACCESS_DENIED`, `DECRYPT_ERROR`, and `CERTIFICATE_REQUIRED`, and logs the
normalized name in `nodeCode`. A surfaced own-code `HANDSHAKE_FAILURE` alert
matches that list; measured write-path handshake/cipher/group mismatches instead
yielded `EPROTO`. `EPROTO` / `TLS_PROTOCOL_FAILURE` is an inconclusive catch-all
for write-path TLS failures, including version mismatch, cipher/handshake
failure alerts and plain HTTP on the TLS port. It is not a protocol-version
observation. Other surfaced alert names outside the closed list remain
`UNCLASSIFIED`. Local verifier code `UNSPECIFIED` is `TRUST_REJECTED` /
`CERTIFICATE_VERIFICATION`.

HTTP responses rejected by Node's parser (bad header bytes, duplicate
Content-Length or a status line with an invalid status token) are `INCONCLUSIVE` / `UNCLASSIFIED`, with `httpStatus: NONE`, even
when the bytes include status 403: no parsed response reached the adapter.
Node accepts a control byte in the reason phrase of `HTTP/1.1 403 Fo\x01o`;
when Fetch rejects that reason phrase, the parsed 403 still yields
`IDENTITY_REJECTED`.
Loopback HTTP development mode uses global fetch; its transport codes are nested
in `cause` and classify as `UNCLASSIFIED` under the own-code-only rule. The
production mTLS transport exposes the Node error directly.

Three reason vocabularies are kept in sync by tests: classifier outputs, JSON
Schema enum, and the browser's `CONSOLE_ERROR_REASONS` tuple. `ConsoleErrorReason`
is derived from that tuple and the optional response field uses that type. The
sync test enumerates classifier inputs, checks coverage of classifier reason
literals (excluding the separate contract-failure event), and compares outputs
with the schema and tuple. It also checks the type derivation and field binding.
Browser tests compare the tuple with the schema enum, accept each schema reason,
and reject unknown strings and non-string values. The BFF diagnostics suite
validates each 503 body against the complete schema using Ajv and explicit formats.

Ajv uses `strict: true, strictTypes: false`: full strict compilation rejects
`properties` without a local object `type` in an existing `allOf` branch. The
diagnostics test records that rejection, checks that only strictTypes is disabled,
and proves the registered `ajv-formats` validator rejects invalid timestamps.
The Ajv settings do not change schema semantics; the contract version is unchanged.

Local TLS fixtures share a signing helper with a wide validity window for normal
certificates. This tolerates wall-clock corrections between issuance and the
first handshake. Deliberate expired and future-dated certificates override that
window, so certificate time verification remains exercised.

The coordinator's real backward-clock D2 reenactment at base 1c338fc used
libfaketime 0.9.10 on only the Node 24.22.1 client (wall and OpenSSL time together,
monotonic real), with the same leaf: +0 -> HTTP 200; -30s -> CERT_NOT_YET_VALID,
failedStage TLS_HANDSHAKE, clockOffsetMs -30000 and
clockStepSinceLastObservationMs -30000; still stepped -> the same failure and
offset -30000, step 0; reverted -> HTTP 200. This real backward step is shown to
produce that signature, and reverting it restores success. D2 ran with the
per-interval offset at 1c338fc; under the round 8 running total the values are
within +/-1 ms (-29999/-30000). A single
production line remains co-occurrence consistent with a backward step. The four
result lines are quoted verbatim in test-results/d4-r8/reenactments.md.

Four D2 result lines, verbatim from the coordinator transcript:

```jsonl
{"label":"1-before-step","processWallTime":"2026-10-27T11:43:11.528Z","result":"OK","status":200}
{"label":"2-after-backward-step-30s","processWallTime":"2026-10-27T11:42:41.717Z","result":"FAIL","failureLine":{"time":"2026-10-27T11:42:41.765Z","stage":"SOURCE_ATTEMPT_START","route":"OTHER","correlationId":"corr-00000000-0000-4000-8000-000000000000","class":"TRUST_REJECTED","reason":"CERTIFICATE_VERIFICATION","nodeCode":"CERT_NOT_YET_VALID","httpStatus":"NONE","failedStage":"TLS_HANDSHAKE","elapsedMs":45,"phaseMs":{"dns":13,"connect":2},"wallClockStepMs":0,"clockOffsetMs":-30000,"clockStepSinceLastObservationMs":-30000,"lastObservationAgeMs":24,"stages":[]}}
{"label":"3-still-stepped","processWallTime":"2026-10-27T11:42:41.768Z","result":"FAIL","failureLine":{"time":"2026-10-27T11:42:41.801Z","stage":"SOURCE_ATTEMPT_START","route":"OTHER","correlationId":"corr-00000000-0000-4000-8000-000000000000","class":"TRUST_REJECTED","reason":"CERTIFICATE_VERIFICATION","nodeCode":"CERT_NOT_YET_VALID","httpStatus":"NONE","failedStage":"TLS_HANDSHAKE","elapsedMs":33,"phaseMs":{"dns":13,"connect":12},"wallClockStepMs":0,"clockOffsetMs":-30000,"clockStepSinceLastObservationMs":0,"lastObservationAgeMs":5,"stages":[]}}
{"label":"4-step-reverted","processWallTime":"2026-10-27T11:43:11.803Z","result":"OK","status":200}
```
