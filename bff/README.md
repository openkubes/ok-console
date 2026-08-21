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

All other paths return a bounded `NOT_FOUND` response. Non-`GET` methods fail
closed; there is no generic Kubernetes proxy and no mutation endpoint.

## Runtime boundary

- `server.mjs` owns process startup and graceful shutdown.
- `app.mjs` owns routing, contract envelopes, correlation IDs, authorization
  hooks, security headers, bounded errors, and a credential-free request
  observation hook.
- `presentation.mjs` maps observed state through explicit allowlists. It never
  spreads backend objects into responses.
- `adapters/fixtureObservedState.mjs` is the first controlled observed-state
  adapter. A production adapter can replace it without changing HTTP or browser
  contracts.
- `contract.mjs` provides producer response helpers and a final recursive
  credential-field guard.

The default authorizer is deliberately marked as a prototype. Production OIDC,
RBAC, tenancy policy, and credential transport remain separate security work.
The hook is evaluated at the point of use for every resource and is covered by
provider tests.

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

## Verification

```bash
pnpm test:bff
pnpm test:contract
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
authorization, and provider tests at this HTTP boundary.
