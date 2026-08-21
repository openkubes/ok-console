# OpenKubes Console Presentation Contract v0alpha1

Status: **implemented by both consumer and provider; pending the final OK-160
Developer A/B handshake**.

This directory is the version-controlled boundary between the Console browser
and its read-only Backend-for-Frontend (BFF). It models OpenKubes product views;
it is deliberately not a Kubernetes API, provider API, or generic object proxy.

## Contract identity

- API version: `console.openkubes.io/v0alpha1`
- JSON Schema: [`schema.json`](schema.json)
- TypeScript model and tolerant runtime validation:
  [`src/domain/presentationContract.ts`](../../../src/domain/presentationContract.ts)
- Stable payloads: [`examples/`](examples)
- Read-only BFF provider: [`bff/`](../../../bff)
- Provider tests: [`bff/app.test.ts`](../../../bff/app.test.ts)
- Jira handshake: [OK-160](https://kubernauts.atlassian.net/browse/OK-160)
- Living specification:
  [Presentation Contract v0](https://kubernauts.atlassian.net/wiki/spaces/OpenKubes/pages/3142058015)

## Read-only resource kinds

| Kind | Purpose | Candidate endpoint |
| --- | --- | --- |
| `SessionContext` | Redacted identity, environment and coarse UI permissions | `GET /api/console/v0/session` |
| `PlatformOverview` | Aggregate posture and management-plane summary | `GET /api/console/v0/overview` |
| `ClusterList` | Stable cluster summary projections | `GET /api/console/v0/clusters` |
| `ClusterDetail` | Lifecycle, capabilities and evidence references | `GET /api/console/v0/clusters/{clusterId}` |
| `EvidenceReference` | Redaction-safe evidence metadata and authorized drill-down reference | `GET /api/console/v0/evidence/{evidenceId}` |
| `Error` | Bounded machine and user-facing failure information | all endpoints |

Endpoint paths remain candidate implementation details. The resource semantics,
envelopes and compatibility behavior are the shared contract.

## Envelope decisions

Every successful response contains:

- `apiVersion` and a closed `kind` for dispatch;
- a resource-specific `data` projection;
- `meta.contractVersion` for explicit compatibility;
- `meta.observedAt` and `meta.freshness` so HTTP success never implies readiness;
- `meta.correlationId` for safe diagnostics;
- optional source revision and bounded warnings.

Every failure contains a stable error code, a redaction-safe message,
retryability, a correlation ID, and optional safe details. Stack traces and raw
backend responses never cross the boundary.

## Compatibility behavior

- A different `apiVersion`, unknown `kind`, or invalid required field fails
  closed as incompatible and remains read-only.
- Consumers must ignore additive fields they do not understand.
- Unknown enum values must enter an explicit incompatible/fallback state; they
  must not crash a view or be interpreted as ready.
- Removing a field or changing its meaning requires a new contract version.
- Examples are stable test vectors. Changes require Developer A and Developer B
  review in the same pull request.

The JSON Schema is the producer-facing structural definition. The TypeScript
validator intentionally checks the stable compatibility and security boundary
without rejecting harmless additive fields, which keeps consumers tolerant.

## Security and redaction rules

Responses must never contain a field representing a token, bearer token,
refresh token, client secret, password, private key, kubeconfig, Secret, or raw
credential. Runtime validation rejects these field names recursively.

`EvidenceReference` is metadata, not an unrestricted Evidence payload. The BFF
decides whether an authorized drill-down reference may be returned. The browser
does not receive backend credentials to follow that reference directly.

## Consumer/provider workflow

1. Both developers review the schema, TypeScript types and stable examples.
2. Developer B consumes the examples through `ConsoleDataPort` and keeps the
   current fixture adapter behind the same port.
3. Developer A returns the same examples from provider contract tests before
   connecting observed state.
4. Both sides run:

   ```bash
   pnpm test:contract
   ```

5. Any intentional contract change updates the schema, TypeScript model,
   examples, tests, this document and the Confluence decision log together.

## Explicit non-goals

- Mutation requests and operation grants.
- Create/Register Cluster, Agent deployment, or Shell sessions.
- Raw Kubernetes resources or arbitrary proxy paths.
- Production OIDC, RBAC, tenant policy, or credential transport.
- Schema-generated or AI-adaptive runtime UI.

Those capabilities require separate contracts and security reviews after the
read-only slice is proven.
