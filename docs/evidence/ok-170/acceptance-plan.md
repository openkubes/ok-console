# OK-170 acceptance plan: one immutable Console/producer pair

> **This document is not an execution approval.** Merging it authorizes no change on ok-shared. Every live step needs a separate, explicit approval of the hashed artifact package and a dated window. The Sovereign Cloud Days event on 2026-10-24 has ended; the recorded freeze (OK-170 comment 15171) prohibited deployment, promotion, rollout, server-side apply, ownership handoff, configuration, credential, certificate, RBAC or producer change, fault injection, negative live test, maintenance exercise or rollback before or during it, and the end of the event does not grant execution authority. Until Arash explicitly lifts the freeze, no ok-shared access of any kind is permitted, including read-only access and server dry-runs.

## Purpose and ownership

**Planning only. OIDC AC4 remains mandatory.** This plan defines the acceptance mapping for R1 and R3–R6 on one frozen pair.
Every acceptance check below is prospective and requires separate execution approval.
The [maintenance procedure](maintenance-procedure.md) owns change steps, blast radius, timing budgets, abort and recovery.
This plan owns the AC mapping and [Decisions table](#decisions-for-arash).
Admission dry-run, readiness and repository tests cannot substitute for browser or live acceptance results.

## Pair and naming contract

| Name | Meaning / immutable value |
| --- | --- |
| C0 | The live Console recorded at G0: record immutable index, inspected platform child, source revision label and Deployment generation; no fixed digest defines C0. Example at 2026-10-22 12:12 UTC: `ghcr.io/openkubes/ok-console@sha256:e70b44690adb4a035d3c0f01e01ee366a5bfe55f8ff60861b26ad1ab9a48ddee`, generation 43; linux/amd64 child `sha256:04f3c727a0e2c32bfdedb56c6eb03243615f5ffce45d330533919c4f18c57ee6`, revision label `182d8dfed618235138f212b0dfe3c9b6d5c80f2f`. |
| P0 | The live producer recorded at G0: record immutable reference, source revision label and Deployment generation. Example at 2026-10-22 12:12 UTC: `ghcr.io/openkubes/observed-state-producer@sha256:6ee7ce8f26a436cf03f56dd5e9ff065c0e121183320cd68e1acaab7916646012`, revision `ad351c9fe6ff9f2d14ccdd28c49e2f71e081c83d`, generation 10. |
| C1 | Proposed candidate: a newly published immutable build whose source contains R2 merge `eb6e7513e073a149fcbcde8a9eb486ba142cdc86`, R7 merge `ddb73d99377dbb46d1d41ca1886fac9ef69879df` with OIDC, plus the required D3–D5 fixes and OK-209 typed output contract (ok-console PR #127); freeze once after code review and those merges. Full digest and publication proof required before execution approval; labels or source membership alone cannot qualify C0 as C1. |
| P1 | Producer for C1 built from merged truthful-observation-time code (openkubes PR #452), required by D3/D5; source/provenance and compatibility must pass. Record its full immutable reference after the required build and review. |
| CR / PR (rollback pair) | Propose C0/P0 only if C0 != C1. At G0 compare full immutable references; if equal, select a distinct archived Console/producer pair with reviewed provenance and schema/key/mixed-version compatibility before approval. Absence of a distinct compatible target blocks rollback and execution. Label these observations as rollback evidence, never C1 acceptance. |
| E0 / A0 | Epoch / authorization revision recorded at G0 (example: `ok-shared-phase-b1-1` / `ok-shared-bootstrap-v1`); never restore retired identifiers. |
| E1 / A1 | Initial C1/P1 acceptance deployment. |
| E2 / A1 | Same-pair epoch-only invalidation; authorization configuration unchanged. |
| E3 / A2 | CR/PR rollback checkpoint. |
| E4 / A3 | Forward to identical C1/P1. |
| E5 / A4 | C1/P1 bootstrap recovery (procedure step 5.3). |
| E6 / A5 | Final C1/P1 OIDC-primary BreakGlass restoration. |
| E7 / A6 | First emergency Recovery E; pre-rendered for the current gate. |
| E[n] / A[m] | Further emergency/retry identifiers: allocate n≥8, m≥7 monotonically before use. Each denotes a unique unused value in the reviewed ledger; never reuse an attempted value. |
| Q(request) | Actual producer v0alpha2 response consumed for that BFF view request, correlated through approved sanitized capture; an independent producer sample is insufficient. |

E/A names are ledger aliases, not literal deployment values. Render unique epochs and configuration-bound authorization revisions before approval.
A1 is shared only for the explicitly unchanged authorization configuration at E1→E2. All replicas must converge before rejection counts.
Freeze C1/P1, both source SHAs, platform manifests, publish runs/tags, verified provenance/signatures, browser/runtime profiles and manifest hashes; the writer freeze starts at this execution-approval hashing.
Any candidate image change restarts R1/R3/R4/R5/R6 against a new record.

## Verified planning baseline and G0 inputs

Read-only planning baseline: 2026-10-22; cluster `ok-shared`, the approved operator context, application namespace `openkubes-console`.
Obtain and verify **kubectl v1.34.1 before G0**, matching the observed server **v1.34.1**; an unavailable pinned client blocks G0.
Repository references below are relative to ok-console main `a4f6237d73f45c8971d8e9106d47abf90d496e49` (contains R2/R7); producer references identify the example baseline producer's labelled revision `openkubes@ad351c9`.
Cluster JSON reads must project allowlisted fields before recording; no complete object dumps or Secret data.

| ID | Read-only source / command | Planning fact or G0 requirement |
| --- | --- | --- |
| L0 | `kubectl version -o json` | Server v1.34.1. G0 records the pinned client and server versions. |
| L1 | `kubectl -n openkubes-console get deployment ok-console observed-state-producer -o json` | Example at 12:12 UTC: Console generation/observedGeneration 43, 2/2 Ready/updated/available; producer 10, 1/1. Desired images are C0/P0. PostgreSQL sessions, OIDC=true, local mode=breakglass, environment=ok-shared, tenant=platform. |
| L2 | `kubectl -n openkubes-console get pods -o custom-columns='NAME:.metadata.name,IMAGE:.spec.containers[*].image,IMAGEID:.status.containerStatuses[*].imageID,READY:.status.containerStatuses[*].ready'` | Two Console Pods and one producer Pod Ready; application imageIDs report C0/P0 parent references. Candidate verification must additionally resolve controller UIDs and named-container status (R3). |
| L3 | `kubectl get ingress -A`; `kubectl -n ingress get service traefik -o wide` | ok-console is the only Ingress. Live origin is `https://console.ok-shared.internal` (443); Traefik exposes NodePort 30443 and a pending LoadBalancer. No private route is available; an approved browser origin/callback routing plan is a G0 prerequisite; prove canonical reachability at G1 before browser tests. |
| L4 | `kubectl -n openkubes-console get deployment ok-console --show-managed-fields -o json` | `OK_CONSOLE_DRY_RUN_URL` is owned by kubectl-set since 2026-09-10, targeting `http://ok147-console-dry-run.openkubes-system.svc.cluster.local:8790`; the Service exists. D6 conditionally adopts the existing URL only after documenting/verifying tracked configuration, without changing live config; removal and tenant-ID changes are outside this procedure and need a separate approved managedFields edit. |
| L5 | `kubectl -n openkubes-console get networkpolicy observed-state-producer -o yaml` | Only same-namespace ok-console Pods are admitted; Console is the consumer for this procedure. Keycloak is off-cluster (overlay host alias `deploy/kubernetes/overlays/ok-shared-live/kustomization.yaml:35`). No consumer-inventory gate. |
| L6 | `kubectl -n argocd get deployments,statefulsets`; `kubectl get applications.argoproj.io,applicationsets.argoproj.io -A` | Argo controllers are running, but there are no Applications or ApplicationSets. No Argo application targets this workload; controller absence is not an accurate baseline. |
| G1 | `skopeo --command-timeout 45s inspect --raw docker://<C0>`; `skopeo --command-timeout 45s inspect docker://<C0>` | Example index above contains linux/amd64 child above and linux/arm64 child `sha256:7f1f8def7a27cacd1422ede5be5784f93b6390ac44896937934031b7ea1ca613`. amd64 labels claim revision `182d8dfed618235138f212b0dfe3c9b6d5c80f2f`, source openkubes/ok-console, profiles bff/breakglass. Labels alone are not provenance. |
| G2 | `skopeo --command-timeout 45s inspect docker://<P0>` | Example producer's linux/amd64 labels claim source openkubes/openkubes, revision `ad351c9fe6ff9f2d14ccdd28c49e2f71e081c83d`. |
| G3 | GitHub compare API for R2/R7 merges versus example C0 revision | Example revision contains both merges (ahead of R2 by four commits, R7 by six); source membership does not establish provenance or resolve D3–D5. |

G0 must compare the **entire live env-name set** below against each reviewed Console artifact; expected references remain opaque. Table groups do not specify order and are not a rendering order: capture live order at G0 and preserve it in artifacts.
These are configuration variable names only; never capture their credential-bearing values, filenames or referenced object names.

| Group | Expected live names |
| --- | --- |
| Runtime / scope | `OK_CONSOLE_BFF_HOST`, `OK_CONSOLE_BFF_PORT`, `OK_CONSOLE_SESSION_STORE_MODE`, `OK_CONSOLE_ORIGIN`, `OK_CONSOLE_ENVIRONMENT_ID`, `OK_CONSOLE_DRY_RUN_URL`, `OK_CONSOLE_TENANT_ID`, `OK_CONSOLE_SESSION_EPOCH`, `OK_CONSOLE_AUTHORIZATION_REVISION` |
| Session dependencies | `OK_CONSOLE_POSTGRES_URL_FILE`, `OK_CONSOLE_POSTGRES_CA_FILE`, `OK_CONSOLE_SESSION_ENVELOPE_PRIMARY_KEY_ID`, `OK_CONSOLE_SESSION_ENVELOPE_KEYS_FILE` |
| OIDC | `OK_CONSOLE_OIDC_ENABLED`, `NODE_EXTRA_CA_CERTS`, `OK_CONSOLE_OIDC_PROVIDER_ID`, `OK_CONSOLE_OIDC_ISSUER`, `OK_CONSOLE_OIDC_CLIENT_ID`, `OK_CONSOLE_OIDC_CLIENT_SECRET_FILE`, `OK_CONSOLE_OIDC_SUBJECT_MAPPINGS_FILE` |
| Exceptional access | `OK_CONSOLE_LOCAL_ACCESS_MODE`, `OK_CONSOLE_LOCAL_ACCESS_ACCOUNTS_FILE`, `OK_CONSOLE_LOCAL_ACCESS_PEPPER_FILE` |
| Observed state | `OK_CONSOLE_OBSERVED_STATE_MODE`, `OK_CONSOLE_OBSERVED_STATE_URL`, `OK_CONSOLE_OBSERVED_STATE_CA_FILE`, `OK_CONSOLE_OBSERVED_STATE_CLIENT_CERT_FILE`, `OK_CONSOLE_OBSERVED_STATE_CLIENT_KEY_FILE`, `OK_CONSOLE_BFF_ENABLE_FAILURE_INJECTION` |

The overlay already includes BFF host/port, environment and tenant (`deploy/kubernetes/overlays/ok-shared-live/kustomization.yaml:41`–`:52`); it omits only the live dry-run URL from this set.
No live envFrom, timeout or stale override is expected. Effective source defaults are 5000 ms timeout and 300000 ms stale threshold (`bff/source.mjs:26-27`).
G0 must reconcile exact values of non-sensitive settings and all intentional name changes, including D6, before artifacts are approved. Compare ordered env lists and every changed field in server dry-run **output** against each artifact; a successful exit alone is insufficient.

G0/Q3 records the expected managers per object below; any other manager stops G0. On D10 Yes, after approved handoff, record the expected ownership delta and require `ok-170-acceptance` sole value ownership of every field changed later; co-owned env-entry keys are expected; controller/status ownership may remain.

| Object | Expected baseline field managers (operation) |
| --- | --- |
| Deployment ok-console | `ok-170-preview` (Apply), `ok-173-breakglass` (Apply), `ok-172-live` (Apply), `kubectl-set` (Update), `kubectl-rollout` (Update), `kube-controller-manager` (Update) |
| Deployment observed-state-producer | `ok-173-breakglass` (Apply), `ok-172-live` (Apply), `kube-controller-manager` (Update) |
| ConfigMap observed-state-producer-cluster-observations | G0 must establish and approve actual Apply/Update managers for data/metadata; unknown ownership blocks admission. Include in continuity and handoff/hand-back where changed. |
| Service observed-state-producer | `ok-173-breakglass` (Apply), `ok-172-live` (Apply) |
| Ingress ok-console | `ok-173-breakglass` (Apply), `ok-172-live` (Apply) |

`kubectl-set` owns both name/value fields for `OK_CONSOLE_DRY_RUN_URL` and `OK_CONSOLE_TENANT_ID`; `kubectl-rollout` owns restartedAt.
Service `.spec.selector` and Ingress `.spec.rules` are atomic fields co-owned by `ok-173-breakglass` and `ok-172-live`; a distinct manager's changed-value dry-runs conflict. Console/producer image changes conflict with `ok-172-live`; existing Console env-value changes also conflict, while adding the stale override admits cleanly. Image/env-value reconciliation was unnecessary under the old manager; env-entry key co-ownership is expected.
**D10 Yes — transfer path:** select `ok-170-acceptance` for the completed handoff; set `PROCEDURE_MANAGER` only at 0.3. Before that, G0 admits only named handoff artifacts under their explicit managers. Adopt unchanged named baseline fields non-forced, then existing Apply managers release only those fields via reviewed repo-rendered omission artifacts, retaining every other owned field. Include ok-172-live releases for image/env values, both owners for Service selector and, only if correction is approved, Ingress rules, and other Apply owners wherever Q3 shows selected value ownership. Release artifacts derive from the overlay that each manager last applied, never another manager's overlay or a live object capture. D10 approves preparation in principle only; the manager-contract exception and each ownership change still require separate execution approval. No force is permitted.
Adoption/release require dry-run output spec equal to live spec, generation unchanged (when present), and identical ordered env lists, preserving live relative order. Q3 must show each selected ownership addition/removal and **no newly owned fields after a release**. Dry-runs admit unchanged adoption; Service/Ingress omission releases retain specs and remove selected ownership. Deployment image release before persisted adoption fails required-image validation. These independent dry-runs do not establish a persisted sequential handoff: after every approved step, require the next clean non-forced dry-run. Until the complete handoff and gate pass, **all Phases 2–5 and Recovery E are blocked**, as are other dependent changes.
**Fallback only if D10 is explicitly revised to No:** set `PROCEDURE_MANAGER=ok-172-live`; omit the transfer and ownership hand-back, keep the writer freeze and continuity checks. Align the overlay to the actual healthy exit pair/profile/active identifiers before unfreeze or any verifier run, including on abort. Ordinary image/env-value changes and Recovery E may proceed only with complete-artifact non-forced admission and exact output comparison; **4.U and any Ingress correction remain blocked** by co-ownership. This path leaves an executable ordinary procedure but R4.U acceptance pending; never attempt these blocked commands under the fallback.
D6 conditionally adopts the unchanged dry-run URL only after documenting/verifying tracked configuration, without changing live config; SSA cannot remove kubectl-set's Update ownership of that env entry. Removing it or changing the tenant ID needs a separately approved managedFields edit outside this procedure.
The OK-172 owners must freeze **all other writers** from artifact hashing at execution approval through final handoff: promotions/verifier runs under ok-172-live, ok-173-breakglass, ok-170-preview and kubectl-set users. Any movement after hashing invalidates approval and requires revalidation/re-hashing; missing freeze blocks approval and G0. Record generation and resourceVersion for all four workload objects plus the observation ConfigMap before/after every step (generation where present); unexplained movement without a procedure apply is a global abort. Attribute controller/status updates explicitly; do not silently advance the ledger.
Outside D10’s named ownership steps, every change to the Console Deployment, producer Deployment/Service, observation ConfigMap or Ingress uses a reviewed, hashed repo-rendered manifest, server-side apply and `--field-manager="$PROCEDURE_MANAGER"`, selected once by D10.
Imperative edits would transfer field ownership and can conflict with later phases and Recovery E.
Before handoff completion, admit only the named handoff artifacts; 0.3 then admits all later artifacts and Recovery E. At every subsequent gate repeat their non-forced dry-runs. Require the full bidirectional live-to-output spec diff to equal exactly the approved path/value delta; unintended omissions/deletions/defaults block admission.
Ingress manifests derive from `deploy/kubernetes/overlays/ok-shared-live/ingress.yaml`, never a live YAML capture; no Ingress deletion.
Use an announced window on this shared development environment; host-only `__Host-` cookies require the canonical host for all session checks.
On D10 Yes, procedure 6.5 must hand final values back to ok-172-live: adoption of all fields owned by ok-170-acceptance at their actual exit values, then release **all** its ownership with the same spec/generation/order/ownership gates. Require no remaining ok-170-acceptance managedFields entry on every touched object. Apply this closing path on success, abort, Recovery E and partial handoff alike; partial handoff is reversed through adoption by ok-172-live before release. Update the main overlay to the actual healthy exit digests, active epoch, authorization revision and profile (C1/P1 on success; approved recovery pair on abort) before **any verifier run**. The current overlay pins the example digest and E0/A0 (`deploy/kubernetes/overlays/ok-shared-live/kustomization.yaml:18`, `:53-56`). Otherwise its forced apply (`deploy/kubernetes/verify-ok-shared-live.sh:65`) would reclaim ownership and restore the overlay’s old digest/E0, a retired epoch; a non-forced promotion would conflict. Keep all writers frozen until hand-back and overlay alignment are verified.
The [procedure](maintenance-procedure.md) owns the cross-namespace dry-run dependency and all other blast-radius details.

### Observation bundle compatibility and ordering

#127 removes the three supplied cluster revisions and the ok-mgmt profile from `deploy/kubernetes/overlays/ok-shared-live/producer-cluster-observations.yaml`. Treat that ConfigMap as a versioned artifact, B1, separate from P1's image; B0 is the reviewed repository-derived baseline restore. The producer release owner prepares both; the operator applies B1 no later than C1 BFF activation and verifies the producer has consumed its exact bytes before R5. File hashes, source revision, mount/reload behavior and expected omission set belong in the package. Never rewrite observation times to make the bundle fresh.

Q3-C extends Q3/continuity to ConfigMap `observed-state-producer-cluster-observations`: inspect managedFields, resourceVersion, generation where present and approved data-key/hash equality without retaining raw values. Approve its actual managers and each data/metadata ownership delta before admission; changed ConfigMap fields use the same D10 adoption/release and closing contract. The four-object Q3 projection remains workload-only; its green result alone cannot pass Q3-C. Stop on any unapproved bundle or ownership movement.

C0/P0 with B1 is **not assumed rollback-compatible**. Before approval, prove both directions in a disposable environment: C1/P1/B1 typed omission/freshness and CR/PR/B1 schema/readiness/route behavior, including absent revisions/profile; cover every transient Console/producer pairing in deployment, rollback and forward order. If C0/P0 fails, choose a distinct compatible archived CR/PR or block execution; never restore B0 while C1 can consume it. Hash B0 and its restore artifact for separately approved baseline restoration only after compatible old consumers and isolation are established. Every rollback/Recovery E binds a tested bundle hash; unsupported mixed pair/bundle blocks admission. Recovery E does not silently restore baseline data.

## R1 — OIDC lifecycle (AC4)

> AC4. OIDC login, PostgreSQL-backed session restoration and logout work through the deployed BFF.

**Objective:** real OIDC lifecycle and rejection of valid old sessions on C1/P1, including final recovery.
The deployment README still says “OIDC remains disabled” (`deploy/kubernetes/README.md:182`) and documents port 30443 (`:178`), while live OIDC is enabled and origin uses 443.
G0 approves the resolution with the IdP owner; G1 proves canonical origin/callback reachability before any browser flow.
BreakGlass keeps OIDC primary (`README.md:66-67 (repository root)`); bootstrap recovery on that labelled build requires D8.

**Inputs:** R3 source/provenance; canonical HTTPS origin and exact callback; owner-attested realm/client, confidential Code + PKCE S256, client_secret_basic and explicit issuer/subject mapping (`bff/security/oidc.mjs:32-34`, `:53-62`, `:95-103`).
Require mapped and unmapped dedicated identities, least-privilege scope, both-replica attribution, compatible PostgreSQL session/transaction/audit schema and retained key custody.
The procedure owns deployment and recovery preparation; an absent prerequisite blocks the corresponding phase.

**Replay rule:** retain old/revoked cookies only in memory. Send the same **fixed Cookie header on every probe**, record `cookieSent=true` without the value, and probe protected data routes **before** `/api/console/v0/auth/session`.
Do not use a cookie jar: session 401 clears cookies (`bff/security/httpSession.mjs:35-41`), which would turn subsequent probes anonymous.
Session lifetimes are exceptional access **5 min idle / 15 min absolute**, OIDC **15 min idle / 60 min absolute** (`bff/security/session.mjs:11-13`).
Every old-session probe must finish within idle and absolute expiry; record elapsed time since last valid activity and issuance, a valid-before control and converged replicas. A same-epoch rollout positive control must preserve a valid session; fresh login alone does not isolate epoch invalidation.

| Check after approved procedure step | Required observation / pass criterion |
| --- | --- |
| R1.1 Baseline epoch discriminator | Immediately before E1, prove a live E0 session returns protected overview 200 and auth-session 200. Prefer an OIDC baseline session (15 min idle), since the 5 min break-glass idle limit equals the initial 300 s rollout bound; AC4 still requires fresh OIDC on C1. After E1 convergence, the fixed old cookie yields protected 403 then session 401 across replicas. |
| R1.2 Fresh mapped/unmapped login | Fresh browser context, no IdP session: protected overview 403/session 401; OIDC start 302, callback 303; mapped OIDC public session 200 and producer data 200. Unmapped identity cannot authenticate. Never retain callback query or authorization code. |
| R1.3 PostgreSQL restore | Reload/navigate back without sign-in; the same authorized session restores on both replicas, protected views 200, no fixture/prototype fallback. Record safe replica attribution and store mode. |
| R1.4 Logout/replay | Preserve a second valid replay context in memory; both return 200 before logout. Wrong Origin/missing or wrong CSRF gives 403 without revocation. Valid logout 204; fixed revoked cookie gives protected 403 then session 401, UI requires sign-in. |
| R1.5 Same-pair epoch invalidation | Valid-before E1 session; reviewed E2/A1 transition leaves C1/P1 unchanged. After convergence, fixed old cookie is denied across both replicas; new OIDC login succeeds. |
| R1.6 Pending callback | Use an **isolated browser context per parked flow**. Start at old epoch and park at the Keycloak login form, with **no code issued**. After transition, complete the flow; record `transactionCookieSent=true` on the callback without its value. Require a **same-epoch parked-flow positive control** that completes successfully within TTL. Run fresh-login controls in separate contexts; never in the parked-flow profile before resumption. The old-epoch flow must return 401 **OIDC_TRANSACTION_INVALID**, start-to-callback **<300 s**, and no created session. TTL is 300 s (`bff/security/oidcTransactionStore.mjs:5`); exact denial is `bff/security/oidc.mjs:124`. Expiry or a generic OIDC error cannot pass. Flows crossing an image change prove rejection, not its epoch cause; only procedure 2.4 isolates epoch invalidation. |
| R1.7 Protocol dependency | Reconcile source-matched OK-173 real-library invalid issuer/audience/azp/nonce/PKCE, state and JWKS rotation evidence; execute missing cases in an approved isolated protocol environment with a working positive control. Mock exchange or infrastructure 503 is insufficient. |

**AC4 pass:** all rows on frozen C1/P1, including final R6 OIDC restore/logout/replay. Exceptional-access success cannot replace AC4.

## R3 — provenance, runtime identities and evidence (AC2, AC3, AC11)

> AC2. Console runs by the accepted immutable digest and the running Pod image ID matches it.
>
> AC3. The observed-state producer runs from a reviewed immutable revision/image.
>
> AC11. Evidence records exact source revisions, image digests, configuration profile, commands, results and limitations.

**Objective:** connect both reviewed sources to published images and every running application Pod; replace historical evidence with a pair-bound record.
The current verifier dry-run forces ownership (`deploy/kubernetes/verify-ok-shared-live.sh:52`), apply forces conflicts (`:65`), and image checks read Deployment spec only (`:73-76`).
Its apply path inspects Secret data and forwards ports (`:60-61`, `:87`); do not invoke it for this plan.
A separate read-only verifier and updated OK-170 evidence are prerequisite implementation work.

| Check | Required observation / pass criterion |
| --- | --- |
| R3.1 Source/build | Record both full source SHAs, originating successful publish runs/tags, profiles and digest subjects. Prove C1 source contains both R2/R7 merge commits and OIDC; observed-state sourceRevision is distinct from producer Git SHA. |
| R3.2 Provenance | Verify attestations with `gh attestation verify oci://<image@digest> --repo <owning-repository>` and signatures with `cosign verify`, exact trusted workflow/tag identity and issuer `https://token.actions.githubusercontent.com`; check installed help first. Record verified claims, SBOM/vulnerability result and tool versions. Labels alone do not pass. |
| R3.3 Verifier preparation | Implement/review distinct verify-only, admission and apply modes; verify-only reads no Secret values, mutates nothing, forwards no ports and reports OK-170. Run documented repository checks and invalid-input cases before use. |
| R3.4 Invalid-input coverage | Absent/null/wrong-type/duplicate/extra status; foreign ownership/repository; stale/mixed image; wrong replicas/generation; unrelated OCI child must fail. Observe each test fail when its guard is removed in an isolated copy, then pass after restoration; valid fixtures must also pass. |
| R3.5 Runtime | At every checkpoint resolve Pod→ReplicaSet→Deployment controller UIDs; select console/producer containers and every initContainer by name (including postgres-migrations), verify init spec/imageID against its separately pinned dependency and successful termination, require reconciled generations and expected replicas, no old/terminating Pods, each Ready named status and exact spec/imageID. Empty/ambiguous selections fail. |
| R3.6 OCI identity | Compare repository plus digest after recognized runtime-prefix normalization. Record parent index and platform child separately; prove reported child membership and node OS/architecture. Unrelated child/config hashes or suffix-only matching fail. |
| R3.7 Replacement evidence | One index binds C1/P1, exact sources/profile/render hashes, commands/results, AC mapping and limitations; retain earlier STOP/rc.3 observations as history. Hash reviewed sanitized artifacts and record final human disposition. |

**AC2/AC3/AC11 pass:** complete source/publication/runtime chain and final evidence index; repeat runtime proof after R6.

## R4 — fail-closed drills (AC8)

> AC8. Invalid identity, invalid trust, unavailable producer, stale and partial observations fail closed with safe UI behavior.

**Objective:** authenticated before/fault/recovered API and UI evidence on C1/P1, one fault at a time.
**D3/D4/D5 = NO: code fixes are required before candidate freeze.** The recorded baseline sets metadata.observedAt to request time; the BFF tests that timestamp, conflating response latency with observation age. The existing hand-written bundle is already stale (15+ hours in the recorded baseline) but was served Current: a demonstrated fail-open. No stale fault induction is needed for R4.S.

| Required code / candidate | Acceptance unlocked after merge, inclusion and source verification |
| --- | --- |
| Producer truthful observation times — [openkubes PR #452](https://github.com/openkubes/openkubes/pull/452), in P1 | P0 already preserves valid external timestamps. #452 timestamps Claim Evidence at list-read start and hosting/workload Evidence at supporting read starts; invalid external entries are newly omitted. Envelope time remains response assembly time. R5 must compare these independently. |
| Freshness D3/D5 — pending ok-console PR, in C1 | Required pending design criterion: stale primary bases yield effective readiness/lifecycle/capability/dependent placement Unknown; Overview counts them as unknown, never Ready. Preserve qualified historical Evidence and independently fresh siblings. Loaded pages expire without reload; fresh receipts/envelopes cannot refresh old observations. |
| Safe trust diagnostics — the pending ok-console trust-diagnostics PR (stacked on #127), in C1 | Final-candidate closed reason set and server class mapping below; UI displays no reason and does not distinguish trust from outage. |
| Typed output contract — [ok-console PR #127](https://github.com/openkubes/ok-console/pull/127) ([OK-209](https://kubernauts.atlassian.net/browse/OK-209)), in C1 | Typed allowlist and item-local invalid-Evidence omission; not freshness or diagnostics. Includes B1 bundle omissions. |

**Merge order:** #127 → trust diagnostics → freshness → this docs PR; openkubes #452 is independent. Freeze only after all candidate dependencies merge and review passes. These pending changes enable future checks, not acceptance evidence.

### D4 final-candidate diagnostic contract

Browser source failures retain HTTP 503 `SOURCE_UNAVAILABLE` with optional `error.reason` and response correlationId. Class exists only in the server failure JSON line keyed by that correlationId; it is never a response/UI field. The UI shows the existing safe unavailable/retry state, displays no reason, and does not distinguish trust from outage. Contract failure remains 502 `CONTRACT_INCOMPATIBLE` with server class `CONTRACT_INCOMPATIBLE` / reason `CONTRACT_VALIDATION`, outside the 503 reason set.

| Closed 503 error.reason | Server failure class | Observation scope |
| --- | --- | --- |
| CERTIFICATE_VERIFICATION | TRUST_REJECTED | Local peer certificate verification rejection |
| TRANSPORT_FAILURE, DEADLINE_EXCEEDED | SOURCE_UNREACHABLE | Closed refusal/resolver/routing/socket codes before headers, or private deadline before any response; may include a reachable but hung producer |
| TRANSPORT_AMBIGUOUS, BODY_DEADLINE_EXCEEDED | INCONCLUSIVE | Reset/pipe/premature close; post-header transport errors or body deadline, including socket timeout |
| PEER_TLS_ALERT, TLS_PROTOCOL_FAILURE | INCONCLUSIVE | Closed peer alerts or EPROTO; no inference of local verifier rejection |
| IDENTITY_REJECTED | INCONCLUSIVE | Parsed upstream/intermediary HTTP 401/403, not browser authentication failure or proof of TLS cause |
| HTTP_SERVER_ERROR, HTTP_NON_SUCCESS, UNCLASSIFIED | INCONCLUSIVE | Parsed 5xx, other non-success, or no recognized own error code |

After each fault request, the observer uses the response correlationId to select only its bounded source-failure JSON event from server stdout, then retains only `time`, `route`, `correlationId`, `class`, `reason`, `nodeCode`, `httpStatus`. Validate the closed enums and correlationId before retention; discard unrelated request logs without saving them. The approved capture build/command must implement this projection before sign-off; no raw log dump or broad log tail enters evidence. Missing/mismatched event or optional reason absent leaves that diagnostic assertion pending. Partial and invalid-identity cases remain mandatory.

### Pending D3/D5 freshness pass criterion

The pending design uses item age ≤300000 ms and maximum future skew 60000 ms, independently of envelope age; missing/invalid or >60000 ms future bases become unavailable/Unknown. Require authorized mixed fresh/stale observations, unchanged stale timestamps across new responses, suppression of current badges/details, unknown Overview counts, and browser expiry/resume without reload. Reconcile exact final profiles before hashing. v0alpha1 classification permits only Immutable/Current: never add Stale/Unknown there or relabel mutable stale Evidence Immutable. The pending freshness PR must define versioned qualified history or omit unrepresentable old Evidence with affected state Unknown; legacy routes must fail closed (planned 503 SOURCE_STALE / 502 CONTRACT_INCOMPATIBLE) where safe representation is impossible. Record its final omission/reclassification and field/meta rules in the package; unresolved profile behavior blocks approval.

| Check after approved induction in the procedure | Required observation / pass criterion |
| --- | --- |
| R4.U Unavailable | After approved selector isolation, producer Pod stays healthy but Service has no Ready backend. All four authenticated routes produce 503 `SOURCE_UNAVAILABLE` with `error.reason` TRANSPORT_FAILURE or DEADLINE_EXCEEDED and matching server class SOURCE_UNREACHABLE, safe retry/correlation and no fixtures or backend details. Any other reason/class is inconclusive for this outage assertion. 401/403 fails the authentication precondition. |
| R4.S Stale observation | **No fault induction:** use the existing already-stale hand-written bundle with unchanged timestamps/configuration. Compare consumed Q item times to the merged freshness policy and prove per-item stale verdicts in all applicable API/UI views, including mixed fresh/stale items. Old items must not appear Current or contribute fabricated healthy coverage; qualification/suppression must match the typed contract. Lowering a threshold proves latency only and is excluded. |
| R4.T Invalid trust | Separately approved hostname-validation control against the same named Service, producer Ready and verification enabled; precheck the Certificate and owner-attested served-leaf SANs against the approved alternate Service DNS name. Require 503 `SOURCE_UNAVAILABLE`, `error.reason=CERTIFICATE_VERIFICATION` and correlated server class TRUST_REJECTED, distinct from the R4.U reason/class. An INCONCLUSIVE server event cannot pass. Identity-rejected HTTP must be classified separately. Restore original DNS URL and 200 views within 180 s of restoration apply. Exact SAN-mismatch artifact must be reviewed before approval. |
| R4.P / identity | Reconcile source-matched partial/null/Unknown and invalid-identity cases; no fabricated readiness, zero coverage or unauthorized data. Repeat applicable authenticated UI/API cases on C1/P1, including 503 SOURCE_UNAVAILABLE / error.reason IDENTITY_REJECTED with server class INCONCLUSIVE for parsed upstream 401/403; missing cases keep acceptance pending. |
| R4.REC Recovery | Restore original URL/selector with unchanged pair and expected replicas. Two authenticated samples ≥5 s apart plus reload prove reachability and fault warnings cleared; genuine stale/partial warnings must remain. Advancing request timestamps cannot establish fresh observations. R4.S has no induced state to restore. |

**AC8 pass:** all required cases, distinct safe diagnostics, per-item age verdicts, UI/API and measured recovery on merged-code C1/P1. D3/D4 reject the former dev-gate limitations; no waiver remains.
Fault changes, dry-runs, timing and abort/recovery belong to the [procedure](maintenance-procedure.md).

## R5 — authenticated real-state views (AC6)

> AC6. Overview, Clusters, Cluster Detail and Evidence are rendered from real observed state.

**Objective:** four authenticated assertions against each request's consumed Q and matching UI.
**D5 = NO:** truthful producer observation times (openkubes PR #452), per-item BFF stale verdicts and safe trust diagnostics (pending ok-console PRs), and the typed allowlist/item-local omission (ok-console PR #127 / OK-209) must merge and be included in the frozen P1/C1 as specified in R4. The recorded hand-written bundle for ok-mgmt, ok-ai and ok-infra is already stale; it must be identified as operator-supplied and stale rather than passed off as current live observation. No stale induction is required.
Once included, AC6's four-view provenance, per-item timestamp/freshness and typed diagnostic comparisons become provable, including mixed fresh hosting-cluster and stale supplied entries. These checks still require consumed-Q correlation and approved API/browser observations. Use hosting-cluster-sourced ok-shared for detail/Evidence and inspect stale supplied items separately. Every adapter read fetches anew; authorization filtering precedes projection.

**Inputs:** working R1 session, R3 pair proof, approved sanitized correlation/replica capture of consumed Q; capture design belongs to the procedure.
No capture mechanism is established by this plan. If instrumentation changes an image, publish/freeze the new pair before starting acceptance.
Use same-origin browser GETs with credentials same-origin and cache no-store; freeze the final freshness Presentation profile and routes. The v0alpha1 routes below are baseline references, subject to the pending fail-closed/profile rules in R4.
Use `/api/console/v0/auth/session` for authentication assurance; discover and URL-encode authorized hosting cluster `c.id` and its `c.evidenceId` from Clusters.

| Route / view | Required comparison with scoped Q(request) and UI |
| --- | --- |
| `GET /api/console/v0/overview` / Overview | 200 PlatformOverview; totals match scoped Q after effective freshness suppression; stale clusters count unknown, not Ready; unsupported metrics remain null/Unknown. metadata times follow the final freshness profile without replacing item observation times; sourceRevision matches Q metadata; rendered totals/time agree. Identify operator-supplied entries explicitly. |
| `GET /api/console/v0/clusters` / Clusters | 200 ClusterList; exact scoped IDs and allowlisted fields match Q after freshness/omission policy; B1 intentionally withholds three supplied revisions and ok-mgmt profile, so require their absence, never substitute values. Stale readiness and dependent state are Unknown. Metadata times follow the final freshness profile; sourceRevision matches Q. UI rows agree; retain timestamp in authenticated API evidence. Assert each supplied item’s actual timestamp and stale verdict under the merged typed contract; fresh request metadata cannot certify its age. |
| `GET /api/console/v0/clusters/{id}` / Cluster Detail | 200 ClusterDetail for hosting-cluster-sourced ok-shared; allowlisted identity/revision/provider/version/evidenceId match Q; effective readiness/capabilities/lifecycle match freshness suppression and UI, including Unknown and B1 omissions. metadata times follow the final freshness profile without replacing item observation times; sourceRevision matches Q metadata; Evidence time follows its own request. |
| `GET /api/console/v0/evidence/{id}` / Evidence | 200 EvidenceReference for fresh hosting cluster; separately assert omitted invalid external cluster/Evidence IDs are absent (or the configured Unknown management boundary) after #452, with no dangling graph references. For BFF-isolated malformed Evidence, require 404 and affected state Unknown; id/clusterId/outcome/revision/contract/source/classification match the scoped, redacted item. data.observedAt=meta.observedAt=Q evidence item time; sourceRevision remains Q metadata. redacted=true; safe summary and UI drawer agree, timezone recorded. |

R5 also compares Claim Evidence to its actual list-read start and hosting/workload Evidence to supporting read starts; valid external times remain unchanged across requests. Compare envelope assembly time independently, never as an item freshness basis. Use source-matched repository/disposable proof for invalid-entry omission and read timing; production bundle timestamps remain unchanged.

Baseline route and item-time contracts: `bff/app.mjs:130-157`; reconcile exact typed field paths/time equalities with merged freshness PR and #127 before hashing, preserving actual source-item age. Missing request correlation or timestamp equality leaves R5 pending.
**AC6 pass:** all four expected/actual comparisons, correlation proof and redacted UI evidence; partial/redaction warnings and unknowns preserved.
D5 rejects freshness fail-open; supplied inputs remain operator-supplied after correct age classification.

## R6 — rollback, recovery and cleanup (AC10)

> AC10. Rollback and task-scoped cleanup are demonstrated.

**Objective:** rollback/forward and recovery on the R1 pair, with retired-session rejection and bounded cleanup evidence.
Both recovery overlays pin rc.3 (`deploy/kubernetes/overlays/ok-shared-breakglass/kustomization.yaml:10`, `deploy/kubernetes/overlays/ok-shared-bootstrap-recovery/kustomization.yaml:10`); renderer independently checks rc.3 (`deploy/kubernetes/render-ok-shared-recovery.mjs:44`).
Update these pins, renderer, verifier, tests and documentation together in separate reviewed work before G0.
The procedure owns all transitions, blast radius, abort and Recovery E; use its announced window, with the Ingress retained throughout.

| Checkpoint | Required observation / pass criterion |
| --- | --- |
| R6.1 Prepared artifacts | Recovery modes pin C1/P1; no rc.3, mutable/missing digest or placeholder. Unique identifier ledger; invalid pair/reused identifier/output cases demonstrably fail before live use. Schema/key and mixed producer compatibility demonstrated in a disposable environment. |
| R6.2 Inventory | Metadata/UID/owner baseline for discovered namespaced kinds, excluding secrets, events, leases and endpointslices. List Secrets only with default table output (metadata). Record exact retained cluster-scoped dependencies. List/RBAC errors block reconciliation; no consumer-inventory gate. |
| R6.3 Rollback/forward | C1/P1→CR/PR→identical C1/P1 at E3/A2 then E4/A3. Runtime identities, health and authenticated real views at each checkpoint; fixed prior-session cookies rejected; pending callbacks give OIDC_TRANSACTION_INVALID within <300 s. |
| R6.4 Recovery profiles | Only under D8’s separately approved bounded exercise: C1/P1 at E5/A4 bootstrap, then E6/A5 OIDC-primary BreakGlass. Exceptional login/audit works; old OIDC/bootstrap sessions and pending flows denied by R1 rules. Final new OIDC login, both-replica restore, logout/replay and R5 views pass. |
| R6.5 Count/expiry evidence | DB-owner **count-only by rendered retired epoch** and expiry evidence for sessions/transactions. Resolve aliases through the ledger; require recorded lower bounds for retained sessions/unconsumed flows, so a wrong identifier yielding zero cannot pass when rows are expected. No locks or SQL DELETE in this procedure. Rejection, expiry and physical deletion are distinct facts; retain active/unrelated data and audit. D7 permits retained rows if isolation and evidence suffice; document the measured isolation/expiry scope. |
| R6.6 Final retained set | Reconcile exact approved artifact/object delta, including an empty delta, with retained DB/PVC/certificates/RBAC and dependencies healthy. No namespace/DB/PVC/Ingress deletion. Final C1/P1/profile, route/TLS/health and authenticated R1/R5 pass; unauthenticated access denied. |

**AC10 pass:** demonstrated transitions and agreed task-scoped cleanup scope, with measured results and no unexplained residue.
Under D7, physical deletion is not required if isolation and evidence are sufficient; missing isolation/expiry evidence keeps AC10 pending.

## Full AC mapping and execution order

| AC | Acceptance home / requirement |
| --- | --- |
| AC1 | G0 records ok-shared dev ownership, boundaries, approved people/window (D9). |
| AC2 / AC3 / AC11 | R3 immutable source/publication/runtime/evidence chain, repeated after R6. |
| AC4 | R1 real OIDC lifecycle and final R6 restoration; never waived. |
| AC5 | R3 reviewed mTLS profile and R4 trust case; expected identity/trust proof retained, gaps explicit. |
| AC6 | R5 four authenticated views, hosting-cluster source and operator-supplied entries distinguished. |
| AC7 | C1 R2 source membership plus reviewed redaction/Presentation Contract checks and sanitized live browser evidence. |
| AC8 | R4 unavailable/stale/trust/partial plus R1 identity negatives; D3–D5 required fixes must be in P1/C1; no stale/trust/freshness waiver. |
| AC9 | C1 R7 membership and source-matched disabled-mutation/UI checks; no Shell fabricated readiness. |
| AC10 | R6, with D7 physical-deletion scope explicit. |
| AC12 | Repository README verification checks on candidate source; record CI/repository results and required PostgreSQL/browser prerequisites. |
| AC13 | Suchit's explicit GO / REVISE / STOP disposition after review of the complete record. |

Order: decisions and reviewed procedure → publish/freeze source-complete pair → recovery/verifier/capture preparation → G0 → R3 runtime → R1 → R5 baseline → individual R4 faults/recoveries → R6 → final R3/R1/R5 → complete evidence and disposition.
Every phase gate, including procedure **2.4**, repeats gate admission checks: dry-run the next artifacts and Recovery E without force and compare output fields/ordered env lists to artifacts; missing input, conflict or mismatch blocks that phase.

## Evidence and redaction

| Planned record | Required contents |
| --- | --- |
| `README.md`, `commands.md`, `SHA256SUMS` | Pair/source/profile/window, verbatim AC mapping, exact sanitized commands/results/versions/UTC, limitations and disposition; hash reviewed artifacts excluding the checksum file itself. |
| `source-images.json`, `runtime-images.json` | Verified publication/provenance/signatures, OCI parent/child/platform, source membership, controller/Pod identities, checkpoint/final comparisons and manifest hashes. |
| `oidc-lifecycle.json`, `authenticated-views.json` | Pseudonymous scope, status/code/correlation, cookieSent/transactionCookieSent booleans, valid-before/rejected-after, elapsed idle/absolute ages, same-epoch session/parked-flow controls and <300 s callback timing, replica attribution, consumed-Q expected/actual fields and redacted screenshots. |
| `fail-closed-drills.json`, `rollback-cleanup.json` | Before/fault/recovered UI/API/timing, discriminator or explicit product gap, identifier ledger, inventory delta/retained set, retired-epoch counts/expiry and final health/auth. |

Allowlist safe projections before persistence. Never record Secret values/hashes, tokens, cookies/CSRF, codes/callback queries, state/nonce/PKCE, credential names/values, session/transaction digests/envelopes, raw summaries, headers, HAR, browser traces or storage-state exports.
Replay state stays only in isolated memory. Record boolean security-attribute/cookie-sent checks; review screenshots for identity leakage.
**Scope of this evidence:** Applies to the eventual frozen pair and approved profiles/window; Shown in recorded checks; Follow-ups retain unresolved product and execution gates. This document supplies planning inputs and acceptance requirements.

## Decisions for Arash

Recorded from Arash's OK-170 comment 15171: planning/implementation only, not live execution. D3/D5 share a source-age fix with separate AC8/AC6 assertions. Exact artifacts, provenance, callback/IdP attestations, capture, named roster and dated window still require separate explicit execution approval. Arash owns macOS-only verification.

| ID | Recorded decision | Planning consequence |
| --- | --- | --- |
| D1 | YES (prepare one immutable C1/P1 candidate with fixes and OIDC; freeze artifacts only after code review) | Include all required merges before the single candidate freeze and prepare compatible rollback artifacts. |
| D2 | YES (retain canonical origin) | Retain `https://console.ok-shared.internal` and matching callback. |
| D3 | NO (do not accept stale fail-open) | Truthful producer times and per-item BFF verdicts are required; R4.S uses the already-stale bundle. |
| D4 | NO (do not accept missing safe diagnostic differentiation between upstream TLS/trust failure and outage) | Require safe typed trust/outage/identity diagnostics before C1 freeze. |
| D5 | NO (do not accept freshness fail-open) | Require actual item-age handling for AC6; supplied entries remain labelled as such. |
| D6 | conditionally adopt existing OK_CONSOLE_DRY_RUN_URL only after documenting/verifying the tracked configuration, without changing live config | Preserve the existing dependency; no unconditional adoption or live edit is authorized. |
| D7 | physical deletion not required if isolation and evidence are sufficient | Count/expiry/isolation proof may satisfy task cleanup; retain data/audit. |
| D8 | breakglass-labelled bootstrap rehearsal only as a separately approved, bounded exercise | Step 5.3 needs its own explicit bounded approval; D1 does not authorize it. |
| D9 | YES to a future announced shared-dev maintenance window after the event, still requiring explicit sign-off | In principle, not executed; proposed window below requires approval. |
| D10 | YES in principle to a documented, controlled ownership-handoff plan; do not execute it now | In principle, not executed; prepare adopt/release and all-exit hand-back; sequential proof and separate execution approval remain mandatory. |

## Risk assessment

Likelihood is a planning estimate before mitigation; residual risk remains subject to the named owner's review. No phase has been executed under this plan.

| Phase / risk | Likelihood | Impact | Detection | Mitigation | Residual |
| --- | --- | --- | --- | --- | --- |
| Pre-window / demo-event disruption | High if changed during event | Demo unavailable or changed behavior | Freeze/approval review; any attempted access/change | No ok-shared access; no change before or during 2026-10-24; wait for Arash to lift freeze and approve a later window | Event end alone grants no authority |
| All phases / concurrent writers | Medium | Hashed artifacts drift; recovery conflicts | Per-step generation/resourceVersion and ownership ledger | OK-172 owners freeze every other writer from artifact hashing through verified closing handoff; movement invalidates hashes/approval | Controller updates require attribution; unexplained movement aborts |
| Phase 0 / ownership handoff | Medium | Lost ownership or conflicting restore | Q3 spec/generation/order equality and ownership deltas after each step | Adopt then release sequentially, non-forced; approved managers; reverse partial handoff and close via 6.5 | Separate execution approval; freeze retained until repaired |
| Phases 1–2 / OIDC cutover and routing | Medium | Users locked out; callback/session failure | Canonical TLS/callback, same-epoch controls, timed old-context denial, mapped/unmapped login | Retain origin; IdP owner present; isolated test identities; <300 s parked flows; pre-admitted Recovery E | IdP/browser dependency; macOS verification by Arash |
| Phases 2, 5–6 / data and sessions | High for planned reauthentication; low for data damage | Global session invalidation; retained rows/audit; incompatible rollback | Epoch ledger, DB compatibility, count/expiry and fixed-header probes | Unique epochs; retain schema/keys/PVC/audit; no deletion/downgrade; normal logout; DB owner budget | Reauthentication expected; count-only proof differs from deletion |
| Phase 3 / stale or partial data represented healthy | High on baseline | Misleading views/acceptance | Correlate Q item times, typed verdicts, UI coverage | Required producer/BFF/OK-209 merges in P1/C1; already-stale bundle; preserve Unknown/partial | Operator-supplied entries remain supplied; no current-live claim |
| Phase 4 / outage and trust controls | Medium | Views unavailable; ambiguous diagnosis | Healthy before/fault/recovered four-view results and reason codes | One bounded control at a time; named-Service DNS/SAN precheck; safe codes; immediate paired restore | Shared users affected during approved holds; inconclusive cannot pass |
| Phases 0–6 / CA and SPIFFE exposure ([OK-210](https://kubernauts.atlassian.net/browse/OK-210)) | Medium | Internal CA/identity details exposed in diagnostics or evidence | Allowlist review of typed errors, API/UI and sanitized captures | No raw certificates, CA bundles, SPIFFE identities or backend details in package/UI; security owner reviews OK-210 exposure before approval | OK-210 needs separate disposition; fail-closed behavior alone does not close it |
| Phase 5 / rollback and bootstrap | Medium | Incompatible pair; loss of OIDC; old sessions accepted | Distinct CR/PR provenance, schema/key checks, runtime IDs, old-context and final OIDC tests | Pre-hashed compatible rollback/recovery overlays; unused epochs; D8 separate bounded approval; identical C1/P1 forward | Rollback cannot restore retired epochs or erase retained data |
| Phase 6 / closing handoff | Medium | Later promotion restores retired epoch or wrong digest | Final owner/overlay equality, non-forced admission and continuity | Align actual healthy exit overlay before any verifier; adopt then release all acceptance-owned fields; retain writer freeze on failure | Approval remains blocked if ownership/health cannot be restored |
| Phases 5 / Recovery E / CR/PR fail-open | High if CR/PR=C0/P0 | D3/D4/D5 protections may be absent; stale-as-Current and generic diagnostics return | Compare CR/PR source and consumed item ages before/after recovery; observer flags unqualified Current | Compatibility is not D3/D4/D5 acceptance. Suspend reliance on current-state views and announce degraded scope immediately; use only an explicitly approved bounded recovery interval, never leave fail-open as the permanent exit | Before sign-off, name owner and maximum duration bounded by the remaining window; if freshness-aware C1/P1 cannot resume, require separately reviewed access restriction/withdrawal artifacts and follow-up. Missing bound/artifact blocks execution |
| Producer #452 / invalid external input | Medium | Previously substituted entries disappear; inventory/count changes | R5 invalid-entry omission, configured Unknown boundary and graph/reference comparisons | Record expected omitted IDs/counts without raw invalid values; preserve fresh siblings; no fabricated observation time | Omission is not discovery or deletion; show partial/Unknown coverage |
| Scheduling / dependency or sign-off slip | Medium | Proposed date missed; approval or artifacts stale | Review completion, hashes and roster at sign-off and G0 | Move to a later proposed window; re-announce, revalidate/re-hash and obtain fresh explicit sign-off; no compression of controls or reserve | No implied execution authority from a proposed date |

## Artifact and digest package

Template only. Every candidate source revision, immutable digest and artifact checksum below is **to be filled after C1/P1 are built from merged code**. Historical C0/P0 examples are not candidate values. Hash only reviewed sanitized bytes, record each artifact identity/source revision/tool version/hash in the package index and `SHA256SUMS` (excluding itself); verifier recomputes independently. OCI digests and file checksums are distinct.

| Artifact | Source revision / value | SHA-256 production and record | Verifier |
| --- | --- | --- | --- |
| C1 Console digest, index/platform manifests and provenance | to be filled after C1/P1 are built from merged code | Publisher's immutable OCI digest; SHA-256 of exact raw index/child manifest bytes must match references; record source SHA, publish run, attestations and parent/child chain in source-images.json | Console release owner + independent reviewer |
| P1 producer digest, platform manifests and provenance | to be filled after C1/P1 are built from merged code | Same OCI-byte/digest verification; record source SHA including #452, publication and compatibility in source-images.json | Producer release owner + independent reviewer |
| B1 observation ConfigMap and B0 restore, bundle compatibility matrix | to be filled after C1/P1 are built from merged code | Source path `deploy/kubernetes/overlays/ok-shared-live/producer-cluster-observations.yaml`; sha256sum exact reviewed renders and safe bundle bytes; record B1 omissions, apply-before-BFF order, CR/PR bundle binding and B0 restore constraints | Producer release owner prepares; operator + independent reviewer verify Q3-C/compatibility |
| Browser/runtime profiles and verifier/capture builds | to be filled after C1/P1 are built from merged code | Record source SHAs/build versions, immutable image references where applicable and sha256sum reviewed profile/capture/verifier artifacts; require bounded correlation-log projection | Console owner + independent reviewer |
| Identifier ledger and OK-173 isolated protocol sheet | to be filled after C1/P1 are built from merged code | sha256sum reviewed unique epoch/auth ledger, isolated commands, positive/negative controls and timing sheet; no credential identities/values | IdP/DB/recovery owners + observer |
| Roster, approval and schedule sheet including distinct D8 decision | to be filled after C1/P1 are built from merged code | sha256sum named roles, coverage, announcement, proposed allocations and approval record; record D8 granted/withheld and resulting pending scope | Arash + OK-172 owner + observer |
| Phase 0 adopt/release and Phase 1 routing/same-epoch rendered overlays, paired restores | to be filled after C1/P1 are built from merged code | `sha256sum` exact reviewed rendered bytes per object/manager; record render source and hashes in package index/SHA256SUMS | OK-172 ownership owner + operator + observer |
| Phase 2 pair/epoch, Phase 3 capture (if needed), Phase 4 U/T controls/restores | to be filled after C1/P1 are built from merged code | `sha256sum` each rendered artifact; record source and hash; R4.S uses unchanged stale bundle, hash sanitized non-sensitive observation input, no S_FAULT | Console/producer owners + independent observer |
| Phase 5 rollback/forward/bootstrap/post-recovery and Phase 6 hand-back/exit overlays | to be filled after C1/P1 are built from merged code | `sha256sum` every rendered transition and restore; record identifier ledger binding and hashes | Recovery owner + DB/IdP owners + OK-172 owner |
| Recovery overlays / Recovery E for every gate and replenishment | to be filled after C1/P1 are built from merged code | `sha256sum` distinct compatible recovery artifacts; bind unused epochs, source and admitted checkpoint in package index | Recovery owner + independent observer |
| Dry-run outputs per phase, paired restoration, handoff/hand-back and Recovery E | to be filled after C1/P1 are built from merged code | After freeze lifted and separate access approval, record sanitized structural comparisons; `sha256sum` allowlisted outputs and record source/artifact/checkpoint/tool/hash; repeat at each gate | Operator produces; independent observer verifies complete diffs and hash |

Artifact hashing starts the other-writer freeze. Changes to bytes, source, pair or ledger invalidate approval and require review/re-hashing. D6 tracked-configuration verification and OK-210 exposure review must precede sign-off; record reviewer dispositions with the index. No live dry-run output is supplied by this template.

## Proposed maintenance window

Earliest eligibility is after the event on 2026-10-24, **only after Arash explicitly lifts the freeze and separately signs off** the hashed package, roster, recovery plan and dated window. D9/D10 are in principle, not executed. No change is permitted before or during the event.

| Item | Proposal / approval requirement |
| --- | --- |
| Proposed date range | **Proposed 2026-10-28 through proposed 2026-10-30**; start only after explicit sign-off and freeze release, required merges/builds/review. If not ready, propose a later date and obtain fresh sign-off. |
| Proposed time and duration | **Proposed 09:00–13:30 UTC**, proposed 270 minutes on the selected proposed date; no automatic extension. Sign-off must precede the start; a late signature requires rescheduling/re-approval. |
| Budget derivation | Initial producer/Console = 180+300 s = 8 min. Phase 5 alone needs ≥6×180 s = 18 min rollout budget + ≤10 min R1 lifecycle at 5.4 + fresh sessions/parked flows/admission; allocate proposed 45 min. R1 lifecycle also needs ≤10 min at 2.2–2.3 and again 6.3. Up to six same-epoch controls require rollout+marker restore ≤6 min each = 36 min, separate from lifecycles/transition rollouts. U = 3.5 min; T = 7 min, excluding repeat admission/capture. |
| Proposed allocation | G0/G1/ownership/admission 40 min; Phases 2–3 55 min (8 initial + 3 epoch + 10 R1 + 20 provenance/four-view capture + 14 admission/session/flow margin); Phase 4 30 min (3.5 U + 7 T + 10 R4.S + 9.5 admission/capture margin); Phase 5 45 min (18 rollout + 10 R1 + 17 admission/new sessions/parked flows); Phase 6/closing 30 min (10 R1 + 10 final checks/≥300 s last-flow expiry + 10 closing/count margin); same-epoch controls 40 min (36 controls/restores + 4 margin); protected recovery reserve 30 min. Total proposed 270 min. |
| Reserve reconciliation | Reserve mapping (20/10/20/10 min planning allowances): same-epoch expanded to 40 min standalone; R4.S 10 within Phase 4; provenance/capture 20 within Phases 2–3; final checks/flow expiry 10 within Phase 6. Six control checkpoints cover 2.1, 2.4 and 5.1–5.4. No reserve is double-counted. Object-count, protocol-sheet, DB expiry/query and closing bounds must fit before sign-off; otherwise expand/re-propose the window. |
| Required roster | Arash (freeze release/execution sign-off); named change operator; independent observer/timekeeper; recovery owner with API access; Console and producer release owners; OK-172 ownership/writer-freeze owner; IdP owner; DB owner; security/OK-210 reviewer; Suchit for final disposition. One person may cover compatible roles; operator and observer remain distinct. |
| Writer freeze and announcement | OK-172 owner freezes other writers from artifact hashing through verified 6.5 closure; announce chosen proposed date/time, affected shared-dev Console, expected reauthentication/intermittent views, roster, abort/recovery route and status channel before sign-off. No release on partial handoff; closing announcement only after verified healthy exit. |
| Distinct D8 approval | Record grant/withholding separately from D9/D10 and general package sign-off. If withheld, skip 5.3; re-render/re-hash the direct forward-to-final-OIDC transition and ledger, obtain approval, and keep bootstrap/R6.4 acceptance pending. No substitute image/profile or implied waiver. |
| Final execution gate | Explicit sign-off must name exact package hashes, approved date/start/end, roster, bounded D8 exercise and ownership steps. Stop new tests before reserve is consumed; approval/window expiry requires restoration/closing, never continuation by assumption. |
