# OK-170 maintenance procedure — separate review required

> **Prepared for candidate C1 / C1-R / P1 (same-epoch upgrade).** Revised after the founder decision in OK-170 comment 15421: bounded preparation only, no live execution. It must be re-reviewed against the current candidate, its published digests and the disposable rehearsal evidence before any use. Anything that changes after that review needs a new review.

> **This document is not an execution approval.** Merging it authorizes no change on ok-shared. Image publication, tagging, signing, ok-shared live reads or changes, deployment, PKI or Keycloak changes, live fault drills and production rollout each need a separate, explicit approval. Every live step needs approval of the hashed G0 package and a dated UTC window.

Planning only. The [acceptance plan](acceptance-plan.md) owns the AC mapping, the deferred-risk register and the Decisions table. This procedure owns the candidate pair, the identifier ledger, the exact change inventory, change steps, blast radius, budgets, abort and recovery. AC4 remains required. All steps below are proposed future actions.

Approved sequence (OK-170 comment 15421): (a) prerequisite PRs reviewed; (b) build preflight, then a separate request to run the protected publication workflows; (c) pin the published digests and rehearse C0→C1, same-epoch session continuity, rollback/recovery and fail-closed withdrawal on a disposable cluster; (d) deliver the hashed G0 package, owners and window for a separate GO/NO-GO.

## Authority and inputs

| Input | Required contract |
|---|---|
| Approval | Arash decides GO/NO-GO at every gate and approves the frozen pair, the hashed G0 package and the window. No implicit window extension. |
| Window and owners | Deferred (decision 6). After the PRs, digests/provenance, hashed manifests and rehearsal evidence are ready, propose: a UTC window of at most 2 h; operator, recovery owner, DB owner, Keycloak owner (one mapped and one unmapped test identity) and an independent observer who reviews the AC4/AC10 evidence. Names: (set at G0). |
| Announcement | Announced maintenance on shared dev Console; no private route exists. Keep the Ingress present. All Console users may lose views or need to sign in again. Operator and observer keep Kubernetes API access for recovery. |
| Writer freeze | OK-172 owners freeze all other writers from artifact hashing through final handoff: ok-172-live promotions/verifier runs, ok-173-breakglass, ok-170-preview and kubectl-set users. Missing freeze blocks G0; any movement after hashing requires revalidation and re-hashing. |
| Pair | C1/C1-R/P1 below. Only the immutable signed digests and attestations from the protected workflows fix the release identity. No manual push, no source substitution; any rebuild is a new candidate. |
| Rollback | Decision 3(b): C0/P0 is used only while the Console is withdrawn fail-closed, so stale data is never served as Current. C0/P0 is not an authorized serving state. Return to verified C1/P1 on GO; otherwise remain withdrawn until an explicitly approved safe recovery. Proven on a disposable cluster first. |
| Identifiers | Same-epoch upgrade: C1 keeps E0/A0. Every later transition takes an unused value from the [identifier ledger](#identifier-ledger). |
| Identity/origin | Owner-attested mapped/unmapped test identities, exact HTTPS callback, PKCE, trusted issuer and working emergency access. Approve the browser origin/callback at G0; prove reachability at G1 before browser tests. No edits to the shared Keycloak realm, signing keys or client configuration. |
| Recovery readiness | The bootstrap recovery overlay pins C1-R; the breakglass (post-recovery) overlay pins C1. `deploy/kubernetes/overlays/expected-digests.json` holds, per recovery overlay, the index digest and platform-child digests; `deploy/kubernetes/render-ok-shared-recovery.mjs` fails unless each overlay's pin and rendered image equal that file. Both entries stay at the rc.3 digest until the pin PR updates overlays and file together. |
| Budgets | Proposed: initial Console rollout ≤300 s; other Deployments ≤180 s each; browser lifecycle ≤10 min; withdrawal convergence ≤30 s; individual source request ≤10 s. Pending-flow rejection must finish <300 s from flow start, including rollout. Approve an adequate total window. |

### Candidate pair

| Role | Image | Source | Profile / tag | Digest |
|---|---|---|---|---|
| C1 Console | `ghcr.io/openkubes/ok-console` | ok-console main `9cb963e2c87c8eccc51a11dce302c92e45658dc4` | breakglass, `dev-breakglass-v0.1.0-rc.30` | Unpublished (set at publication) |
| C1-R Console recovery | same repository | same source `9cb963e` | bootstrap, `dev-v0.1.0-rc.20`; bootstrap recovery overlay only | Unpublished (set at publication) |
| P1 producer | `ghcr.io/openkubes/observed-state-producer` | openkubes `96027be` | `console-observer-dev-v0.1.0-rc.21` | Unpublished (set at publication) |
| C0 / P0 | Live pair | Recorded at G0 | Recorded at G0 | Full index and platform-child digests recorded at G0 |

Publication is conditional (decision 1): it is requested separately after the PRs and build preflight. C1-R exists because the bootstrap recovery overlay sets `OK_CONSOLE_LOCAL_ACCESS_MODE=bootstrap` with OIDC off, and a breakglass browser build rejects a Bootstrap session. P1 carries openkubes #452 (truthful observation times); the live producer revision `ad351c9` predates it. C1-R and C1 have different digests, so every digest file keeps one entry per overlay.

### Identifier ledger

E = `OK_CONSOLE_SESSION_EPOCH`, A = `OK_CONSOLE_AUTHORIZATION_REVISION`. The tracked live overlay and the 2026-10-22 live read both show E0/A0.

| Row | Used by | Epoch | Authorization revision | State |
|---|---|---|---|---|
| E0/A0 baseline | C0, retained by the C1 upgrade | `ok-shared-phase-b1-1` | `ok-shared-bootstrap-v1` | Active; reconfirmed at G0 |
| Transition | Reserved for a C0→C1 transition that the approved package requires to invalidate sessions; the same-epoch plan does not consume it | (set at G0) | (set at G0) | Unused |
| Rollback | C1→C0 under withdrawal (3.1) | (set at G0) | (set at G0) | Unused |
| Forward | C0→C1 (3.2) | (set at G0) | (set at G0) | Unused |
| Emergency | Recovery E | (set at G0) | (set at G0) | Unused |
| Retry | Each retried transition or later emergency, one value each | (set at G0) | (set at G0) | Unused |
| Recovery bootstrap / post-recovery | Bootstrap recovery overlay (C1-R) and breakglass overlay (C1) | Generated fresh by `render-ok-shared-recovery.mjs`; recorded when the render is hashed | Generated fresh by the renderer | Unused |

Rules: values are allocated, rendered and hashed in the G0 package. Never reuse a retired value, including E0 once a transition has retired it. Epoch-only rotation keeps the authorization revision. A ledger change after hashing requires re-hashing and re-review.

### Exact change inventory

Namespace `openkubes-console`, overlay `overlays/ok-shared-live`. These deltas become the approved package's `deltas.json`. Any other path in the non-forced dry-run output, or a missing expected path, stops.

| Object | Approved change |
|---|---|
| Deployment `ok-console` | Image C0 → C1 (pinned index digest). Env `OK_CONSOLE_DRY_RUN_URL` tracked in the overlay with its unchanged live value (D6). The live variable was added by `kubectl set env`, so the dry-run may show a position change: only the windowed dry-run decides, and an unapproved reorder stops. |
| Deployment `observed-state-producer` | Image P0 → P1 (pinned index digest). |
| ConfigMap `observed-state-producer-cluster-observations` | Field deltas from the approved G0 read only. The proposal's render expected removal of `ok-mgmt.profile` and three `revision` fields; live content is unverified, so repository content is not assumed to equal live. (set at G0) |
| Unchanged | Migrations ConfigMap (the live init container runs only `006_*`; `005_local_identity.sql` is not in this overlay, so C1's compatibility with the live schema is shown in rehearsal), Service, Ingress, NetworkPolicies, RBAC, certificates. |
| Secrets | None created, modified, rotated or read by value; the render contains no Secret. Consumed as they exist: `ok-console-session`, `ok-console-local-access`, `ok-console-db-app`, `ok-console-db-ca`, `ok-console-oidc`, `ok-console-oidc-ca` and the cert-manager TLS secrets. |
| Not touched | PKI and the ClusterIssuer, the shared Keycloak realm, keys and clients, the producer source contract, other namespaces. |

Withdrawal, rollback, forward and emergency artifacts each carry their own reviewed delta in the G0 package.

## Baseline facts (read-only inspection, 2026-10-22)

G0 compares these with the approved artifacts; drift stops execution.

| Fact | Verified value / source |
|---|---|
| C0/P0 definition | The live pair recorded at G0, with full digests, source revision labels, generations and resourceVersions; never a fixed historical digest. |
| Example at 2026-10-22 12:12 UTC | Console OCI index `ghcr.io/openkubes/ok-console@sha256:e70b44690adb4a035d3c0f01e01ee366a5bfe55f8ff60861b26ad1ab9a48ddee`, linux/amd64 child `sha256:04f3c727a0e2c32bfdedb56c6eb03243615f5ffce45d330533919c4f18c57ee6`; revision label `182d8dfed618235138f212b0dfe3c9b6d5c80f2f`, bff/breakglass. Producer `ghcr.io/openkubes/observed-state-producer@sha256:6ee7ce8f26a436cf03f56dd5e9ff065c0e121183320cd68e1acaab7916646012`, revision label `ad351c9fe6ff9f2d14ccdd28c49e2f71e081c83d`. Labels alone are not provenance. |
| Tracked vs live | The tracked live overlay pins Console `sha256:65b5f394…`, not the live example above. The tracked overlay may differ from live; the G0 read decides. |
| Runtime example | Console generation/observedGeneration 43/43, 2 updated/Ready/available; producer 10/10, 1 updated/Ready/available. postgres-migrations is separately digest-pinned and completed. E0/A0 as in the ledger; PostgreSQL store, OIDC=true, breakglass; no envFrom on either app. |
| Origin/route | Live origin `https://console.ok-shared.internal` (443), issuer `https://keycloak.ok-shared.internal/realms/openkubes`, provider `keycloak-openkubes`, client `ok-console`. Only Ingress is `openkubes-console/ok-console`; Traefik HTTPS is a NodePort, LoadBalancer address pending. G0 approves the canonical origin and exact callback; no port substitution during testing. |
| Producer/dependencies | Selector `app.kubernetes.io/name=observed-state-producer`; Service is ClusterIP; source mode hosting-cluster. NetworkPolicy `observed-state-producer` admits only Console Pods. Keycloak is off-cluster (overlay host alias). Argo controller present, no Applications/ApplicationSets; no Argo field manager on either app. |
| Field managers | Deployment ok-console: ok-170-preview, ok-173-breakglass, ok-172-live (Apply); kubectl-set, kubectl-rollout, kube-controller-manager (Update). Deployment producer: ok-173-breakglass, ok-172-live (Apply); kube-controller-manager (Update). Service producer and Ingress: ok-173-breakglass, ok-172-live (Apply). |
| Live drift | `OK_CONSOLE_DRY_RUN_URL=http://ok147-console-dry-run.openkubes-system.svc.cluster.local:8790`, owner `kubectl-set` (2026-09-10); that Service exists. The overlay now tracks the same value (D6). SSA cannot remove kubectl-set Update ownership; removal or tenant-ID changes need a separately approved edit outside this procedure. Preserve tenant `platform`. |
| Source defaults | `bff/source.mjs:26-27`: timeout 5000 ms, stale threshold 300000 ms; no live override. Confirm against frozen C1. |

## Planning gaps and their disposition

| Gap | Disposition |
|---|---|
| Stale observation shown as Current (D3, D5) | C1 source contains #140 and #143 (per-item freshness verdict, UI labels); P1 carries truthful observation times. C0/P0 still shows stale data as Current (acceptance plan R1), hence decision 3(b). |
| Invalid-trust discriminator (D4) | C1 source contains #139: trust failures are classified `TRUST_REJECTED` (`bff/adapters/sourceFailure.mjs:33`). |
| Bootstrap on a breakglass build | Resolved by the separate C1-R bootstrap image for recovery only. |
| AC10 physical deletion | Count-only evidence by retired epoch, expiry and normal logout; no DB locks or deletes. Physical deletion, if required, is a separate reviewed step. |

## Reviewed artifacts and change mechanism

Every change is a non-forced server-side apply of a reviewed, SHA-256-bound per-object artifact rendered from the repository: `k apply --server-side --field-manager="$PROCEDURE_MANAGER" -f "$ARTIFACT"`. No imperative edits, Ingress deletion, database locks or deletes, and no full overlay apply. Apply only the objects with a non-empty approved delta; the exact file set is fixed in the G0 package.

**Field manager (D10, decision 5):** `PROCEDURE_MANAGER=ok-172-live`, only if the non-forced server-side dry-run and the managedFields ownership inventory show it applies the exact reviewed artifacts without conflict or unapproved ownership adoption. Otherwise STOP and report. Never use `--force-conflicts`, never adopt or release ownership, and never switch silently to `ok-170-acceptance`; that path needs a new explicit decision and its own reviewed procedure. This holds for every artifact below, including withdrawal and Recovery E. The 2026-10-22 baseline shows the producer Service selector co-owned by ok-173-breakglass, so a selector change under ok-172-live may conflict; the G0 dry-run decides, and a conflict means STOP.

| Artifact variable | Exact approved contents |
|---|---|
| `P1_MANIFEST`, `P0_MANIFEST` | Producer Deployment only; P1 or the recorded P0 image, unchanged configuration. Skip an apply only if already identical. |
| `C1_UPGRADE` | Console Deployment and the cluster-observations ConfigMap per the change inventory; C1 at E0/A0. |
| `WITHDRAW`, `WITHDRAW_RESTORE` | Fail-closed withdrawal as in the acceptance plan: the producer route is withdrawn and the Console serves its bounded 503. Producer Service only: zero-match selector `openkubes.io/ok170-fault=unavailable` / original selector, preserving Service identity and ports. The 2026-10-22 baseline shows `.spec.selector` co-owned by `ok-173-breakglass` and `ok-172-live`, so a non-forced `ok-172-live` apply of `WITHDRAW` may conflict. G0 must show `WITHDRAW` and `WITHDRAW_RESTORE` admitting cleanly; on a conflict, STOP and report (decision 5). Rollback (b) is then unavailable until a separately approved ownership change. |
| `C0_ROLLBACK`, `C1_FORWARD` | Console Deployment only; C0 at the ledger's rollback row, then C1 at the forward row. |
| `EMERGENCY_P_MANIFEST`, `EMERGENCY_C_MANIFEST` | P1 / C1 at the emergency row (later emergencies use retry rows); retain keys, schema, data and audit. C0/P0 only while withdrawn. |
| `SAME_EPOCH_CONTROL`, `SAME_EPOCH_RESTORE` | Console Deployment only; current pair, epoch, authorization revision and profile, changing only the Pod-template annotation `openkubes.io/ok170-rollout-control`. Preserve kubectl-rollout-owned `kubectl.kubernetes.io/restartedAt`. |
| Recovery renders | Output of `render-ok-shared-recovery.mjs` (bootstrap with C1-R, post-recovery breakglass with C1), checked against `overlays/expected-digests.json`. |

**Read-only verification:** use `deploy/kubernetes/verify-ok-shared-readonly.sh <approved-package-dir> <new-output-dir>`. It is fixed to context `ok-shared-admin@ok-shared`, never applies and never forces. It renders and lints the overlay (`OK170_OVERLAY` selects a reviewed transition overlay), runs a non-forced server-side dry-run of each admitted object and requires its delta to equal `deltas.json`, checks the managedFields inventory against `allowlist.json` (exactly the admitted objects), checks non-admitted objects for drift, runs the `runtime-identity` mode of `ok170-gates.mjs` against `expected-images.json`, and writes `SHA256SUMS`. Each checkpoint gets its own approved package. Raw live objects stay in a private scratch directory that the verifier removes on exit; its output holds only rendered repository content and value-free gate results, so it may enter evidence after review. Do not use `deploy/kubernetes/verify-ok-shared-live.sh` for this procedure: it applies the whole overlay with `--force-conflicts`.

## Phase 0 — read-only pre-flight; G0

Obtain and verify kubectl **v1.34.1 before G0**, matching the observed server **v1.34.1**; absence blocks G0. All `k` commands assume approved cluster access and this wrapper:

```bash
k() { kubectl --context ok-shared-admin@ok-shared -n openkubes-console "$@"; }
kubectl version -o json
kubectl config current-context
```

Stop on every unexpected command failure. No Secret values, value hashes, credential filenames or unfiltered logs enter evidence.

| ID | Read-only command / inspection | Required observation |
|---|---|---|
| Q1 | `k get deployment ok-console observed-state-producer -o custom-columns='NAME:.metadata.name,GEN:.metadata.generation,OBS:.status.observedGeneration,DESIRED:.spec.replicas,UPDATED:.status.updatedReplicas,READY:.status.readyReplicas,AVAILABLE:.status.availableReplicas,IMAGE:.spec.template.spec.containers[*].image'` | Expected pair; observedGeneration equals generation; Console 2/2, producer 1/1. |
| Q2 | `runtime-identity` through the verifier; at G0 against the C0/P0 digests recorded in the same read, after 1.2 against C1/P1 | Every running app Pod is owned by the current-revision ReplicaSet, Ready, and its imageID equals the approved platform-child digest; the Deployment is reread to catch a rollout between reads. No old, foreign or terminating app Pods. Init containers, including postgres-migrations, keep their separate pinned image. |
| Q3 | Verifier dry-run, ownership inventory and drift check; Service and Ingress included | Delta equals the change inventory exactly; managers equal the allowlist; full env-name set below, no envFrom, mounts/security/strategy/initContainers preserved. Any other manager or path stops G0. |
| Q4 | `k get service observed-state-producer -o jsonpath='{.spec.selector}{"\n"}{.spec.clusterIP}{"\n"}'`; `k get endpointslices -l kubernetes.io/service-name=observed-state-producer -o json`; `k get pods -l openkubes.io/ok170-fault=unavailable -o name` | Approved selector/IP, one ready producer backend; the withdrawal selector matches zero Pods. Endpointslices are inspected for routing only. |
| Q5 | `kubectl --context ok-shared-admin@ok-shared get ingress -A`; `kubectl --context ok-shared-admin@ok-shared -n ingress get service traefik -o jsonpath='{.spec.ports}{"\n"}{.status.loadBalancer}{"\n"}'` | Only the expected Console Ingress; route stays available throughout the window. |
| Q6 | `k get certificates,cluster.postgresql.cnpg.io,pvc`; `k get resourcequota,limitrange,pdb,networkpolicy`; `kubectl --context ok-shared-admin@ok-shared get applications,applicationsets -A` | Dependencies healthy, surge capacity, reviewed policies, no unexpected reconciliation. Owner attests served leaf identities without reading TLS Secret data. |
| Q7 | Inventory loop below; `kubectl --context ok-shared-admin@ok-shared get clusterrole,clusterrolebinding ok-shared-observed-state-producer -o json` | Retained namespace metadata plus exact producer RBAC; no list errors or unexpected deltas. |
| Q8 | For each SA `ok-console` and `observed-state-producer`: `k auth can-i get secrets --as="system:serviceaccount:openkubes-console:$SA"`; repeat for `get pods`, `create deployments.apps`, `patch deployments.apps`, `delete pods` | All no. `get nodes` and `list nodes`: Console no, producer yes. An expected no is recorded as denial, never suppressed. |
| Q9 | `skopeo inspect --raw "docker://$C1"`; `skopeo inspect "docker://$C1_CHILD"`; `skopeo inspect "docker://$P1"`; `cosign verify` and `gh attestation verify` for C1, C1-R and P1 | Published signed index digests, approved linux/amd64 children, source SHAs and run URLs equal the frozen identity; no labels-only source claim. |

Expected live Console env-name set at G0 (groups do not specify order; preserve the live relative order):

| Group | Names |
|---|---|
| Runtime/scope/drift | `OK_CONSOLE_BFF_HOST`, `OK_CONSOLE_BFF_PORT`, `OK_CONSOLE_ENVIRONMENT_ID`, `OK_CONSOLE_TENANT_ID`, `OK_CONSOLE_DRY_RUN_URL`, `OK_CONSOLE_ORIGIN` |
| Session | `OK_CONSOLE_SESSION_STORE_MODE`, `OK_CONSOLE_SESSION_EPOCH`, `OK_CONSOLE_AUTHORIZATION_REVISION`, `OK_CONSOLE_POSTGRES_URL_FILE`, `OK_CONSOLE_POSTGRES_CA_FILE`, `OK_CONSOLE_SESSION_ENVELOPE_PRIMARY_KEY_ID`, `OK_CONSOLE_SESSION_ENVELOPE_KEYS_FILE` |
| OIDC | `OK_CONSOLE_OIDC_ENABLED`, `NODE_EXTRA_CA_CERTS`, `OK_CONSOLE_OIDC_PROVIDER_ID`, `OK_CONSOLE_OIDC_ISSUER`, `OK_CONSOLE_OIDC_CLIENT_ID`, `OK_CONSOLE_OIDC_CLIENT_SECRET_FILE`, `OK_CONSOLE_OIDC_SUBJECT_MAPPINGS_FILE` |
| Exceptional access | `OK_CONSOLE_LOCAL_ACCESS_MODE`, `OK_CONSOLE_LOCAL_ACCESS_ACCOUNTS_FILE`, `OK_CONSOLE_LOCAL_ACCESS_PEPPER_FILE` |
| Source | `OK_CONSOLE_OBSERVED_STATE_MODE`, `OK_CONSOLE_OBSERVED_STATE_URL`, `OK_CONSOLE_OBSERVED_STATE_CA_FILE`, `OK_CONSOLE_OBSERVED_STATE_CLIENT_CERT_FILE`, `OK_CONSOLE_OBSERVED_STATE_CLIENT_KEY_FILE`, `OK_CONSOLE_BFF_ENABLE_FAILURE_INJECTION` |

Inventory excludes Secret data, events, leases and endpointslices; Secret inventory uses default table output only. Discovery must exit zero; each get must exit zero. A successful empty list means zero objects; a failed list never means empty:

```bash
(
RESOURCES=$(kubectl --context ok-shared-admin@ok-shared api-resources --verbs=list --namespaced -o name) || exit "$?"
[ -n "$RESOURCES" ] || { echo 'Empty discovery is an error' >&2; exit 1; }
while IFS= read -r RESOURCE; do
  case "${RESOURCE%%.*}" in
    secrets) k get secrets || exit "$?" ;;
    events|leases|endpointslices) continue ;;
    *) k get "$RESOURCE" -o custom-columns='KIND:.kind,NAME:.metadata.name,UID:.metadata.uid,OWNER:.metadata.ownerReferences[*].uid' || exit "$?" ;;
  esac
done <<< "$RESOURCES"
)
```

**Admission at every gate:** non-forced `k apply --server-side --dry-run=server --field-manager=ok-172-live -f "$ARTIFACT" -o json` (through `ok170-gates.mjs admission` or the verifier) for every next artifact, its paired restoration, `WITHDRAW` and Recovery E. The full live-to-output diff must equal exactly the approved delta, including ordered env lists and omissions; exit zero alone is insufficient. Repeat after each phase against current ownership; an earlier pass does not carry over. Conflict or mismatch is NO-GO: STOP and report, never an imperative workaround.

**G0** also requires: published, verified C1/C1-R/P1; hashed rollback, withdrawal and recovery artifacts; Keycloak route and callback reachable; all decisions in force; announcement; active independent observer.

**Continuity at every step:** before and after each step, record generation and resourceVersion of the Console and producer Deployments, the producer Service, the cluster-observations ConfigMap and the Ingress. Any movement without a procedure apply stops progression. During an apply, record returned versions and attributed controller/status updates before the next checkpoint.

## Observation, blast radius and Recovery E

| Change | Blast radius / expected effect | Proposed bound |
|---|---|---|
| Console rollout or epoch change | All Console users; intermittent auth during rollout; global sign-in again on an epoch change; PostgreSQL sessions, transactions and audit, with key/schema compatibility retained. | Initial ≤300 s; later ≤180 s each. |
| Producer image or ConfigMap | Console is the only consumer; restart interrupts views. No Keycloak/DB change. | ≤180 s. |
| Withdrawal | Producer stays Ready but has no usable route; all views return the bounded 503. | Convergence ≤30 s; restore ≤120 s. |
| Browser lifecycle | Test identities, Keycloak sessions and Console session/flow/audit/throttle state; no shared IdP edits. | ≤10 min; pending flow <300 s. |
| Count-only DB inspection | Aggregate counts for retired epochs; no locks or row deletion. | DB owner approves query budget. |

After every Deployment apply, Q1–Q3 must show the exact pair, profile and ledger values, current owner chains and no old Pods. Read-only `curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' "$ORIGIN/health/live"` and `/health/ready` return 204 under verified TLS. Never disable certificate checks.

Old/revoked-session probes use a fixed Cookie header on **every** request, held only in the approved runner's memory, never a cookie jar; record `cookieSent=true` without content. Probe protected data routes **before** `/api/console/v0/auth/session`; its 401 clears cookies (`bff/security/httpSession.mjs:35-41`). Record each protected 403 and session 401 across both replicas with approved non-sensitive replica attribution. Session lifetimes: exceptional access 5 min idle / 15 min absolute, OIDC 15 min idle / 60 min absolute (`bff/security/session.mjs:11-13`); run every probe before its expiry and record elapsed times. `__Host-` cookies are host-only (`bff/security/session.mjs:4`, `:34-41`).

Pending-flow check for each epoch-changing transition (rollback, forward, emergency): use a separate isolated browser context, start OIDC and park at the Keycloak login form with **no code issued**; after convergence resume the callback within **<300 s** total; require **401 OIDC_TRANSACTION_INVALID**, no new session and protected-route denial. Record `transactionCookieSent=true`, never callback parameters. TTL is 300 s (`bff/security/oidcTransactionStore.mjs:5`); rejection is `bff/security/oidc.mjs:124`. An expired flow or a generic 401/503 does not prove epoch rejection. If convergence cannot meet the TTL, stop and redesign the control.

**Recovery E — CHANGES ok-shared:** first apply `WITHDRAW` (or keep it applied) so stale data is never served as Current. Then `k apply --server-side --field-manager=ok-172-live -f "$EMERGENCY_P_MANIFEST"`, then `-f "$EMERGENCY_C_MANIFEST"`, at an unused emergency epoch. Verify Q1–Q6, health 204, fresh OIDC login and old-context rejection, ≤180 s per Deployment, then `WITHDRAW_RESTORE` only for verified C1/P1. If the Console cannot recover, the last resort is the bootstrap recovery render (C1-R), which ends with the post-recovery breakglass render (C1) and restoration to OIDC. The renderer emits whole inherited overlays: extract only `Deployment/ok-console` from `bootstrap.yaml` and from `post-recovery.yaml` into two per-object artifacts, hash and admit them at G0 like every other artifact, and never apply the full render. `WITHDRAW` stays applied throughout; `WITHDRAW_RESTORE` follows only for verified C1/P1. Leaving the withdrawn state otherwise needs Arash's explicit approval. Keep the Ingress present and announce impaired service. Failed recovery is an incident for Arash and the recovery owner, never permission to weaken auth/TLS or widen scope.

## Phase 1 — deploy C1/P1 at the same epoch; G1

AC2: “AC2. Console runs by the accepted immutable digest and the running Pod image ID matches it.”
AC3: “AC3. The observed-state producer runs from a reviewed immutable revision/image.”
AC11: “AC11. Evidence records exact source revisions, image digests, configuration profile, commands, results and limitations.”

| Step | Future action / change command | Expected observation; abort / immediate recovery |
|---|---|---|
| 1.0 window | Confirm announcement, remaining window, API recovery access, observer and writer freeze. Repeat admission. | Canonical origin/callback reachable; TLS valid. Failure stops G1. |
| 1.1 baseline session | Establish a valid OIDC baseline session (15 min idle) on C0; keep its fixed header in memory. | Session 200 and protected read 200; remaining lifetime exceeds the upgrade. |
| 1.2 deploy | **CHANGES ok-shared:** `k apply --server-side --field-manager=ok-172-live -f "$P1_MANIFEST"`, then `-f "$C1_UPGRADE"`. | Producer ≤180 s, Console ≤300 s. Q1–Q3 and health 204. The baseline session stays valid on both replicas (same epoch); claim continuity only after the disposable rehearsal showed it. Wrong pair, readiness or auth failure → Recovery E. |
| 1.3 identity | Verifier with the post-deploy package: `runtime-identity` against C1/P1 children; producer `auth can-i` (Q8); unauthenticated overview 403. | Every app Pod bound to the frozen pair; mismatch stops before capture. No mid-run image substitution; a new image restarts all evidence. |

## Phase 2 — AC4 and AC5–AC9; G2

AC4: “AC4. OIDC login, PostgreSQL-backed session restoration and logout work through the deployed BFF.”
AC6: “AC6. Overview, Clusters, Cluster Detail and Evidence are rendered from real observed state.”
AC8: “AC8. Invalid identity, invalid trust, unavailable producer, stale and partial observations fail closed with safe UI behavior.”

| Step | Future action / change command | Expected observation; abort / immediate recovery |
|---|---|---|
| 2.1 login/restore | Fresh browser context; mapped identity through OIDC/PKCE; reload and navigate. | Session 200, authenticated views 200, same identity/scope after reload without a new sign-in. |
| 2.2 restart control | **CHANGES ok-shared:** `k apply --server-side --field-manager=ok-172-live -f "$SAME_EPOCH_CONTROL"`, later `-f "$SAME_EPOCH_RESTORE"`. | The valid session survives the Console Pod restart on both replicas (PostgreSQL-backed restore). ≤180 s. Failure stops dependent claims; service regression → Recovery E. |
| 2.3 logout/replay | Keep an in-memory fixed-header copy; wrong-Origin and missing/wrong-CSRF requests give 403 without revocation; then normal logout. | Logout 204; the old cookie gets protected 403 then session 401; a new sign-in succeeds. An accepted revoked session → stop and Recovery E. |
| 2.4 isolated flows | Fresh isolated flows: unmapped subject, state mismatch, replayed callback (recorded as transaction replay, not code reuse), expired session. | Each rejected; no session created. A 503 is inconclusive. |
| 2.5 adverse tokens | Decision 4(a): wrong issuer, wrong audience, or bad signature only through the separately reviewed isolated protocol setup against the deployed BFF (OK-173 sheet). No edits to the shared realm, signing keys or client configuration. | Wrong issuer and wrong audience: rejected with no session. Bad signature: not a current control: openid-client 6.8.7 does not verify ID-token signatures in the code flow (JWKS is not fetched; trust comes from TLS to the token endpoint); policy decision pending (OK-163). A bad-signature token being accepted is neither an expected rejection nor recorded as a regression. Disposable evidence kept separate from live evidence. Missing reviewed setup keeps AC4 open; no waiver. |
| 2.6 views | Authenticated Overview, Clusters, Cluster Detail and `/evidence/{evidenceId}`; hosting-cluster-sourced cluster. | Producer data and observation times match; no raw objects or credentials in browser projections; expected mTLS identity; mutations disabled. Live negatives the acceptance plan defers stay deferred. |

## Phase 3 — AC10 rollback under withdrawal and forward; G3

AC10: “AC10. Rollback and task-scoped cleanup are demonstrated.”

Before each transition prepare a fresh valid-before fixed-header session and a parked flow; re-run admission for the next artifacts, their restoration, `WITHDRAW` and Recovery E. All commands **CHANGE ok-shared**.

| Step | Future command | Expected observation; abort / immediate recovery |
|---|---|---|
| 3.0 withdraw | `k apply --server-side --field-manager=ok-172-live -f "$WITHDRAW"` | No ready Service backends; producer Ready; views return the bounded 503 with safe UI. ≤30 s. Admission conflict → STOP before any rollback. |
| 3.1 rollback | `-f "$P0_MANIFEST"`, then `-f "$C0_ROLLBACK"` | C0/P0 at the rollback row; Q1–Q3, health 204; views still 503 (never Current data); prior contexts and parked flow rejected. ≤180 s per Deployment. Failure → 3.2 if known healthy, otherwise Recovery E. No schema downgrade. |
| 3.2 forward | `-f "$P1_MANIFEST"`, then `-f "$C1_FORWARD"` | C1/P1 at the forward row; Q1–Q3/204; rollback contexts rejected; fresh OIDC works. ≤180 s each; failure → Recovery E with withdrawal kept. |
| 3.3 restore route | `-f "$WITHDRAW_RESTORE"` | Only for verified C1/P1: original selector, two four-view 200 probes ≥5 s apart, ≤120 s. Otherwise remain withdrawn and escalate. |

## Phase 4 — count-only cleanup and closing; G4

DB owner uses an approved read-only SQL entrypoint with privately delivered credentials; no Pod exec or credential extraction. Substitute only retired ledger values; record per-epoch lower bounds first; literal aliases, active identifiers or missing lower bounds block the query. Counts do not delete anything.

```sql
SELECT count(*) AS retired_sessions,
       count(*) FILTER (WHERE revoked_at IS NULL
         AND idle_expires_at > clock_timestamp()
         AND absolute_expires_at > clock_timestamp()) AS unexpired_unrevoked
  FROM ok_console.sessions WHERE deployment_epoch = :'retired_epoch';
SELECT count(*) AS retired_transactions,
       count(*) FILTER (WHERE expires_at > clock_timestamp()) AS unexpired
  FROM ok_console.oidc_transactions WHERE deployment_epoch = :'retired_epoch';
```

Column/expiry contracts: `bff/security/postgres/001_console_sessions.sql:11-22`; `bff/security/postgres/002_oidc_transactions.sql:5-8`. Record counts immediately and after expiry; never report retained rows as removed.

| Step | Future read-only check / normal action | Expected observation; abort |
|---|---|---|
| 4.1 | Count-only queries, fixed-header rejection and expiry timing. | Retired contexts rejected; unexpired counts reach zero after expiry. Unexpected count keeps evidence pending; no cleanup mutation. |
| 4.2 | Repeat Q7; compare with the G0 name/UID/owner set. | Only attributed controller churn (Pod, ReplicaSet, CertificateRequest, CiliumEndpoint, Endpoints/EndpointSlice). Inventory equals G0 plus the approved changes. |
| 4.3 | Repeat Q1–Q9, TLS/204 checks and final views; normal logout of all task sessions; wait the 300 s flow TTL. | C1/P1 stable at the final ledger value; route restored; unauthenticated reads 403/session 401. |
| 4.4 closing | Before unfreezing, land a reviewed overlay aligned to the exit state (digests, active epoch/revision, profile, retained config); run the verifier against it with an empty delta. | Clean non-forced admission, ownership inventory and runtime identity. Never run `verify-ok-shared-live.sh`: it would force-apply the tracked overlay. Any failure keeps the freeze and escalates. On success OK-172 owners release the freeze. |

Hash the complete sanitized record with `sha256sum docs/evidence/ok-170/*.json docs/evidence/ok-170/*.md` after closing evidence is captured.

## Outside this candidate's window

Live fault controls (producer outage, stale threshold, trust hostname; acceptance plan R2 and D8), a planned bootstrap exercise on C1, Ingress or origin corrections, ownership handoff to `ok-170-acceptance`, PKI changes, realm or key edits, producer contract changes and production rollout. Each needs its own reviewed procedure and approval.

## Global abort and evidence boundary

Stop at approval/window/budget expiry, lost observer/recovery owner/API access, unexplained generation/resourceVersion movement, concurrent reconciliation, unapproved drift, unrelated degradation, readiness/quota/DB/audit/IdP failure, accepted invalid context, auth/TLS bypass, fixture fallback or unsafe output. Abort is fail-closed: apply `WITHDRAW`, then Recovery E for image/profile failure. A conflict stops the phase; never force or edit imperatively. Keep the Ingress present, announce impaired service and escalate failed recovery to Arash. Every termination routes through 4.4. Do not call service restored until pair, profile, health, auth and old-context denial are verified. Handoff state is C1/P1 on GO, or fail-closed withdrawal on NO-GO; any other pair needs freshness qualification and Arash's explicit approval.

Record UTC, step, approval, operator/observer, exact sanitized commands/status/error codes, manifest and package hashes, source/pair/profile, generations, owner chains, app imageIDs, the ledger, cookieSent and transactionCookieSent booleans, elapsed session/callback times, same-epoch controls, UI observations, recovery timing, aggregate retired-epoch counts and retained inventory. Preserve sanitized evidence with SHA-256 immediately. Never persist Secret values or hashes, tokens, cookies, CSRF, codes/state/nonce/PKCE, credential names, callback parameters, raw objects/logs, HAR, storage dumps or browser traces. No macOS access is available; Arash must verify macOS-only browser behavior.

## Scope of this procedure

- **Applies to:** candidate C1/C1-R/P1, the same-epoch upgrade, rollback under decision 3(b), and field manager ok-172-live under decision 5.
- **Shown in:** the recorded phase observations of a separately approved window; baseline facts are planning inputs from the 2026-10-22 read-only inspection.
- **Follow-ups:** publication approval, digest pins, disposable rehearsal, the G0 package, window and owners, and AC4/AC10 evidence with independent review; open items stay in the [acceptance plan](acceptance-plan.md).
