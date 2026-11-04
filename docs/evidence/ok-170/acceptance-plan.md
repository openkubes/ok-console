# OK-170 acceptance plan: Scope C

> **Planning record, not an execution approval.** Step 4 as a whole, including its read-only inventory, runs only in a window Arash has explicitly approved. Each live write needs Arash's explicit approval: deploy C1, deploy P1 and fail-closed abort. Steps 1, 4 and 5 remain open; completed disposable-cluster work grants no ok-shared execution authority.

## Candidate and rollback pairs

| Pair / tooling | Source |
| --- | --- |
| C1 Console | ok-console main `0a164e3` plus #139 (trust diagnostics), #142 (local-login throttle fails closed), #140 (per-item freshness verdict), #143 (freshness labels in the UI), to be merged in that order (all four PRs are open) |
| P1 producer | openkubes `1b0739fc` |
| CR / PR rollback | ok-console `0a164e3` / openkubes `94ab8d9`; the pair running before C1/P1, freshness-unaware |
| Gate tooling | ok-console #145, independent of C1 |

The [full-session procedure](maintenance-procedure.md) is kept for a later window and needs its own review before use.

## One working day: 6 h

Caps exclude review time; at a cap or failed exit, stop and report. One review round per PR unless it finds a blocker.

| Step | Content | Cap | Exit | Status |
| --- | --- | --- | --- | --- |
| 1 | Build C1/P1 once after the C1 PRs merge; record digests and provenance | 20 min | Digests and source revisions recorded | Open (after merge) |
| 2 | Gate-tooling proof on disposable kind v1.34.1: ownership, permission, admission with real server-side apply adopt/release/conflict and one expected rejection | 60 min | Each check passes its positive and fails its invalid-input case | Done off-cluster, #145 |
| 3 | Disposable C1/P1 drills: invalid trust, producer down, stale and partial data, rollback and forward, cleanup | 70 min | Baseline/fault/recovery per drill; stale items Unknown end to end | Done off-cluster on locally built C1/P1; results below |
| 4 | ok-shared: read-only inventory, deploy C1/P1, image ID check, four authenticated read-only views, mutations confirmed disabled; fail-closed abort withdraws the producer route and Console serves its bounded 503 | 180 min live | Image IDs match; views show producer data with observation times | Needs Arash's explicit approval |
| 5 | One evidence record and disposition (GO / REVISE / STOP) | 30 min | Disposition recorded | Open |

Total: 6 h = 2.5 h off-cluster + 3 h live + 0.5 h record. Step 4 uses existing sign-in configuration, with no OIDC change. Event features stay in C1 only while they need no live change.

## Step 3 drill results

Disposable kind v1.34.1; C1 is a local merge of #143 and #142 onto main; both are stacked on #139 (and #143 on #140), so all four PRs are included, at their current heads. P1 is openkubes `1b0739fc`. Two consecutive green runs of the same checks; all drills recovered.

| Drill | Result |
| --- | --- |
| Drill 1 producer down | 503 TRANSPORT_FAILURE / SOURCE_UNREACHABLE |
| Drill 2 invalid trust | CERTIFICATE_VERIFICATION / TRUST_REJECTED |
| Drill 3 stale item | Unknown while a fresh sibling stays Current; observation timestamp unchanged |
| Drill 4 explicit and invalid readiness | Unknown |
| Drill 5 rollback and forward | C1/P1 -> CR/PR -> C1/P1; image IDs, health, API and UI checked at each step. CR shows the stale item as Current, motivating step 4's fail-closed abort (R1). |
| Drill 6 freshness verdict removed | Freshness assertions fail, demonstrating that the drill can fail |
| Drill 7 wrong client identity | IDENTITY_REJECTED / INCONCLUSIVE |

Scope of the drills:

- Stale UI wording is "Observation unavailable - readiness Unknown". The stale item's Evidence body keeps classification Current with meta Stale as a historical record.
- P1 reports partial in hosting-cluster mode, so the "partially degraded" banner appears on every baseline; Drill 4 rests on the item turning Unknown.
- Drill 1 scales the producer to 0; hung-producer and selector-isolation cases are outside this drill. Drill 7 covers a wrong SPIFFE URI only.
- Drill 3/Drill 4 server evidence consists of BFF fields and absence of a failure log line. UI assertions cover only the Clusters list.
- One rollback cycle; mixed pairs and session or callback rejection are deferred. Forward retry is shown by code reading only.

## AC map

AC text remains in Jira; numbers and short topics below identify it without reproducing it. Deferred work stays open, not waived.

| AC | Topic | Where shown | Deferred part |
| --- | --- | --- | --- |
| AC1 | Target identified | Existing [Identified target](README.md#identified-target) record; step 4 read-only inventory | Live re-inventory in step 4 |
| AC2 | Console digest/image ID | Steps 1, 4 | Both steps open |
| AC3 | Producer revision/image | Steps 1, 4 | Both steps open |
| AC4 | OIDC login/session/logout | Deferred | Open, not waived (R6) |
| AC5 | mTLS identity | Step 3 drills 2 and 7 (negatives) off ok-shared; step 4 (positive: producer data served over the mTLS path) | Live negative (R2); step 4 open |
| AC6 | Four real-state views | Step 4: Overview, Clusters, Cluster Detail, Evidence; UI labels by #143 | Step 4 open |
| AC7 | No raw objects/secrets in browser | Repository tests + step 4 | Step 4 open |
| AC8 | Fail-closed | Step 3 Drill 1-Drill 4, Drill 7 | Live negatives (R2) |
| AC9 | Mutations disabled | Step 4 | Step 4 open |
| AC10 | Rollback and cleanup | Off-cluster step 3 Drill 5 | Live deferred, open, not waived (R1) |
| AC11 | Evidence record | Step 5 | Open |
| AC12 | CI green | Each PR | Required per PR |
| AC13 | Disposition | Step 5 | Open |

## Deferred-risk register

R1-R9 here are the Scope C register; the R-numbered sections of the maintenance procedure and of earlier review comments use their own numbering.

| Risk | Current state | Revisit |
| --- | --- | --- |
| R1 | Live rollback to CR/PR would show stale data as Current (Drill 5); step 4 abort is fail-closed | A reviewed freshness-aware rollback pair |
| R2 | Live trust/outage drills are not run on ok-shared; AC5/AC8 negatives shown on disposable clusters | Separate live drill window |
| R3 | decision D8 breakglass not executed | Its own approval |
| R4 | decision D10 ownership handoff not executed; #145 supplies the tested gate tool a later handoff would use | Its own approval |
| R5 | decision D6 dry-run URL tracking not executed | Its own approval |
| R6 | OIDC on the deployed BFF is not shown (AC4) | Arash's decision to deploy OIDC or record a deviation |
| R7 | Stale wording implying current state addressed in #143 | Listed follow-ups: deploy wizard and Capabilities catalog wording, envelope generation-time field, non-Chromium browsers and macOS |
| R8 | Failed local login uncounted on throttle lock timeout addressed in #142 (fails closed) | Listed follow-ups: row retention, further SQLSTATE classes, multi-pod/CNPG verification |
| R9 | Shared CA issues Console identity to any Certificate writer | OK-210 |

## Decisions for Arash

Recorded decisions, not new execution approvals:

| Decision | Recorded answer |
| --- | --- |
| D1 | Yes |
| D2 | Yes |
| D3 | No; fixed in code by #140 and #143 (freshness and labels) |
| D4 | No; fixed in code by #139 (trust diagnostics) |
| D5 | No; fixed in code by #140 and #143 (freshness and labels) |
| D6 | Adopt only after documenting/verifying tracked config; no live change |
| D7 | Not required |
| D8 | Only as a separately approved bounded exercise |
| D9 | Yes; window after the event, needs sign-off |
| D10 | Yes in principle; not executed |

## Evidence and redaction

Retain pair/source/profile/window, AC-number mapping, exact sanitized commands/results/versions/UTC, scope and disposition; hash reviewed artifacts excluding the checksum file itself. Record publication/provenance/signatures, OCI parent/child/platform, source membership, controller/Pod identities, image IDs and manifest hashes. Keep before/fault/recovered UI/API/timing, safe discriminators, inventory delta/retained set and final health/auth; any later lifecycle evidence must retain pseudonymous scope, safe status/code/correlation, cookieSent/transactionCookieSent booleans, valid-before/rejected-after checks, elapsed idle/absolute ages, same-epoch session/parked-flow controls, callback timing under 300 s, replica attribution, consumed-response expected/actual fields and redacted screenshots. Later rollback/cleanup evidence also retains the identifier ledger and aggregate retired-epoch counts/expiry. Deferred lifecycle and live rollback/cleanup records belong to their separately reviewed windows.

Allowlist safe projections before persistence. Never record Secret values/hashes, tokens, cookies/CSRF, codes/callback queries, state/nonce/PKCE, credential names/values, session/transaction digests/envelopes, raw summaries, headers, HAR, browser traces or storage-state exports. Replay state stays only in isolated memory. Record boolean security-attribute/cookie-sent checks; review screenshots for identity leakage.

## Scope of this evidence

- **Applies to:** Scope C and the identified source pairs; live execution remains separately approved.
- **Shown in:** #145 gate-tooling proof and the step 3 disposable-cluster results above. These are off-cluster results, not observations of deployed C1/P1 on ok-shared.
- **Follow-ups:** Steps 1, 4 and 5 remain open; deferred ACs and R1-R9 retain their stated disposition. No macOS access was available; Arash, please verify macOS-only behaviour. C1 built in step 1 is checked against the drilled heads (#142 2a96b03, #143 2af9afb); any change after these heads repeats the affected drills.
