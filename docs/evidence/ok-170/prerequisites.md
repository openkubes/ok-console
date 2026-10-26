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
| **Gate tooling PR**: one repo script implementing Q3 preserve/adopt/release/inventory/post-apply-from-snapshot/B1-delta, Q8 cross-namespace RBAC and bidirectional admission contracts; unit fixtures and command-entrypoint tests | Deployment/tool owner + independent reviewer | Gate tooling PR/ticket **to be opened**; no script in this docs round | No | Merge before package review; hash script, kubectl v1.34.1, manager/operation allowlist, selected-paths and fixture results; assert KUBECTL_KUBERC=false, timeouts, fingerprint, single final PASS |
| Pending-flow timing control proving rollout+callback <300 s, valid-before and same-epoch positives on both replicas; initial 300 s rollout alone is insufficient | Console + IdP owners | Timing-control prerequisite PR/sheet **to be opened** | Yes if runtime change needed | Before build/hash; absent control leaves R1 blocked |
| T hostAliases mechanism: Console-only non-SAN name resolving to the existing producer Service; current Service-address binding, no new objects, paired removal and URL restore | Deployment + security owners | Reviewed T artifact/restore sheet **to be supplied** | No | Before hashing; ordinary four Service DNS names are SAN-covered, so cannot be the fault |
| D6 tracked overlay includes approved unchanged OK_CONSOLE_DRY_RUN_URL; ordered-env equality, no live edit | Deployment + OK-172 owners | D6 overlay PR/ticket **to be opened** | No | Before artifact rendering |
| Non-forced admission/apply verifier with exit renderer, OR pre-rendered hashed exit overlays/hand-back for every Recovery E and retry ledger entry | Deployment + recovery owners | Non-forced verifier PR/ticket **to be opened**, or artifact-only package route | No | Before final hashing; forced current verifier remains forbidden |
| B1/CR/PR and transient pair compatibility, isolated OK-173 negatives/JWKS sheet, identity/DB attestations, OK-210 exposure disposition | Release/IdP/DB/security owners | Package sheets; missing follow-up tickets **to be opened** | No, unless findings require code (then rebuild) | After candidate build, before sign-off |
| Re-review all four docs, hashes, rendered profiles, handoff/hand-back ledger and budget counts; explicit approvals/roster | Independent reviewer + Arash + OK-172 owner | Final package review/approval record | No | Last; readiness gate below |

Producer decision must be explicit: the smaller option keeps #452 on v0alpha2 with truthful timestamps and BFF-owned age verdicts. The broader freshness-design option (v0alpha3/generatedAt/Stale/coverage in the producer) requires a second producer PR and reviewed compatibility/routes in P1; #452 alone does not supply it. This package does not choose for Arash. Freeze the final contract version, producer source and routes before hashing; no mixed claims. #127 is typed output, not freshness/diagnostics.

## Readiness and window

1. All prerequisite code/config PRs for the chosen producer and closing paths are merged, with links/revisions in the package index. Lift freeze and separately approve read-only baseline recapture; reconcile historical versus repository/current target inputs and fingerprint without authorizing changes.
2. Build C1/P1 from those merged sources, verify publication/provenance/platforms, compatibility and source completeness. Hash C1/P1 and every reviewed manifest, capture/verifier build, ledger, protocol/roster sheet, including each emergency exit overlay and its hand-back. Any candidate change restarts R1/R3–R6.
3. Re-review the complete package against those exact bytes and recaptured baseline. Writer owners freeze other writers from artifact hashing; the freeze is procedural, not enforced. Movement invalidates approval/hashes.
4. Obtain explicit sign-off naming hashes, target fingerprint, roster, recovery bounds, ownership steps and D8 granted/withheld. **Earliest window = two working days after sign-off**, excluding weekends and owner-agreed holidays. Announce the approved start/end in UTC; no fixed date is proposed here. A changed package/roster requires fresh sign-off and a newly derived earliest date.

### Enumerated checkpoint sheet and duration

Prospective ceilings, not runtime measurements. Approve the exact artifact/manager inventory before sign-off; any excess needs recount/review, never compression. A five-object snapshot is one ≤60 s batch. Each admission, API mutation, Q check, health pair or runtime comparison is a distinct ≤60 s transaction; per-call timeout 10 s, whole invocation deadline as separately bounded in the tooling. Timeout fails closed. Budgets below include all repeats; artifact reuse at another checkpoint still costs another admission.

Artifact codes: E = emergency P+C (2); U = fault+restore (2); T = hostAliases fault+restore (2); C = same-epoch control+restore (2 per checkpoint). E clears T overrides, but restore T first before E if active. G0 inventory ceiling **53**: five ownership adoptions + ten old-owner releases + 26 phase artifacts (12 control/restore, B1/P1/C1-initial/C1-epoch, U/T four, rollback/forward four, bootstrap/post two) + ten closing artifacts + E two. Repeated P1 bytes may occupy distinct ledger slots; count them here conservatively. Each exit's selected-paths JSON and manager/operation allowlist are additional hashed inputs, not API artifacts. Optional Ingress/capture mutation is excluded and blocked until separately counted, reviewed and approved.

| Checkpoint(s), all named | Next/restore/emergency admission slots | Count | Session |
|---|---|---|---|
| G0 | Full inventory above | 53 | S1 |
| G1 | E; routing unchanged | 2 | S1 |
| 1.1a controls before 2.1, 2.4 | C+E each | 2×4=8 | S1 |
| 1.1a controls before 5.1, 5.2, 5.3, 5.4 | C+E each | 4×4=16 | S2 |
| 2.1 | B1, P1, C1_INITIAL, E; no automatic B0 restore | 5 | S1 |
| 2.4 | C1_EPOCH, E | 3 | S1 |
| 3.2/G3 (3.1 identity included) | E | 2 | S1 |
| 4.U induce | U+E | 4 | S1 |
| 4.U restore | U_RESTORE+E | 3 | S1 |
| 4.S | E | 2 | S1 |
| 4.T induce | T+E | 4 | S1 |
| 4.T restore | T_RESTORE+E | 3 | S1 |
| 5.1 | PR, CR_ROLLBACK, P1, C1_FORWARD, E | 6 | S2 |
| 5.2 | P1, C1_FORWARD, E | 4 | S2 |
| 5.3 | R1_BOOTSTRAP, R1_POST, E | 4 | S2 |
| 5.4/G5 | R1_POST, E | 3 | S2 |
| 6.1 initial counts | E | 2 | S2 |
| 6.2 inventory | E | 2 | S2 |
| 6.3 final R1/R5 | E | 2 | S2 |
| 6.4/G6 | E | 2 | S2 |
| 6.5c final exit gate | E | 2 | S2 |
| **25 checkpoints** | S1 12 / S2 13; 2.5 is separately proposed below | **132 = 89+43** | Both |

The checkpoint sheet counts one opening and one closing continuity snapshot at each of its 25 checkpoints (50). Per-mutation before/after snapshots below are separate calls even if adjacent; no call is counted twice. Baseline-browser 1.1, login/logout 2.2/2.3 and 3.1 are within their parent checkpoints, with continuity around **each** substep: add 8 snapshots (4×2), S1. Every additional read/browser substep needs its own pair; the signed expanded operator sheet must enumerate these rather than silently reuse a checkpoint pair.

| Disjoint allocation | Exact derivation (minutes) | S1 | S2 | Single total |
|---|---|---|---|---|
| G0 Q1–Q9 | 9×2 | 18 | 0 | 18 |
| Admission comparisons | 132 checkpoint slots + 15 immediately-before ownership artifacts + 10 immediately-before closing artifacts; each includes comparator/Q3 dry-run output check | 104 | 53 | 157 |
| Normal persisted API calls | 15 ownership (5 adopt+10 release) +26 phase (12 controls/restores+14 core) +10 closing (5 adopt+5 release), 1 each | 27 | 24 | 51 |
| Post-mutation verification | All 51 calls ×5: Q1, Q2, post-apply Q3-from-snapshot, TLS health 204 pair, R3.5 runtime comparison. Apply even for ownership-only Deployment steps; harmless over-allocation for Service/ConfigMap | 135 | 120 | 255 |
| Continuity | 51×2 mutation snapshots +25×2 checkpoint snapshots +4×2 named substep snapshots, 1 each | 86 | 74 | 160 |
| Normal convergence | 23 Deployment rollouts: initial 5 +22×3 =71; U routing/restore rounded up to3; T restore included among rollouts | 32 | 42 | 74 |
| Functional observations | Three R1 lifecycles 30 +four-view/consumed-Q 20 total across 3.2 and 6.3 +S/widget 10 +U/T hold 2 +session/capture preparation20 +last-flow TTL5 | 52 | 35 | 87 |
| 6.5c closure checks | Q1–Q6=6; two final dry-run sets ×five objects=10; exit overlay/owner alignment5 | 0 | 21 | 21 |
| Other named checks | B1 consumption3 +3.1 R3 identity4 +6.1 initial DB2 +6.2 inventory2 +6.3 Q1–Q9 18/final health1 | 7 | 23 | 30 |
| **Normal subtotal** | 18+157+51+255+160+74+87+21+30 | **461** | **392** | **853** |
| Protected recovery reserve | T restore3 +P/C recovery rollouts6 +3 API calls3 +6 snapshots6 +3×5 post-checks15 +Q1–Q6 six +fresh login/old-context controls10 +T/E admission4 | 53 if abort | 53 if abort | 53 |
| **Single-session ceiling** | **18+157+51+255+160+74+87+21+30+53 = 906** | | | **906 min (15 h 06 min)** |

Reserve covers active T restore then Recovery E and checks. Active U restoration is ≤2 min within T's 3 min allowance; U and T never coexist. Closing is budgeted **once**, in normal rows (10 admissions, 10 API calls, 50 post-check minutes, continuity and 6.5c); on abort use that unspent allocation rather than adding another closure. Protect those closing allocations plus the 53 min recovery reserve throughout; stop new tests when that combined remaining budget is reached. If any closing allocation was already consumed and another close is required, stop for incident handling/new approval rather than assume an extension. Fail-open owner/N approval must cover this full restore/recovery/closing path; missing N blocks readiness.

### Separate steps and two-session option

Propose **2.5 before the window**, in an isolated environment, with separate approval and a 30 min ceiling (ten source-matched token/JWKS cases ×3 including positives). No shared realm/key or shared-cluster access. Bind results to frozen source/config/tool hashes; changed candidate invalidates them. If not approved, add its budget back through re-review or leave dependent acceptance pending.

Propose **6.1 post-expiry recount after 6.5 hand-back**, as a separately approved read-only DB query: up to 60 min elapsed expiry plus 2 min query ceiling, outside the maintenance total. Initial counts and rejection controls remain in-window. Keep AC10/count-expiry evidence pending until the recount, with explicit DB owner and ledger lower bounds; no writer freeze or live mutation is implied by this separate step.

Two-session alternative: S1 Phase 0+G1+Phases 2–4 =461 normal +53 recovery +**115 protected S1 abort-closing allowance =629 min**. S2 Phases 5–6+6.5 =392 normal +53 recovery +**32 min re-entry =477 min**. Total **1106 min =629+477**, 200 more than single-session (second recovery reserve53 +S1 abort-close115 +re-entry32). S1 abort-close duplicates closing only as an independent session contingency: 10 admissions +10 API calls +50 post-checks +20 mutation snapshots +21 final checks +2 gate admissions +2 gate snapshots =115. Successful S1 retains custody and does not spend that allowance; failed S1 closes and cancels S2. Never count two closing paths against one single-session allowance.

Re-entry: Q1–Q9 18 +five-object continuity/owner comparison2 +rehash index/ledger2 +ten next/restore/emergency admissions10 =32 min. The ten slots are P1/PR/CR_ROLLBACK/C1_FORWARD/R1_BOOTSTRAP/R1_POST/E pair and current control/restore. Ordinary S2 checkpoint admissions remain separately counted. No positive session/flow may be carried across overnight; re-establish controls.

Overnight trade-off: more roster time, a longer writer freeze and ok-170-acceptance custody, with C1/P1 healthy and all U/T/control markers restored at S1 exit. Keep operator/recovery owner on call; name overnight owner, bounds and announcement. S1 failure routes through the already allocated 6.5 close and cancels S2. Re-entry requires identical pair/config/owners/ledger and no unexplained movement; attributed status-only updates must be reviewed. Any other drift invalidates hashes: do not use the 32 min shortcut, re-run full Phase 0 under a recounted/newly approved window. No consent to overnight custody means one approved session or a newly planned full-close/full-Phase-0 second session.

All session/flow controls use fresh valid-before evidence after long waits. OIDC idle is 15 min; callback must finish <300 s including rollout. An initial 300 s rollout leaves no TTL margin: the timing-control prerequisite must resolve this before readiness. No automatic extension. Required roster: Arash, distinct operator/observer-timekeeper, recovery and overnight owners, Console/producer/OK-172 release owners, IdP/DB/security owners and Suchit (AC13). macOS-only behavior needs Arash's verification.

## Evidence index and disposition

Hash the explicitly reviewed sanitized file list, excluding SHA256SUMS itself and disposition.md. Disposition separately cites the index SHA-256 and GO/REVISE/STOP plus AC13; independent recomputation follows closing/recovery evidence capture. No local simulation results are offered as acceptance evidence.

**Scope of this evidence:** Applies to prospective docs and prerequisites; shown in the gate contract and checkpoint sheet, not execution. Follow-ups: merged gate tooling with fixture/negative-case evidence, independent target/endpoint attestation, frozen artifacts and explicit approvals remain required. Fingerprint TOFU, clone and external-tool boundaries are in the plan's scope paragraph.

## Review coverage

Round-4 item → final section/line; documentation requirements only, no execution claim.

| Item | Document / section | Line |
|---|---|---|
| BLOCKER D3/D5 rollback exception | acceptance-plan.md / Decisions requested from Arash | 317 |
| S1 checkpoint recount / restores / post-checks | prerequisites.md / Enumerated checkpoint sheet and duration | 38 |
| S2 pre-window 2.5 / post-hand-back recount | prerequisites.md / Separate steps and two-session option | 88 |
| S2 two sessions / overnight / re-entry | prerequisites.md / Separate steps and two-session option | 94 |
| S2 writer freeze from hashing / lead time | acceptance-plan.md / Decisions requested from Arash | 321 |
| S3 producer scope Yes/No | acceptance-plan.md / Decisions requested from Arash | 319 |
| S3 readiness / lead time / duration Yes/No | acceptance-plan.md / Decisions requested from Arash | 320 |
| S3 D4 No requires changed C1 | acceptance-plan.md / Decisions requested from Arash | 318 |
| S4 post-apply retained snapshot | maintenance-procedure.md / Gate contracts — implementations are a prerequisite | 89 |
| S5 T mechanism / SAN coverage | maintenance-procedure.md / Phase 4 — one R4 control at a time; G4U/G4S/G4T | 178 |
| S6 conditional D4 in procedure | maintenance-procedure.md / Product gaps and execution scope | 26 |
| S6 conditional D4 in plan | acceptance-plan.md / R4 — fail-closed drills (AC8) | 174 |
| Nit inventory assertion label | maintenance-procedure.md / Gate contracts — implementations are a prerequisite | 79 |
| Nit Q8 fingerprint before reads | maintenance-procedure.md / Phase 0 — read-only pre-flight and separately gated ownership reconciliation; G0 | 63 |
| Nit B1 as applied / unchanged timestamps | maintenance-procedure.md / Phase 4 — one R4 control at a time; G4U/G4S/G4T | 177 |
| Nit B1 artifact wording | acceptance-plan.md / Artifact and digest package | 364 |
| Nit README historical tense | README.md / Phase A: immutable visual preview | 99 |
| Nit no local simulation proof reference | prerequisites.md / Evidence index and disposition | 102 |
| Nit pending-flow control prerequisite | prerequisites.md / Prerequisites | 22 |
| Nit selected-paths JSON per exit | maintenance-procedure.md / 6.5 — closing handoff, then release the freeze | 220 |
| Nit optional event features decision | acceptance-plan.md / Decisions requested from Arash | 327 |
| H1 explicit force false / kuberc disabled | maintenance-procedure.md / Phase 0 — read-only pre-flight and separately gated ownership reconciliation; G0 | 56 |
| H2 inventory manager/operation allowlist | maintenance-procedure.md / Gate contracts — implementations are a prerequisite | 85 |
| M3 two-way admission / B1 delta | maintenance-procedure.md / Gate contracts — implementations are a prerequisite | 90 |
| M3 bidirectional comparator | maintenance-procedure.md / Gate contracts — implementations are a prerequisite | 92 |
| M4 artifacts / applies / releases / closing / reserve | prerequisites.md / Enumerated checkpoint sheet and duration | 71 |
| M5 actual v1.34.1 entrypoint fixtures; old proof removed | maintenance-procedure.md / Gate contracts — implementations are a prerequisite | 96 |
| M6 cross-namespace/group RBAC / wrong identity | maintenance-procedure.md / Gate contracts — implementations are a prerequisite | 91 |
| L7 single final PASS after all objects | maintenance-procedure.md / Gate contracts — implementations are a prerequisite | 81 |
| L8 TOFU / clone / external tools | acceptance-plan.md / Proposed maintenance window | 375 |
| L9 per-call timeout / fail closed | maintenance-procedure.md / Gate contracts — implementations are a prerequisite | 93 |
| Info context tracked, value not repeated | maintenance-procedure.md / Phase 0 — read-only pre-flight and separately gated ownership reconciliation; G0 | 51 |
| Direction one tested prerequisite, no gate script here | prerequisites.md / Prerequisites | 21 |
