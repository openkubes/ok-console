# OK-170 prerequisites and readiness

> **This document is not an execution approval.** Planning only. OK-170 comment 15171 remains binding: no cluster access until Arash lifts the freeze; every live action requires separate explicit approval. The event ending grants no authority. No execution under this package is claimed.

## Prerequisites

Proposed work below is not asserted merged, built or executed. “To be opened” identifies missing PR/ticket work, not an existing tracker reference. The release owners must supply links and merged revisions before readiness; no status is inferred from this table.

| Item / required deliverable | Owner | Proposed PR/ticket | Changes C1 image? | Place in merge order |
|---|---|---|---|---|
| Typed allowlist, item-local Evidence omission and B1 observation bundle | Console owner | ok-console #127 / OK-209 | Yes | 1 |
| Truthful Claim/hosting/workload read-start times, external invalid-entry omission, unchanged valid external times | Producer owner | openkubes #452 | No (P1 yes) | Parallel to 1, before P1 build |
| Resolve producer freshness scope against the versioned design | Producer + Console owners, Arash decides | Second producer PR/ticket **to be opened if chosen** | No (P1 yes if chosen) | After scope decision, before BFF freshness/P1 freeze |
| Safe D4 reason/class mapping, Evidence detail route classified EVIDENCE, closed nodeCode handling | Console owner | D4 PR/ticket **to be opened**, stacked on #127; reviewed revision D4_REVIEWED_REVISION_PENDING | Yes | 2, after 1 |
| CorrelationId-filtered bounded server-log projection: only time/route/correlationId/class/reason/nodeCode/httpStatus, closed enums, no raw persistence | Console + security owners | Capture-tool PR/ticket **to be opened** | No for external projection; Yes if runtime change required | 3, after D4, before C1 build |
| Q(request) capture of actual consumed response on all four views for AC6/R4.S; independent sampling forbidden | Console + security owners | Consumed-response capture PR/ticket **to be opened** | Treat as Yes until reviewed design proves external capture suffices | 3, before C1 build; any later runtime change restarts R1/R3–R6 |
| Safe attribution to both serving replicas for R1, no raw Pod identity in browser output | Console owner | Replica-attribution PR/ticket **to be opened** | Treat as Yes until reviewed design resolves | 3, before C1 build |
| Per-item freshness, legacy/qualified Evidence behavior, loaded-page expiry; DiagnosticWidget envelope freshness and Ready counts on every page; agent/catalog/fixture boundaries | Console owner | Freshness/widget PR/ticket **to be opened** | Yes | 4, after D4 and producer scope/contract decision |
| R3.3/R3.5/Q2 verify-only tool with structural allowlisted Pod/RS/controller/init/image projection, no writer/Secret access/forwarding | Console + deployment owners | Verify-only/projection PR/ticket **to be opened** | No | Parallel to 3–4, before package review |
| Recovery overlays + renderer + tests aligned from rc.3 to frozen C1/P1 and all recovery/exit identifiers | Recovery + deployment owners | Recovery-artifacts PR/ticket **to be opened** | No | After pair build, before hashing/review |
| Q3-C command and exact data/binaryData/ownership checks | Operator + independent reviewer | This docs package; any reusable tool PR/ticket **to be opened** | No | Before package review; verbatim Q3 handles ConfigMap |
| D6 tracked overlay includes approved unchanged OK_CONSOLE_DRY_RUN_URL; ordered-env equality, no live edit | Deployment + OK-172 owners | D6 overlay PR/ticket **to be opened** | No | Before artifact rendering |
| Non-forced admission/apply verifier with exit renderer, OR pre-rendered hashed exit overlays/hand-back for every Recovery E and retry ledger entry | Deployment + recovery owners | Non-forced verifier PR/ticket **to be opened**, or artifact-only package route | No | Before final hashing; forced current verifier remains forbidden |
| B1/CR/PR and transient pair compatibility, isolated OK-173 negatives/JWKS sheet, identity/DB attestations, OK-210 exposure disposition | Release/IdP/DB/security owners | Package sheets; missing follow-up tickets **to be opened** | No, unless findings require code (then rebuild) | After candidate build, before sign-off |
| Re-review all four docs, hashes, rendered profiles, handoff/hand-back ledger and budget counts; explicit approvals/roster | Independent reviewer + Arash + OK-172 owner | Final package review/approval record | No | Last; readiness gate below |

Producer decision must be explicit: the smaller option keeps #452 on v0alpha2 with truthful timestamps and BFF-owned age verdicts. The broader freshness-design option (v0alpha3/generatedAt/Stale/coverage in the producer) requires a second producer PR and reviewed compatibility/routes in P1; #452 alone does not supply it. This package does not choose for Arash. Freeze the final contract version, producer source and routes before hashing; no mixed claims. #127 is typed output, not freshness/diagnostics.

## Readiness and window

1. All prerequisite code/config PRs for the chosen producer and closing paths are merged, with links/revisions in the package index. Lift freeze and separately approve read-only baseline recapture; reconcile historical versus repository/current target inputs and fingerprint without authorizing changes.
2. Build C1/P1 from those merged sources, verify publication/provenance/platforms, compatibility and source completeness. Hash C1/P1 and every reviewed manifest, capture/verifier build, ledger, protocol/roster sheet, including each emergency exit overlay and its hand-back. Any candidate change restarts R1/R3–R6.
3. Re-review the complete package against those exact bytes and recaptured baseline. Writer owners freeze other writers at execution-approval hashing; the freeze is procedural, not enforced. Movement invalidates approval/hashes.
4. Obtain explicit sign-off naming hashes, target fingerprint, roster, recovery bounds, ownership steps and D8 granted/withheld. **Earliest window = two working days after sign-off**, excluding weekends and owner-agreed holidays. Announce the approved start/end in UTC; no fixed date is proposed here. A changed package/roster requires fresh sign-off and a newly derived earliest date.

### Count-derived duration

This is a conservative planning ceiling, not measured runtime. Before sign-off replace ceilings with the hashed inventory counts; count any excess and extend/re-review/re-announce rather than compress. Each inspection/structural comparison/admission transaction has a ≤60 s budget; timeout fails closed. A five-object continuity snapshot is one bounded batch transaction, not five separate 60 s allowances. No query may silently overrun that bound.

| Step / count ceiling | Derivation in minutes | Allocation |
|---|---|---|
| G0 Q1–Q9 and ownership, initial artifact admission, G1 | Nine checks ×2 + five adoptions/nine releases ×(dry-run, Q3, apply, Q3, continuity) ×1 + Q3-C ×2 + origin G1 ×5 + thirty artifacts ×1 full two-way diff | 125 |
| Phases 2–3 core excluding 2.5 | B1 apply/Q3-C 2 + consumption 3; P1/C1 initial 3+5; epoch 3; R1 10; four views/provenance/consumed-Q capture 20 | 46 |
| 2.5 isolated protocol sheet | At most ten positive/negative token/JWKS cases ×3; exact isolated commands/bounds must be reviewed | 30 |
| Phase 4 core | U 0.5+1+2=3.5; T 3+1+3=7; R4.S/widget read-only observations 10; paired capture/session setup 9.5 | 30 |
| Phase 5 core | Six Deployment transitions ×3=18; 5.4 R1 10; fresh sessions/parked-flow preparation and comparison 17 | 45 |
| Phase 6 core, including 6.1/6.3 | Final R1 10; Q/inventory/view checks 10; last-flow TTL 5; retired-epoch expiry/requery up to 60 (OIDC absolute ceiling) | 85 |
| 6.5 closing on every exit | Five objects ×(adoption dry-run, Q3, apply; release dry-run, Q3, apply) = six transactions/object + overlay alignment/admission 5 | 35 |
| Same-epoch controls | Six checkpoints (2.1, 2.4, 5.1–5.4) ×(3 rollout+3 restore)=36; capture margin 4 | 40 |
| Repeated gate admission after G0 | Up to sixteen gates/transition checkpoints ×six next/restore/emergency artifacts ×1 complete structural diff | 96 |
| Continuity around non-ownership steps | Sixteen checkpoints ×two five-object batch snapshots ×1; ownership snapshots included in G0/6.5 | 32 |
| Protected recovery/closing reserve | Two emergency Deployment rollouts 6 + healthy/auth checks 4 + full 6.5 closure 35 | 45 |
| **Total proposed ceiling** | 125+46+30+30+45+85+35+40+96+32+45 | **609 min (10 h 09 min)** |

Closing's six transactions per object group Q3 with its dry-run/apply output comparison; each combined transaction must complete in ≤60 s. The final owner/continuity check is included in overlay/admission's 5 min, one per object. If the inventory cannot meet this bound, increase it before sign-off. Gates cover G1, 2.1/2.4, 2.5/G2, G3, G4U/G4S/G4T, 5.1–5.4/G5, 6.1/6.2/6.3/G6; actual sheet must enumerate all checkpoints/artifacts and continuity reads, including read-only substeps; count any additional ones. Initial G0 thirty-artifact admission is separate from the sixteen later admissions. Optional Ingress correction adds its reviewed bound and restoration to the total; no allowance is implied here.

A baseline OIDC session has 15 min idle; create/refresh the valid-before control immediately before each transition after long G0/expiry waits, with its same-epoch control and both-replica attribution. Never park a flow during those waits: each callback must complete <300 s including its rollout. Max 3 min later rollout leaves <2 min for convergence/callback; initial 5 min rollout has no TTL margin and needs a faster proven bound or redesigned control. Expiry is not evidence of epoch rejection. Retired-session counts at 6.1 may need the full 60 min absolute ceiling; final pending flows require ≥5 min after last start. Missing sheet/DB timing blocks readiness.

No automatic extension. Stop new tests when only the protected 45 min remain; restore and close. If a CR/PR exit is fail-open, its signed maximum duration must include restoration plus **all closing time**, within the remaining approved window, with a named owner and pre-hashed restriction/withdrawal alternative if C1/P1 cannot resume. Missing bound or artifact blocks execution.

Required roster: Arash (sign-off/freeze release), distinct operator and independent observer/timekeeper, recovery owner retaining API access, Console/producer release owners, OK-172 writer/ownership owner, IdP owner, DB owner, security/OK-210 reviewer, Suchit (AC13). Announce shared-dev impact, reauthentication/intermittent views, status route, abort and recovery owner. D8 remains a separate bounded approval; withholding requires re-reviewed/re-hashed direct-OIDC transition and leaves bootstrap/R6.4 acceptance pending. No physical cleanup/deletion is authorized.

## Evidence index and disposition

Use an explicit reviewed list of sanitized evidence files to generate SHA256SUMS, excluding SHA256SUMS itself and disposition.md. Hash that index; disposition.md separately cites its SHA-256 and records GO/REVISE/STOP plus AC13. Recompute evidence hashes independently. Adding closing/recovery evidence changes the index/hash before disposition; this avoids circular hashing.

**Scope of this evidence:** This package defines prospective requirements. Local fake-API fixture results qualify only the embedded documentation gates; they do not establish live baseline, impersonation authority, field ownership, runtime readiness or acceptance. The [plan scope](acceptance-plan.md#proposed-maintenance-window) carries threshold, deadline, OIDC-code and five-object continuity limits.

## Review coverage

Round-3 review item → final section and line. These are documentation requirements, not execution results.

| Item | Document | Section | Line |
|---|---|---|---|
| B1 target pin / G0 fingerprint | maintenance-procedure.md | Phase 0 — read-only pre-flight and separately gated ownership reconciliation; G0 | 51 |
| S1 baseline + event scope | acceptance-plan.md | Verified planning baseline and G0 inputs | 40 |
| S2 five objects / Q3-C | maintenance-procedure.md | Ownership reconciliation — separate Phase-0 decision and execution approval | 255 |
| S3 historical port-forward | README.md | Phase A deployment result | 159 |
| S4 producer freshness choice | prerequisites.md | Prerequisites | 27 |
| S5 verifier label preserved | README.md | Phase A deployment result | 135 |
| S6 D4 interpretation / reviewed revision | acceptance-plan.md | D4 final-candidate diagnostic contract | 181 |
| S7 Evidence route pending fix | acceptance-plan.md | D4 final-candidate diagnostic contract | 181 |
| S8 B1 applied / times unchanged | acceptance-plan.md | Pending D3/D5 freshness pass criterion | 203 |
| S9 derived window | prerequisites.md | Count-derived duration | 36 |
| Nit: 4.U labels | maintenance-procedure.md | Phase 4 — one R4 control at a time; G4U/G4S/G4T | 308 |
| Nit: README placeholder formatting | README.md | Identified target | 62 |
| Nit: root README citation | acceptance-plan.md | R1 — OIDC lifecycle (AC4) | 115 |
| Nit: SAN check excludes address projection | maintenance-procedure.md | Phase 4 — one R4 control at a time; G4U/G4S/G4T | 310 |
| Nit: freeze source 15171 / OK-170 scope | maintenance-procedure.md | OK-170 maintenance procedure — separate review required | 3 |
| Nit: pre-freeze dry-runs dated | maintenance-procedure.md | Authority, inputs and verified baseline | 19 |
| Nit: old reserve replaced | prerequisites.md | Count-derived duration | 53 |
| Nit: dates relative to sign-off | prerequisites.md | Readiness and window | 34 |
| R2 consumed Q | prerequisites.md | Prerequisites | 16 |
| R2 replica attribution | prerequisites.md | Prerequisites | 17 |
| R2 verify-only/projections | prerequisites.md | Prerequisites | 19 |
| R2 correlation log tool | prerequisites.md | Prerequisites | 15 |
| R2 recovery rc.3 alignment | prerequisites.md | Prerequisites | 20 |
| R2 Q3-C | prerequisites.md | Prerequisites | 21 |
| R2 D6 tracked overlay | prerequisites.md | Prerequisites | 22 |
| R3 DiagnosticWidget R4.S/R5/AC7/AC9 | acceptance-plan.md | R5 — authenticated real-state views (AC6) | 231 |
| R4 ConfigMap data/binaryData equality | maintenance-procedure.md | Phase 0 — read-only pre-flight and separately gated ownership reconciliation; G0 | 132 |
| R4 exact release set | maintenance-procedure.md | Phase 0 — read-only pre-flight and separately gated ownership reconciliation; G0 | 161 |
| R4 other owners retained | maintenance-procedure.md | Phase 0 — read-only pre-flight and separately gated ownership reconciliation; G0 | 145 |
| R5 Q8 exact no + empty stderr + positive | maintenance-procedure.md | Q8 — exact authorization and impersonation controls | 177 |
| R6 G0 / 2.5 / 6.5 budgets + readiness | prerequisites.md | Count-derived duration | 36 |
| R7 pre-hashed Recovery E closing | maintenance-procedure.md | 6.5 — closing handoff, then release the freeze | 352 |
| R8 Evidence route (S7) | acceptance-plan.md | D4 final-candidate diagnostic contract | 181 |
| R9 R4.T nodeCode allowlist | acceptance-plan.md | Pending D3/D5 freshness pass criterion | 204 |
| R10 non-circular evidence hash | prerequisites.md | Evidence index and disposition | 65 |
| R11 retired preview apply + port-forward | README.md | Phase A: immutable visual preview | 97 |
| R12 inspect cannot read as pass | maintenance-procedure.md | Phase 0 — read-only pre-flight and separately gated ownership reconciliation; G0 | 162 |
| Scope: R4.S live observations bracket | acceptance-plan.md | Proposed maintenance window | 363 |
| Scope: DEADLINE_EXCEEDED includes | acceptance-plan.md | Proposed maintenance window | 363 |
| Scope: OIDC_TRANSACTION_INVALID is one code | acceptance-plan.md | Proposed maintenance window | 363 |
| Scope: Continuity covers five objects | acceptance-plan.md | Proposed maintenance window | 363 |
| Scope: Writer freeze is procedural | acceptance-plan.md | Risk assessment | 326 |
| R2 carry-over B1 ordering/compatibility | acceptance-plan.md | Observation bundle compatibility and ordering | 100 |
| R2 carry-over P0/#452 distinction | prerequisites.md | Prerequisites | 12 |
| R2 carry-over CR/PR fail-open closing bound | acceptance-plan.md | Risk assessment | 335 |
| R2 carry-over D8 requested decision | acceptance-plan.md | Decisions requested from Arash | 316 |
| Follow-up review: exact adoption/metadata | maintenance-procedure.md | Phase 0 — read-only pre-flight and separately gated ownership reconciliation; G0 | 136 |
| Follow-up review: workload SA binding | maintenance-procedure.md | Q8 — exact authorization and impersonation controls | 201 |
| Follow-up review: B1 budget | prerequisites.md | Count-derived duration | 43 |
