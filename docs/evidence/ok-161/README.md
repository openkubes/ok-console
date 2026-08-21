# OK-161 spike decision — GO

Date: **2026-08-21**

Decision owner: **Arash Kaffamanesh**

Independent reviewer: **Suchit Thakkar** (follow-up review pending)

Scope: **OK-155 first read-only OpenKubes Console vertical slice**

## Decision

**GO** for the next curated implementation phase.

This is an architecture and product-direction GO, not a production-readiness
approval. The spike proved that a curated OpenKubes Console can consume stable,
evidence-aware presentation projections through a narrow read-only BFF without
binding React views to Kubernetes or provider resource shapes.

Production use remains gated by the follow-up work listed below.

## What was proven

- `console.openkubes.io/v0alpha1` is executable on both consumer and provider
  sides.
- Fixture and BFF adapters implement the same `ConsoleDataPort` and expose
  equivalent top-level and cluster presentation shapes.
- The HTTP journey covers Overview, Cluster list, Cluster detail and Evidence
  reference projections, with `ok-mgmt` first as the management plane.
- The BFF is GET-only, has a closed route table and exposes no generic
  Kubernetes proxy or mutation endpoint.
- Projection is allowlist-based; token, kubeconfig, private-key, Secret and raw
  backend data are rejected or omitted.
- Freshness, correlation, compatibility, provenance and redaction behavior are
  explicit and diagnosable.
- Desktop and compact layouts preserve the curated OpenKubes visual language
  without document-level horizontal overflow.

## Evidence matrix

| OK-161 concern | Result | Versioned evidence |
| --- | --- | --- |
| Consumer contract examples | Pass | `src/domain/presentationContract.test.ts` |
| Provider contract resources | Pass | `bff/app.test.ts` |
| Success and error validation | Pass | shared validator plus stable JSON examples |
| Additive optional fields | Pass | tolerant-compatibility regression test |
| Unknown enum semantics | Pass, fail closed | readiness regression test |
| Forbidden/unavailable/incompatible | Pass | provider and adapter tests |
| Stale/degraded behavior | Pass | provider tests and visible Console warning state |
| Redaction and backend exception safety | Pass | recursive guard and provider tests |
| No mutation or generic proxy | Pass | POST and arbitrary-path provider tests |
| Fixture/BFF shape equivalence | Pass | vertical-slice shape assertion |
| Live HTTP read-only journey | Pass | `bff/verticalSlice.test.ts` |
| Responsive visual checks | Pass | `docs/evidence/ok-159` |
| Real-browser same-origin CI journey | Follow-up | OK-164 |

At decision time, the complete repository suite passes together with ESLint,
TypeScript, Node syntax checks and the Vite production build. GitHub CI passed
for the merged implementation PRs.

## What remains uncertain

| Risk | Why it is not a STOP condition for the spike | Follow-up |
| --- | --- | --- |
| Real OpenKubes observed state is not connected | The adapter and projection seams are proven with a controlled source | [OK-162](https://kubernauts.atlassian.net/browse/OK-162) |
| Authentication and RBAC are prototypes | Production auth was an explicit non-goal; the point-of-use hook is isolated | [OK-163](https://kubernauts.atlassian.net/browse/OK-163) |
| Same-origin browser E2E is not yet automated | HTTP integration and responsive UI were verified independently | [OK-164](https://kubernauts.atlassian.net/browse/OK-164) |
| Suchit's independent contract acceptance is pending | The governance exception is explicit and reversible through follow-up revisions | [OK-165](https://kubernauts.atlassian.net/browse/OK-165) |

Any security or contract-integrity issue found by OK-165 can still create a STOP
condition for production adoption.

## Contract decision

No contract revision is required for the next curated phase. Additive optional
fields remain tolerated; unknown versions, kinds and enum semantics fail closed.
Intentional breaking changes require a new contract version and coordinated
schema, example, TypeScript, consumer and provider updates.

## ADR disposition

No new ADR is required for this spike outcome. The implementation validates the
direction already proposed by
[ADR-Platform-036](https://github.com/openkubes/openkubes/blob/main/architecture/decisions/ADR-Platform-036-openkubes-console-architecture.md): curated presentation contracts, observed state and evidence references, with
schema/AI adaptation deferred. The provisional two-person review waiver is a
delivery-governance exception, not a lasting architecture decision.

Extracting the BFF into a separate repository or runtime is also deferred until
release cadence, ownership or scaling creates an actual boundary.

## Recommended sequence

1. OK-162 — connect a controlled real observed-state adapter.
2. OK-163 — design and harden production identity, session and authorization.
3. OK-164 — automate real-browser, keyboard and accessibility evidence.
4. OK-165 — complete Suchit's independent contract review in parallel.

The next phase should remain read-only until the first three production gates
are satisfied. Create/Register Cluster, Agent deployment and Shell mutation
contracts require separate authorization and execution reviews.
