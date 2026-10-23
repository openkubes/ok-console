# OK-170 acceptance plan: one immutable Console/producer pair

> **This document is not an execution approval.** Merging it authorizes no change on ok-shared. Every live step needs a separate, explicit approval of the hashed artifact package and a dated window. An event freeze is in force for the Sovereign Cloud Days demonstration on 2026-10-24 (OK-170 comment 15171): no deployment, promotion, rollout, server-side apply, ownership handoff, configuration, credential, certificate, RBAC or producer change, fault injection, negative live test, maintenance exercise or rollback before or during it, and the end of the event does not grant execution authority.

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
| C1 | Proposed candidate: a newly published immutable build whose source contains R2 merge `eb6e7513e073a149fcbcde8a9eb486ba142cdc86`, R7 merge `ddb73d99377dbb46d1d41ca1886fac9ef69879df` with OIDC, plus any code a No answer in D3–D5 requires; freeze once after that code merges. Full digest and publication proof required before execution approval; labels or source membership alone cannot qualify C0 as C1. |
| P1 | Producer for C1; P1 = P0 unless D3/D5 require producer changes; source/provenance and compatibility must pass. Record its full immutable reference even when unchanged. |
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

Read-only planning baseline: 2026-10-22; cluster `ok-shared`, context `ok-shared-admin@ok-shared`, application namespace `openkubes-console`.
Obtain and verify **kubectl v1.34.1 before G0**, matching the observed server **v1.34.1**; an unavailable pinned client blocks G0.
Repository references below are relative to ok-console main `a4f6237d73f45c8971d8e9106d47abf90d496e49` (contains R2/R7); producer references identify the example baseline producer's labelled revision `openkubes@ad351c9`.
Cluster JSON reads must project allowlisted fields before recording; no complete object dumps or Secret data.

| ID | Read-only source / command | Planning fact or G0 requirement |
| --- | --- | --- |
| L0 | `kubectl version -o json` | Server v1.34.1. G0 records the pinned client and server versions. |
| L1 | `kubectl -n openkubes-console get deployment ok-console observed-state-producer -o json` | Example at 12:12 UTC: Console generation/observedGeneration 43, 2/2 Ready/updated/available; producer 10, 1/1. Desired images are C0/P0. PostgreSQL sessions, OIDC=true, local mode=breakglass, environment=ok-shared, tenant=platform. |
| L2 | `kubectl -n openkubes-console get pods -o custom-columns='NAME:.metadata.name,IMAGE:.spec.containers[*].image,IMAGEID:.status.containerStatuses[*].imageID,READY:.status.containerStatuses[*].ready'` | Two Console Pods and one producer Pod Ready; application imageIDs report C0/P0 parent references. Candidate verification must additionally resolve controller UIDs and named-container status (R3). |
| L3 | `kubectl get ingress -A`; `kubectl -n ingress get service traefik -o wide` | ok-console is the only Ingress. Live origin is `https://console.ok-shared.internal` (443); Traefik exposes NodePort 30443 and a pending LoadBalancer. No private route is available; an approved browser origin/callback routing plan is a G0 prerequisite; prove canonical reachability at G1 before browser tests. |
| L4 | `kubectl -n openkubes-console get deployment ok-console --show-managed-fields -o json` | `OK_CONSOLE_DRY_RUN_URL` is owned by kubectl-set since 2026-09-10, targeting `http://ok147-console-dry-run.openkubes-system.svc.cluster.local:8790`; the Service exists. D6 adopts this drift; removal and tenant-ID changes are outside this procedure and need a separate approved managedFields edit. |
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
| Service observed-state-producer | `ok-173-breakglass` (Apply), `ok-172-live` (Apply) |
| Ingress ok-console | `ok-173-breakglass` (Apply), `ok-172-live` (Apply) |

`kubectl-set` owns both name/value fields for `OK_CONSOLE_DRY_RUN_URL` and `OK_CONSOLE_TENANT_ID`; `kubectl-rollout` owns restartedAt.
Service `.spec.selector` and Ingress `.spec.rules` are atomic fields co-owned by `ok-173-breakglass` and `ok-172-live`; a distinct manager's changed-value dry-runs conflict. Console/producer image changes conflict with `ok-172-live`; existing Console env-value changes also conflict, while adding the stale override admits cleanly. Image/env-value reconciliation was unnecessary under the old manager; env-entry key co-ownership is expected.
**D10 Yes — transfer path:** select `ok-170-acceptance` for the completed handoff; set `PROCEDURE_MANAGER` only at 0.3. Before that, G0 admits only named handoff artifacts under their explicit managers. Adopt unchanged named baseline fields non-forced, then existing Apply managers release only those fields via reviewed repo-rendered omission artifacts, retaining every other owned field. Include ok-172-live releases for image/env values, both owners for Service selector and, only if correction is approved, Ingress rules, and other Apply owners wherever Q3 shows selected value ownership. Release artifacts derive from the overlay that each manager last applied, never another manager's overlay or a live object capture. Yes grants this manager-contract exception; no force is permitted.
Adoption/release require dry-run output spec equal to live spec, generation unchanged (when present), and identical ordered env lists, preserving live relative order. Q3 must show each selected ownership addition/removal and **no newly owned fields after a release**. Dry-runs admit unchanged adoption; Service/Ingress omission releases retain specs and remove selected ownership. Deployment image release before persisted adoption fails required-image validation. These independent dry-runs do not establish a persisted sequential handoff: after every approved step, require the next clean non-forced dry-run. Until the complete handoff and gate pass, **all Phases 2–5 and Recovery E are blocked**, as are other dependent changes.
**D10 No — fallback path:** set `PROCEDURE_MANAGER=ok-172-live`; omit the transfer and ownership hand-back, keep the writer freeze and continuity checks. Align the overlay to the actual healthy exit pair/profile/active identifiers before unfreeze or any verifier run, including on abort. Ordinary image/env-value changes and Recovery E may proceed only with complete-artifact non-forced admission and exact output comparison; **4.U and any Ingress correction remain blocked** by co-ownership. This path leaves an executable ordinary procedure but R4.U acceptance pending; never attempt these blocked commands under the fallback.
D6 adopts the unchanged dry-run URL; SSA cannot remove kubectl-set's Update ownership of that env entry. Removing it or changing the tenant ID needs a separately approved managedFields edit outside this procedure.
The OK-172 owners must freeze **all other writers** from artifact hashing at execution approval through final handoff: promotions/verifier runs under ok-172-live, ok-173-breakglass, ok-170-preview and kubectl-set users. Any movement after hashing invalidates approval and requires revalidation/re-hashing; missing freeze blocks approval and G0. Record generation and resourceVersion for all four objects before/after every step; unexplained movement without a procedure apply is a global abort. Attribute controller/status updates explicitly; do not silently advance the ledger.
Outside D10’s named ownership steps, every change to the Console Deployment, producer Deployment/Service or Ingress uses a reviewed, hashed repo-rendered manifest, server-side apply and `--field-manager="$PROCEDURE_MANAGER"`, selected once by D10.
Imperative edits would transfer field ownership and can conflict with later phases and Recovery E.
Before handoff completion, admit only the named handoff artifacts; 0.3 then admits all later artifacts and Recovery E. At every subsequent gate repeat their non-forced dry-runs. Require the full bidirectional live-to-output spec diff to equal exactly the approved path/value delta; unintended omissions/deletions/defaults block admission.
Ingress manifests derive from `deploy/kubernetes/overlays/ok-shared-live/ingress.yaml`, never a live YAML capture; no Ingress deletion.
Use an announced window on this shared development environment; host-only `__Host-` cookies require the canonical host for all session checks.
On D10 Yes, procedure 6.5 must hand final values back to ok-172-live: adoption of all fields owned by ok-170-acceptance at their actual exit values, then release **all** its ownership with the same spec/generation/order/ownership gates. Require no remaining ok-170-acceptance managedFields entry on every touched object. Apply this closing path on success, abort, Recovery E and partial handoff alike; partial handoff is reversed through adoption by ok-172-live before release. Update the main overlay to the actual healthy exit digests, active epoch, authorization revision and profile (C1/P1 on success; approved recovery pair on abort) before **any verifier run**. The current overlay pins the example digest and E0/A0 (`deploy/kubernetes/overlays/ok-shared-live/kustomization.yaml:18`, `:53-56`). Otherwise its forced apply (`deploy/kubernetes/verify-ok-shared-live.sh:65`) would reclaim ownership and restore the overlay’s old digest/E0, a retired epoch; a non-forced promotion would conflict. Keep all writers frozen until hand-back and overlay alignment are verified.
The [procedure](maintenance-procedure.md) owns the cross-namespace dry-run dependency and all other blast-radius details.

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
**Freshness reality:** producer metadata.observedAt is set to now() on every request and the BFF stale check uses only that, so "stale" today means response latency, not observation age.
Producer source: `openkubes@ad351c9 platform/console/observed-state-producer/app.py:525` (now), `openkubes@ad351c9 platform/console/observed-state-producer/app.py:583` (metadata), `openkubes@ad351c9 platform/console/observed-state-producer/app.py:823-833` (hosting snapshot); BFF strict `>`: `bff/adapters/openKubesObservedState.mjs:311`, `SOURCE_STALE`: `:330`.
The BFF maps upstream/TLS failures to one 503 SOURCE_UNAVAILABLE and logs no cause (`bff/app.mjs:264-269`); 502 at `:259-260` is contract incompatibility.
Hand-written observations are **15+ h old yet classified Current by P0 and served as Current by the BFF: a demonstrated fail-open**, not merely missing proof. Thus AC8 “stale observation” fails on current code; the R4 invalid-trust discriminator also needs code. D3/D4 explicitly decide the dev-gate limitations; neither silently completes AC8.
Overview's stale banner is `src/App.tsx:100`; stale data remains qualified/readable. Partial and invalid-identity cases remain part of the full AC8 evidence mapping.

| Check after approved induction in the procedure | Required observation / pass criterion |
| --- | --- |
| R4.U Unavailable | No Ready producer Service backend, producer Pod healthy. Fresh authenticated requests to all four R5 routes yield bounded 503 SOURCE_UNAVAILABLE, retryable, retryAfterSeconds 15 and correlation ID; reload UI shows safe unavailable/retry, no fallback or upstream detail. 401/403 fails the auth precondition. |
| R4.S Stale observation | Require a source observation-age discriminator in revised code included before the single C1/P1 freeze unless D3 explicitly accepts the dev limitation. Lowering the threshold to 1 ms proves latency classification only, never stale observations. Record API metadata and actual UI behavior; qualified data is not suppression. |
| R4.T Invalid trust | Require safe TLS rejection classification from revised code for full proof. No-new-image differential control: same Service, producer Ready, only hostname changes, verification enabled; first perform the read-only **4.T IP-SAN check**: producer Certificate spec `dnsNames` are DNS names with no `ipAddresses` (`kubectl -n openkubes-console get certificates -o json`, allowlisted spec projection), and confirm the served leaf also lacks that IP SAN. Baseline 200→fault 503→restored 200 within the **180 s rollout bound** from restoration apply, including rollout. This supports the documented limitation under D4 and does not supply a TLS cause discriminator. |
| R4.P / identity | Reconcile source-matched partial/null/Unknown and invalid-identity cases; no fabricated readiness, zero coverage or unauthorized data. Repeat applicable authenticated UI/API cases on C1/P1; record any missing cases explicitly. |
| R4.REC Recovery | Restore original URL/selector/default threshold, unchanged C1/P1 and expected replicas. Two authenticated samples ≥5 s apart plus reload show restored views and fault-specific warnings cleared; preserve genuine partial/other warnings. Advancing timestamps alone cannot prove source age. |

**AC8 pass:** complete required cases, discriminators, UI/API and measured recovery. Accepted dev-gate limitations remain explicit AC8 scope gaps.
All fault changes, dry-runs, timing and abort/recovery belong to the [procedure](maintenance-procedure.md).

## R5 — authenticated real-state views (AC6)

> AC6. Overview, Clusters, Cluster Detail and Evidence are rendered from real observed state.

**Objective:** four authenticated assertions against each request's consumed Q and matching UI.
**Freshness reality:** producer metadata.observedAt is set to now() on every request and the BFF stale check uses only that, so "stale" today means response latency, not observation age.
Three clusters (ok-mgmt, ok-ai, ok-infra) come from the hand-written ConfigMap `deploy/kubernetes/overlays/ok-shared-live/producer-cluster-observations.yaml:14`, `:24`, `:34` and report Current.
The live ConfigMap matches this input; external evidence is classified Current by `openkubes@ad351c9 platform/console/observed-state-producer/app.py:714-716`.
These observations are **15+ h old yet classified Current by P0 and served as Current by the BFF: a demonstrated fail-open**. R5 “producer-sourced, current” cannot be proven for those entries on current code. Use the **hosting-cluster-sourced ok-shared cluster** for detail/Evidence assertions; D5 decides the remaining freshness limitation.
Every adapter read fetches anew (`bff/adapters/openKubesObservedState.mjs:353-374`); authorization filtering precedes projection (`bff/app.mjs:238`).

**Inputs:** working R1 session, R3 pair proof, approved sanitized correlation/replica capture of consumed Q; capture design belongs to the procedure.
No capture mechanism is established by this plan. If instrumentation changes an image, publish/freeze the new pair before starting acceptance.
Use same-origin browser GETs with credentials same-origin, cache no-store and Presentation Contract profile `console.openkubes.io/v0alpha1`.
Use `/api/console/v0/auth/session` for authentication assurance; discover and URL-encode authorized hosting cluster `c.id` and its `c.evidenceId` from Clusters.

| Route / view | Required comparison with scoped Q(request) and UI |
| --- | --- |
| `GET /api/console/v0/overview` / Overview | 200 PlatformOverview; cluster/readiness totals and scoped metric sums match Q, preserving null/Unknown coverage. meta.observedAt/sourceRevision match Q metadata; rendered totals/time agree. Identify operator-supplied entries explicitly. |
| `GET /api/console/v0/clusters` / Clusters | 200 ClusterList; exact scoped IDs, names/provider/profile/version/readiness/revision/evidenceId and capability counts match Q. meta.observedAt/sourceRevision match Q. UI rows agree; retain timestamp in authenticated API evidence. Current metadata cannot certify ConfigMap entry age. |
| `GET /api/console/v0/clusters/{id}` / Cluster Detail | 200 ClusterDetail for hosting-cluster-sourced ok-shared; allowed identity/readiness/revision/provider/version/evidenceId/capabilities/lifecycle match Q and UI. meta.observedAt/sourceRevision match Q metadata; Evidence time follows its own request. |
| `GET /api/console/v0/evidence/{id}` / Evidence | 200 EvidenceReference for hosting cluster; id/clusterId/outcome/revision/contract/source/classification match the scoped, redacted item. data.observedAt=meta.observedAt=Q evidence item time; sourceRevision remains Q metadata. redacted=true; safe summary and UI drawer agree, timezone recorded. |

Route and item-time contracts: `bff/app.mjs:130-157`. Missing request correlation or timestamp equality leaves R5 pending.
**AC6 pass:** all four expected/actual comparisons, correlation proof and redacted UI evidence; partial/redaction warnings and unknowns preserved.
D5 acceptance of the current dev limitation does not establish observation-age freshness or turn hand-written entries into real observations.

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
| R6.4 Recovery profiles | C1/P1 at E5/A4 bootstrap, then E6/A5 OIDC-primary BreakGlass. Exceptional login/audit works; old OIDC/bootstrap sessions and pending flows denied by R1 rules. Final new OIDC login, both-replica restore, logout/replay and R5 views pass. |
| R6.5 Count/expiry evidence | DB-owner **count-only by rendered retired epoch** and expiry evidence for sessions/transactions. Resolve aliases through the ledger; require recorded lower bounds for retained sessions/unconsumed flows, so a wrong identifier yielding zero cannot pass when rows are expected. No locks or SQL DELETE in this procedure. Rejection, expiry and physical deletion are distinct facts; retain active/unrelated data and audit. D7 settles whether physical deletion needs a separate reviewed step. |
| R6.6 Final retained set | Reconcile exact approved artifact/object delta, including an empty delta, with retained DB/PVC/certificates/RBAC and dependencies healthy. No namespace/DB/PVC/Ingress deletion. Final C1/P1/profile, route/TLS/health and authenticated R1/R5 pass; unauthenticated access denied. |

**AC10 pass:** demonstrated transitions and agreed task-scoped cleanup scope, with measured results and no unexplained residue.
If D7 requires physical deletion, count/expiry evidence alone leaves AC10 pending until a separate reviewed step is demonstrated.

## Full AC mapping and execution order

| AC | Acceptance home / requirement |
| --- | --- |
| AC1 | G0 records ok-shared dev ownership, boundaries, approved people/window (D9). |
| AC2 / AC3 / AC11 | R3 immutable source/publication/runtime/evidence chain, repeated after R6. |
| AC4 | R1 real OIDC lifecycle and final R6 restoration; never waived. |
| AC5 | R3 reviewed mTLS profile and R4 trust case; expected identity/trust proof retained, gaps explicit. |
| AC6 | R5 four authenticated views, hosting-cluster source and operator-supplied entries distinguished. |
| AC7 | C1 R2 source membership plus reviewed redaction/Presentation Contract checks and sanitized live browser evidence. |
| AC8 | R4 unavailable/stale/trust/partial plus R1 identity negatives; D3–D5 limitations remain visible. |
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

Each decision is one yes/no answerable now; D6 records the required adoption scope. D3 and D5 address the same observation-age fail-open; one reviewed source-age/freshness fix can cover both, with separate AC8/AC6 assertions. Defaults are proposals; unresolved rows block their affected phase.
Exact digests/provenance, callback/IdP attestations, operator/observer and IdP/DB-owner roster, capture design, budgets and dated window require **later separate execution approval** of the complete hashed artifact package, with the writer freeze starting when those artifacts are hashed. No decision below authorizes execution. Arash owns macOS verification because this environment has no macOS access.

| Group | ID / decision | Proposed default | Answer consequences |
| --- | --- | --- | --- |
| Pair & provenance | D1 — Build C1/P1 from main containing `eb6e751` and `ddb73d9` with OIDC plus all code required by No in D3–D5, frozen once after that code merges? | Yes. | Yes: P1 = P0 unless producer changes are required; prepare the pair and compatible CR/PR rollback for R3 proof. No: propose another source-complete approach; acceptance waits. |
| Identity provider/origin | D2 — Retain canonical origin `https://console.ok-shared.internal` (443)? | Yes. | Yes: prepare browser routing and matching callback registration for later approval. No: propose another HTTPS origin and registration; R1 waits. |
| Product gap: AC8 stale | D3 — Accept the demonstrated fail-open (15+ h old observations served Current) and response-latency-only stale classification for this dev gate? | No. | Yes: explicitly accept that fail-open and retain the AC8 stale gap; show latency classification only. No: require observation-age handling and producer changes as needed, included before the single C1/P1 freeze; acceptance waits. |
| Product gap: R4 trust | D4 — Accept the missing TLS-cause discriminator with the hostname-only differential control for this dev gate? | No. | Yes: retain the gap and require 200→503→200 within the 180 s rollout bound. No: require safe classification code included before the single C1/P1 freeze; acceptance waits. |
| Product gap: R5 freshness | D5 — Accept the demonstrated fail-open (15+ h old hand-written observations served Current), using hosting-cluster detail/Evidence for this dev gate? | No. | Yes: explicitly accept that fail-open and retain operator-supplied/freshness gaps. No: require source-age/freshness code and producer changes as needed, included before the single C1/P1 freeze; acceptance waits. |
| Drift | D6 — Adopt unchanged OK_CONSOLE_DRY_RUN_URL (fixed scope). | Adopt the same verified value with clean admission output. | Retain the openkubes-system Service dependency. Removal or tenant-ID changes need a separately approved managedFields edit outside this procedure; there is no removal path here. SSA omission does not remove the Update-owned entry. |
| Data | D7 — Does AC10 require physical deletion of retired task rows? | No. | Yes: AC10 waits for a separate reviewed deletion step. No: use count-by-retired-epoch and expiry evidence; preserve rows/audit. |
| Recovery profile | D8 — Accept bootstrap runtime mode on the breakglass-labelled C1 build for procedure step 5.3? | Yes. | Yes: prepare that exact E5/A4 profile. No: resolve the profile contract before the single pair freeze; acceptance waits. |
| People & window | D9 — Use an announced shared-dev maintenance window? | Yes. | Yes: prepare the procedure and complete roster/window for later execution approval. No: no executable route-isolation alternative exists; revise the approach. |
| Ownership reconciliation | D10 — Approve preparation of the adopt-then-release handoff to ok-170-acceptance, including the existing-manager exception? | Yes, subject to sequential ownership/admission proof. | Yes: prepare sequential adoption/releases and closing hand-back of all acceptance-owned fields to ok-172-live on every exit; all Phases 2–5 and Recovery E wait for handoff proof. Align the main overlay to final digests/epoch/profile before any verifier run; otherwise its force apply reclaims fields and restores retired E0. No: use ok-172-live with writer freeze and continuity checks; 4.U and Ingress correction remain blocked, ordinary phases/Recovery E require clean admission. Both paths align the actual healthy exit overlay before unfreeze or any verifier run, including aborts; freeze all writers from approval hashing through final handoff; later execution approval is mandatory. |
