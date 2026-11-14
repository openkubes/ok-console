# Fixture investigations

Deterministic investigations over **synthetic** packs. No cluster, model or network access; results live in a
bounded in-memory map. Enabled only when `OK_CONSOLE_INVESTIGATION_PACKS_DIR` points to a directory of pack files
(`*.json`, contract `contracts/investigation/v1alpha1/investigation-pack.schema.json`). The BFF validates every pack
at startup and refuses to start if one is invalid.

## API (`/api/console/v0`)

| Method | Path | Result |
|---|---|---|
| GET | `/investigations/scenarios` | `InvestigationScenarioList` |
| POST | `/investigations` with `{"scenarioId": "…"}` (only this field) | `201 InvestigationResult` |
| GET | `/investigations/{investigationId}` | `InvestigationResult` |
| GET | `/investigations/{investigationId}/evidence/{evidenceId}` | `InvestigationEvidence` (content, digest, integrity) |

Under `OK_CONSOLE_DEPLOYMENT_POLICY=fixture-read-only` exactly `POST /investigations` is allowed besides reads
(`FIXTURE_EVALUATION_WRITES`); every other non-GET request on these paths is refused with 403. A start only evaluates
the loaded pack. With sessions, a start must come from the Console origin.

## Verification

Each claim cites one fact as `<evidence_id>#<json-pointer>` (`fact_refs` of the platform-diagnostics 1.2.0 draft) and states an assertion
(`equals`, `gte`, `lte`, `contains`, `excludes`, `exists`). Values follow the approved verification vocabulary:

| Level | Values | Rule here |
|---|---|---|
| Evidence chain | `verified`, `rejected` | Digest of each evidence item over canonical JSON (`method: fixture-digest`). No issuer signatures: not the signed-chain verification required for live operation |
| Claim | `supported`, `contradicted`, `unverifiable`, `invalid` | `supported` only if the evidence exists, is cited by the hypothesis, is intact, belongs to the target cluster and the fact satisfies the assertion |
| Hypothesis | `consistent`, `inconsistent`, `not_assessed` | Any contradicted claim → `inconsistent`; at least one supported and none contradicted → `consistent`; blocked basis → `not_assessed` |
| Basis | `established`, `blocked` | All critical checks CHK-01 (integrity), CHK-02 (cluster binding), CHK-03 (nothing executed) passed |
| Assessment | `fully_supported`, `partially_supported`, `unsupported`, `check_failed`, `withheld` | From required checks CHK-04 (claims of the leading hypothesis) and CHK-05 (its consistency) |
| Outcome | `completed`, `inconclusive` | `completed` only with an established basis, a fully or partially supported assessment and a consistent **leading** hypothesis. A consistent alternative does not complete a run whose leading hypothesis is refuted |

## Recommendations

`executionStatus` is always `not_executed`; packs cannot declare execution fields and no route acts on a
recommendation. `eligible: true` means **only** that the recommendation is evidence-based and suitable for human review
(outcome `completed`, every hypothesis it is based on `consistent`). It is never an execution authorization.

## Time and freshness

| Field | Meaning |
|---|---|
| `evidence[].collectedAt`, `source.observedAt`, `meta.observedAt` | Collection time recorded in the fixture (latest one for the result). Not observed by this Console |
| `startedAt`, `completedAt` | Evaluation time of this Console |
| `source.freshness`, `meta.freshness` | Always `Unknown` (presentation-contract value): a fixture is no live observation, so its freshness cannot be established |

`reproducibility.resultDigest` covers everything except the investigation and correlation ids and the evaluation times: the same pack gives the same digest.

## Tests

`bff/investigations/*.test.ts` use the neutral `test-fixtures/example-crashloop.json`. Packs maintained elsewhere can
be run through the same contract and manipulation tests:

```sh
OK_CONSOLE_TEST_INVESTIGATION_PACKS_DIR=/abs/path/to/packs pnpm exec vitest run bff/investigations
```
