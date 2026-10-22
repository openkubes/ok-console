# OK-170 maintenance procedure — separate review required

> **This document is not an execution approval.** Merging it authorizes no change on ok-shared. Every live step needs a separate, explicit approval of the hashed artifact package and a dated window. An event freeze is in force for the Sovereign Cloud Days demonstration on 2026-10-24 (OK-170 comment 15171): no deployment, promotion, rollout, server-side apply, ownership handoff, configuration, credential, certificate, RBAC or producer change, fault injection, negative live test, maintenance exercise or rollback before or during it, and the end of the event does not grant execution authority.

Planning only. This document authorizes no execution. [Acceptance plan](acceptance-plan.md) owns AC mapping, the pair/epoch naming contract, acceptance assertions and the Decisions table. This procedure owns change steps, blast radius, budgets, abort and recovery. AC4 remains required. All steps below are proposed future actions for a separately approved window.

## Authority, inputs and verified baseline

| Input | Required contract |
|---|---|
| Approval | Arash approves the frozen C1/P1 pair, hashed manifests, named operator/recovery owner, independent observer, DB/IdP owners, announcement and UTC window. Resolve dependent [Decisions](acceptance-plan.md#decisions-for-arash) before execution. No implicit window extension. |
| Window | Announced maintenance on shared dev Console; no private route exists. Keep the Ingress present. All Console users may lose views or need to authenticate again. Operator and observer retain Kubernetes API access for recovery. OK-172 owners must freeze all other writers from artifact hashing at execution approval through final handoff: ok-172-live promotions/verifier runs, ok-173-breakglass, ok-170-preview and kubectl-set users. Missing freeze blocks approval/G0; movement after hashing requires revalidation/re-hashing. |
| Pair | Build C1 from ok-console main containing `eb6e751` and `ddb73d9` with OIDC; P1 = P0 unless D3/D5 require producer changes. Include all code required by No in D3–D5 before the single C1/P1 freeze; acceptance waits for those merges. Publish and review that immutable pair before execution. Freeze publication/provenance, schema/key/mixed-version compatibility and platform-child proof per the plan. CR/PR is the distinct compatible abort/rollback pair defined in the plan; G0 requires C0 != C1 or an approved distinct archived CR/PR, otherwise execution stops. |
| Identifiers | Use only the plan's naming table and identifier ledger. E0/A0 are the live baseline; every session-invalidation/profile/rollback/recovery transition gets an unused epoch from that ledger. Epoch-only rotation preserves the authorization revision. Never restore a retired epoch. |
| Identity/origin | Owner-attested mapped/unmapped test identities, narrowly scoped permissions, exact HTTPS callback, PKCE, trusted issuer and working emergency access. Approve the browser origin/callback routing plan at G0; prove reachability at G1 before browser tests. No shared Keycloak realm/key edits in this procedure. |
| Recovery readiness | Update/review recovery overlays, renderer, verifier and deployment tests together for C1/P1 before execution. Both recovery overlays still pin rc.3 at `deploy/kubernetes/overlays/ok-shared-{breakglass,bootstrap-recovery}/kustomization.yaml:10`; renderer checks rc.3 at `deploy/kubernetes/render-ok-shared-recovery.mjs:44`. |
| Budgets | Proposed: initial Console rollout ≤300 s; other Deployments ≤180 s each; R1 lifecycle ≤10 min; fault hold ≤60 s; individual source request ≤10 s. Pending-flow rejection must finish <300 s from flow start, including rollout; a rollout budget alone cannot satisfy this. Approve an adequate total window. |

Baseline facts below are from read-only Kubernetes/registry/source inspection on 2026-10-22. G0 must compare them with the approved artifacts; drift stops execution.

| Fact | Verified value / source |
|---|---|
| C0/P0 definition | The live pair recorded at G0, including full digests, source revision labels, generations and resourceVersions; never a fixed historical digest. Rollback observations remain distinct from C1 acceptance. |
| Example at 2026-10-22 12:12 UTC | Console OCI index `ghcr.io/openkubes/ok-console@sha256:e70b44690adb4a035d3c0f01e01ee366a5bfe55f8ff60861b26ad1ab9a48ddee`, inspected linux/amd64 child `sha256:04f3c727a0e2c32bfdedb56c6eb03243615f5ffce45d330533919c4f18c57ee6`; revision label `182d8dfed618235138f212b0dfe3c9b6d5c80f2f`, bff/breakglass. It contains both R2/R7 merges; labels alone are not provenance or qualification as C1. Producer `ghcr.io/openkubes/observed-state-producer@sha256:6ee7ce8f26a436cf03f56dd5e9ff065c0e121183320cd68e1acaab7916646012`, revision label `ad351c9fe6ff9f2d14ccdd28c49e2f71e081c83d`. |
| Runtime example | Console generation/observedGeneration 43/43, 2 updated/Ready/available; producer 10/10, 1 updated/Ready/available. App imageIDs report the example pair; postgres-migrations is separately digest-pinned and completed. E0/A0 example=`ok-shared-phase-b1-1`/`ok-shared-bootstrap-v1`; PostgreSQL store, OIDC=true, breakglass; no envFrom on either app. |
| Origin/route | Live origin `https://console.ok-shared.internal` (443), issuer `https://keycloak.ok-shared.internal/realms/openkubes`, provider `keycloak-openkubes`, client `ok-console`. Only Ingress is `openkubes-console/ok-console`; Traefik HTTPS NodePort is 30443, LoadBalancer address pending. Repo route uses :30443 (`deploy/kubernetes/README.md:178`) and still says OIDC disabled (`:182`). G0 requires an approved canonical browser routing plan and exact callback; G1 proves reachability before browser tests; no port substitution during testing. |
| Producer/dependencies | Selector `app.kubernetes.io/name=observed-state-producer`; ClusterIP `10.96.49.233`; source mode hosting-cluster. NetworkPolicy `observed-state-producer` admits only Console Pods: Console is the only consumer. Keycloak is off-cluster (overlay host alias: `deploy/kubernetes/overlays/ok-shared-live/kustomization.yaml:35`). Argo controller is present, but no Applications/ApplicationSets exist; neither app Deployment has an Argo field manager. No consumer-inventory gate. |
| Live drift | `OK_CONSOLE_DRY_RUN_URL` points to `http://ok147-console-dry-run.openkubes-system.svc.cluster.local:8790`; that Service exists. Field owner is `kubectl-set`, timestamp 2026-09-10. This variable is absent from the overlay; tenant/environment IDs and BFF host/port are present at `deploy/kubernetes/overlays/ok-shared-live/kustomization.yaml:41-52`. D6 defaults to adopting the same value into the overlay; its unchanged value admits cleanly. Removal and tenant-ID changes require a separately approved managedFields edit outside this procedure; SSA cannot remove kubectl-set Update ownership. Preserve tenant `platform`. |
| Source defaults | `bff/source.mjs:26-27`: timeout 5000 ms, stale threshold 300000 ms. No live override is set. Confirm these defaults against frozen C1 source/image before drills. |

## Product gaps and execution scope

| Gap | Consequence / proposed control |
|---|---|
| AC8 stale observation | Producer metadata.observedAt is set to now() on every request, and the BFF stale check uses only that, so “stale” today means response latency, not observation age. Source: `openkubes@ad351c9 platform/console/observed-state-producer/app.py:525`, `:583`, `:823-833`; `bff/adapters/openKubesObservedState.mjs:311` (strict `>`), `:330` (SOURCE_STALE). The hand-written observations are over 15 hours old yet P0 classifies them Current and the BFF serves them Current: a demonstrated fail-open for observation age. Accepting D3 explicitly accepts that behavior; current code cannot satisfy AC8 stale observation. The plan asks yes/no: accept a documented limitation for this dev gate, or require code included before the single C1/P1 freeze; acceptance waits. With D3 Yes, step 4.S is only a latency-classification control. D3 and D5 cite the same observation-age fail-open; one reviewed code fix can cover both, with separate acceptance assertions. |
| R5 producer-sourced, current | Three clusters (ok-mgmt, ok-ai, ok-infra) come from hand-written `deploy/kubernetes/overlays/ok-shared-live/producer-cluster-observations.yaml:14`, `:24`, `:34`; live ConfigMap matches. Producer classifies their evidence Current (`openkubes@ad351c9 platform/console/observed-state-producer/app.py:714-716`). Current code cannot prove R5 “producer-sourced, current” for these entries. Use a hosting-cluster-sourced cluster for R5. D5 asks yes/no: accept the demonstrated fail-open (15+ hour observations still Current) for this dev gate, or require code included before the single C1/P1 freeze; acceptance waits. `observedAt` is producer-owned, so a producer fix requires a new P1. |
| R4 invalid-trust discriminator | BFF maps all upstream/TLS failures to one 503 SOURCE_UNAVAILABLE and logs no cause (`bff/app.mjs:264-269`; contract errors are 502 at `:259-260`). A specific invalid-trust discriminator needs code. The plan asks yes/no: accept a documented limitation for this dev gate, or require code included before the single C1/P1 freeze; acceptance waits. Step 4.T offers a no-new-image differential control; generic 503 alone is inconclusive. |
| AC10 physical deletion | This procedure uses count-only evidence by retired epoch, expiry and normal logout. It issues no DB locks or deletes. The plan asks yes/no: does AC10 require physical deletion? If yes, a separate reviewed step is required later. Expiry/rejection and physical removal are distinct facts. |
| Bootstrap on C1 | `README.md:66-67 (repository root)` makes a breakglass browser build OIDC-primary. The plan asks whether running bootstrap mode on that breakglass-labelled build in 5.3 is acceptable. If no, resolve the build/profile contract before freezing C1; do not substitute another image mid-rehearsal. |

## Reviewed artifact and change mechanism

Every change to the Console Deployment, producer Deployment/Service or Ingress is a server-side apply of a reviewed, SHA-256-bound manifest rendered from the repo with `--field-manager="$PROCEDURE_MANAGER"`. No imperative edits, Ingress deletion, database locks or database deletes. D10 selects `PROCEDURE_MANAGER` once: Yes = `ok-170-acceptance` after Phase-0 handoff; No = `ok-172-live` with writer freeze/continuity and no transfer. Under No, 4.U and any Ingress correction remain blocked; ordinary phases and Recovery E require clean complete-artifact admission. D10 Yes permits existing managers for named adoption/releases in Phase 0 and closing step 6.5; all applies are non-forced. No unchanged-baseline force step is permitted. Render any Ingress artifact from `deploy/kubernetes/overlays/ok-shared-live/ingress.yaml`, never from a captured live object. No full inherited overlay apply.

| Artifact variable | Exact approved contents |
|---|---|
| `P1_MANIFEST`, `PR_MANIFEST` | Producer Deployment only, selected immutable pair, compatible configuration; skip an apply only if already identical. |
| `C1_INITIAL`, `C1_EPOCH` | Console Deployment only; initial C1/OIDC-primary profile at E1/A1 and subsequent epoch-only invalidation at E2/A1. Identifiers come from the plan's ledger. |
| `U_FAULT`, `U_RESTORE` | Producer Service only; zero-match selector `openkubes.io/ok170-fault=unavailable` / original selector, preserving Service identity/ports. |
| `S_FAULT`, `S_RESTORE` | Console Deployment only; latency-control stale threshold 1 ms / original absent override. Preserve image, epoch and authorization revision for authenticated controls. |
| `T_FAULT`, `T_RESTORE` | Console Deployment only; approved hostname-only producer URL change / original URL. Preserve image, epoch, auth, port, path, protocol, CA and client identity. |
| `CR_ROLLBACK`, `C1_FORWARD`, `R1_BOOTSTRAP_MANIFEST`, `R1_POST_MANIFEST` | Console Deployment-only transitions; rollback/forward pair then bootstrap and OIDC-primary BreakGlass on the same C1. E3/A2 rollback, E4/A3 forward, E5/A4 bootstrap, E6/A5 final restoration. |
| `EMERGENCY_P_MANIFEST`, `EMERGENCY_C_MANIFEST` | Compatible CR/PR with approved configuration and unused E7/A6 (later emergencies use the plan’s retry ledger); retain keys, schema, data and audit. Review replenishment artifacts if the emergency epoch is consumed. |
| `INGRESS_MANIFEST` (only if required) | Repo-rendered reviewed origin/routing correction, with separately hashed restore artifact; requires explicit approval and exact recovery command in the window sheet. Existing route otherwise remains untouched. |
| `SAME_EPOCH_CONTROL`, `SAME_EPOCH_RESTORE` | Console Deployment only for each control checkpoint; preserve the current pair, epoch, authorization revision and profile, changing only a new Pod-template annotation `openkubes.io/ok170-rollout-control`; preserve kubectl-rollout-owned `kubectl.kubernetes.io/restartedAt`. Include its non-forced admission and paired marker restoration. |

Review rendered contents, field ownership, dependencies and hashes before approval. Current verifier forces conflicts in its dry-run at `deploy/kubernetes/verify-ok-shared-live.sh:52` and apply at `:65`; do not use it for this procedure. A verify-only implementation and runtime imageID comparison belong to the plan's prerequisites.

## Phase 0 — read-only pre-flight and separately gated ownership reconciliation; G0

Obtain and verify kubectl **v1.34.1 before G0**, matching the observed server **v1.34.1**; absence blocks G0. All following `k` commands assume approved cluster access and this explicit context/namespace wrapper:

```bash
k() { kubectl --context ok-shared-admin@ok-shared -n openkubes-console "$@"; }
kubectl version -o json
kubectl config current-context
```

Stop on every unexpected command failure. No Secret values, value hashes, credential filenames or unfiltered logs enter evidence.

| ID | Read-only command / inspection | Required observation |
|---|---|---|
| Q1 | `k get deployment ok-console observed-state-producer -o custom-columns='NAME:.metadata.name,GEN:.metadata.generation,OBS:.status.observedGeneration,DESIRED:.spec.replicas,UPDATED:.status.updatedReplicas,READY:.status.readyReplicas,AVAILABLE:.status.availableReplicas,IMAGE:.spec.template.spec.containers[*].image'` | G0 baseline above; later phase pair, observed generation equals generation; Console 2/2, producer 1/1. |
| Q2 | `k get pods,replicasets -o json` into an approved structural projection | Retain names/UID/controller owners, deletion flag, app image/Ready/imageID plus every initContainer spec/imageID/completion status, including postgres-migrations; verify its separate pinned dependency. Resolve Pod→RS→Deployment; no mixed, foreign, old or terminating app Pods. Compare OCI parent/child/platform per plan; never retain the raw dump. |
| Q3 | `k get deployment ok-console observed-state-producer --show-managed-fields -o json` into the allowlisted projection below | Full Console env-name set below, reviewed safe values, no envFrom, mounts/security/strategy and initContainers (including postgres-migrations) preserved; compare the per-object manager allowlist below and named-field ownership; any other manager stops G0. Check Service and Ingress managedFields too. |
| Q4 | `k get service observed-state-producer -o jsonpath='{.spec.selector}{"\n"}{.spec.clusterIP}{"\n"}'`; `k get endpointslices -l kubernetes.io/service-name=observed-state-producer -o json`; `k get pods -l openkubes.io/ok170-fault=unavailable -o name` | Approved selector/IP, one ready producer backend; fault selector matches zero Pods. Endpointslices are inspected for routing only, excluded from retained inventory. |
| Q5 | `kubectl --context ok-shared-admin@ok-shared get ingress -A`; `kubectl --context ok-shared-admin@ok-shared -n ingress get service traefik -o jsonpath='{.spec.ports}{"\n"}{.status.loadBalancer}{"\n"}'` | Only expected Console Ingress; G0 approves the routing plan, G1 browser verifies canonical HTTPS origin/callback. Keep route available throughout announced window. |
| Q6 | `k get certificates,cluster.postgresql.cnpg.io,pvc`; `k get resourcequota,limitrange,pdb,networkpolicy`; `kubectl --context ok-shared-admin@ok-shared get applications,applicationsets -A` | Dependencies healthy, surge capacity, reviewed policies and no unexpected reconciliation. Owner attests actual served leaf identities without reading TLS Secret data. |
| Q7 | Inventory loop below; `kubectl --context ok-shared-admin@ok-shared get clusterrole,clusterrolebinding ok-shared-observed-state-producer -o json` | Retained namespace metadata plus exact cluster-scoped producer RBAC; no list errors or unexpected object deltas. |
| Q8 | For each SA `ok-console` and `observed-state-producer`: `k auth can-i get secrets --as="system:serviceaccount:openkubes-console:$SA"`; repeat for `get pods`, `create deployments.apps`, `patch deployments.apps`, `delete pods` | All no. Repeat `get nodes` and `list nodes`: Console no, producer yes. An expected no exit code is recorded as denial, never suppressed. Operator confirms patch rights for Deployments/Service and Ingress only if approved. |
| Q9 | `skopeo inspect --raw "docker://$C1"`; `skopeo inspect "docker://$C1_CHILD"`; `skopeo inspect "docker://$P1"`; plan's provenance checks | Frozen source-complete pair, inspected platform children and verified publication evidence; no labels-only source claim. |

Q3 ownership projection and in-memory live comparison (named field paths only, no raw env/mount/reference values); each named-field path is printed with its owner; compare exact paths with the Phase-0 table (an absent path has no owner). Record each manager, operation and time, including null times. Use inventory mode for the four-object read, preserve/release modes below for ownership gates and an approved safe-value comparison for intended config; source references in this procedure use ok-console main `a4f6237` unless specified otherwise:

```bash
(
set -o pipefail
k get deployment/ok-console deployment/observed-state-producer service/observed-state-producer ingress/ok-console --show-managed-fields -o json | python3 -c '
import json,sys,subprocess
mode=sys.argv[1] if len(sys.argv)>1 else "inspect"
release_manager=sys.argv[2] if len(sys.argv)>2 else None
assert mode in ("inspect","inventory","preserve","release"), "Unknown Q3 mode"
def leaves(tree,path=()):
 if not tree: return {path} if path else set()
 return set().union(*(leaves(v,path+(k,)) for k,v in tree.items()))
def owners(d):
 return {(m["manager"],m["operation"],m.get("subresource")):leaves(m.get("fieldsV1",{})) for m in d["metadata"].get("managedFields",[])}
def envlists(d):
 spec=d.get("spec",{}).get("template",{}).get("spec",{})
 return {g:[(c["name"],[e["name"] for e in c.get("env",[])]) for c in spec.get(g,[])] for g in ("containers","initContainers")}
watched={"OK_CONSOLE_SESSION_EPOCH","OK_CONSOLE_AUTHORIZATION_REVISION","OK_CONSOLE_OIDC_ENABLED","OK_CONSOLE_LOCAL_ACCESS_MODE","OK_CONSOLE_ORIGIN","OK_CONSOLE_OBSERVED_STATE_URL","OK_CONSOLE_OBSERVED_STATE_STALE_AFTER_MS","OK_CONSOLE_DRY_RUN_URL","OK_CONSOLE_TENANT_ID"}
def named(tree,path=()):
 for key,value in tree.items():
  p=path+(key,)
  if key in ("f:image","f:selector","f:rules","f:tls","f:kubectl.kubernetes.io/restartedAt","f:openkubes.io/ok170-rollout-control"):
   yield "/".join(p)
  elif key in ("f:name","f:value") and any("k:"+json.dumps({"name":n},separators=(",",":")) in path for n in watched):
   yield "/".join(p)
  else:
   yield from named(value,p)
o = json.load(sys.stdin); items = o.get("items", [o])
if mode=="inventory":
 assert {(d["kind"],d["metadata"]["name"]) for d in items}=={("Deployment","ok-console"),("Deployment","observed-state-producer"),("Service","observed-state-producer"),("Ingress","ok-console")}, "Incomplete Q3 object set"
for d in items:
 live=json.loads(subprocess.check_output(["kubectl","--context","ok-shared-admin@ok-shared","-n","openkubes-console","get",d["kind"],d["metadata"]["name"],"--show-managed-fields","-o","json"]))
 prior=owners(live)
 if mode in ("preserve","release"):
  assert d.get("spec")==live.get("spec"), "Spec changed"
  assert d["metadata"].get("generation")==live["metadata"].get("generation"), "Generation changed"
  assert envlists(d)==envlists(live), "Ordered env lists changed"
 if mode=="release":
  assert release_manager, "Releasing manager required"
  assert all(not (v-prior.get(k,set())) for k,v in owners(d).items() if k[0]==release_manager), "Release acquired fields"
 print("specEqual",d.get("spec")==live.get("spec"),"generationEqual",d["metadata"].get("generation")==live["metadata"].get("generation"),"orderedEnvEqual",envlists(d)==envlists(live))
 print(d["kind"],d["metadata"]["name"],"generation",d["metadata"].get("generation"),"resourceVersion",d["metadata"]["resourceVersion"])
 assert d["metadata"].get("managedFields"), "Missing managedFields"
 for m in d["metadata"]["managedFields"]:
  key=(m["manager"],m["operation"],m.get("subresource"))
  print("manager",m["manager"],m["operation"],m.get("time"),"newlyOwnedFields",len(leaves(m.get("fieldsV1",{}))-prior.get(key,set())))
  for path in named(m.get("fieldsV1",{})):
   print("field",path,"owner",m["manager"],m["operation"],m.get("time"))
 for group in ("containers","initContainers"):
  for c in d.get("spec",{}).get("template",{}).get("spec",{}).get(group,[]):
   print(group,c["name"],"image",c["image"],"envNames",[e["name"] for e in c.get("env",[])],"envFrom",bool(c.get("envFrom")))' inventory
)
```

Full expected live Console env-name set at G0 (groups below do not specify order): preserve the **live relative env order** in every artifact. Adoption/release require identical ordered env lists and full specs, with unchanged generation; table order is not a rendering order.

| Group | Names |
|---|---|
| Runtime/scope/drift | `OK_CONSOLE_BFF_HOST`, `OK_CONSOLE_BFF_PORT`, `OK_CONSOLE_ENVIRONMENT_ID`, `OK_CONSOLE_TENANT_ID`, `OK_CONSOLE_DRY_RUN_URL`, `OK_CONSOLE_ORIGIN` |
| Session | `OK_CONSOLE_SESSION_STORE_MODE`, `OK_CONSOLE_SESSION_EPOCH`, `OK_CONSOLE_AUTHORIZATION_REVISION`, `OK_CONSOLE_POSTGRES_URL_FILE`, `OK_CONSOLE_POSTGRES_CA_FILE`, `OK_CONSOLE_SESSION_ENVELOPE_PRIMARY_KEY_ID`, `OK_CONSOLE_SESSION_ENVELOPE_KEYS_FILE` |
| OIDC | `OK_CONSOLE_OIDC_ENABLED`, `NODE_EXTRA_CA_CERTS`, `OK_CONSOLE_OIDC_PROVIDER_ID`, `OK_CONSOLE_OIDC_ISSUER`, `OK_CONSOLE_OIDC_CLIENT_ID`, `OK_CONSOLE_OIDC_CLIENT_SECRET_FILE`, `OK_CONSOLE_OIDC_SUBJECT_MAPPINGS_FILE` |
| Exceptional access | `OK_CONSOLE_LOCAL_ACCESS_MODE`, `OK_CONSOLE_LOCAL_ACCESS_ACCOUNTS_FILE`, `OK_CONSOLE_LOCAL_ACCESS_PEPPER_FILE` |
| Source | `OK_CONSOLE_OBSERVED_STATE_MODE`, `OK_CONSOLE_OBSERVED_STATE_URL`, `OK_CONSOLE_OBSERVED_STATE_CA_FILE`, `OK_CONSOLE_OBSERVED_STATE_CLIENT_CERT_FILE`, `OK_CONSOLE_OBSERVED_STATE_CLIENT_KEY_FILE`, `OK_CONSOLE_BFF_ENABLE_FAILURE_INJECTION` |

Inventory excludes Secret data, events, leases and endpointslices; Secret inventory uses default table output only. Discovery must exit zero (partial-discovery errors abort); each get must exit zero. A successful empty resource list means zero objects; a failed list never means empty. Exit applies only to this subshell:

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

**Admission at every gate:** `k apply --server-side --dry-run=server --field-manager="$PROCEDURE_MANAGER" -f "$ARTIFACT" -o json` for every next-phase artifact, its paired restoration and Recovery E, without force. Before the handoff, only named adoption/release artifacts are admitted under explicit managers; 0.3 sets PROCEDURE_MANAGER and admits all later artifacts. Structurally compare the server dry-run OUTPUT with both live spec and the reviewed artifact: require the full bidirectional live-to-output diff to equal exactly the approved path/value delta (including omissions); exact per-container ordered env lists, intended env values/reference shapes and all changed fields (selector, rules, image, epoch, profile, URL, threshold); reject retained omitted variables, extras, missing fields or unexpected defaults after approved normalization. Exit zero alone is insufficient. Retain only allowlisted comparison results. Repeat after each phase against current field ownership; an earlier G0 pass is insufficient. Conflict/mismatch is NO-GO: reconcile and review through Phase 0, never use an imperative workaround. G0 additionally requires approved origin, emergency path, source-complete pair, all dependent decisions, announcement and active independent observation.

### Ownership reconciliation — separate Phase-0 decision and execution approval

D10 Yes in the [Decisions table](acceptance-plan.md#decisions-for-arash) grants the manager-contract exception for named adoption/releases; exact artifacts and execution still need approval. D10 No skips 0.1–0.2 and transfer-only ownership checks in 0.3: set `PROCEDURE_MANAGER=ok-172-live` and retain the freeze/continuity checks. 4.U and Ingress correction stay blocked; other steps require clean complete-artifact admission. D10 Yes sets `PROCEDURE_MANAGER=ok-170-acceptance` only after completed handoff; until then all Phases 2–5 and Recovery E (and other transfer-dependent changes) are blocked. Use an adopt-then-release handoff, never force. Adoption uses unchanged named baseline values under `ok-170-acceptance`; releases omit only the selected fields from each existing Apply manager’s reviewed repo-rendered artifact, retaining every other field it owns. Render each release from the overlay that its releasing manager last applied; never substitute another manager’s overlay. No live object capture becomes a deployment manifest. Adoption and release require dry-run output **spec equal to live spec**, **generation unchanged** (when present), and **ordered env lists identical to live**, preserving relative order. Any deletion/default/empty value/reordering stops the step. Q3 must show no newly owned fields after a release: compare the releasing manager’s complete field-path set before/after (after must be a subset), plus selected paths absent. For per-object dry-run output reuse the Q3 Python body with argument `preserve` for adoption or `release "$RELEASING_MANAGER"` for release (instead of `inventory`); both assert spec/generation/order equality, and release also asserts zero newly owned fields. Require selected paths absent as well; inspect mode alone is not a gate. Its fresh live read must match the continuity ledger; concurrent movement invalidates the comparison.

| Object | Expected G0 managers (operation) | Named fields / handoff |
|---|---|---|
| Deployment ok-console | ok-170-preview (Apply), ok-173-breakglass (Apply), ok-172-live (Apply), kubectl-set (Update), kubectl-rollout (Update), kube-controller-manager (Update) | Image and changed env **values** (epoch, auth revision, OIDC/local mode, origin, producer URL, any pre-existing stale override), separately approved init image if changed. Image/env-value reconciliation was unnecessary under ok-172-live (clean prior dry-runs); the new manager conflicts with its value ownership. Adopt first, then release these values from ok-172-live; release other Apply owners only where Q3 shows value ownership. Co-owned env-entry keys are expected. Keep DRY_RUN_URL and TENANT_ID unchanged and preserve restartedAt. |
| Deployment observed-state-producer | ok-173-breakglass (Apply), ok-172-live (Apply), kube-controller-manager (Update) | Image and reviewed P1 changed config values; adopt first then release each actual Apply value owner, principally ok-172-live. |
| Service observed-state-producer | ok-173-breakglass (Apply), ok-172-live (Apply) | Adopt atomic `.spec.selector`, then both old managers omit selector. |
| Ingress ok-console | ok-173-breakglass (Apply), ok-172-live (Apply) | If correction approved, adopt atomic `.spec.rules` and each changed TLS/origin field, then each old owner omits those fields. Otherwise keep route untouched. |

Q3 reads all four objects with `--show-managed-fields` through the projection above. Any manager outside this baseline list stops G0; add only approved `ok-170-acceptance` after adoption. D10 Yes requires sole **value** ownership of fields changed later; D10 No retains existing value ownership with clean admission. Env-entry keys and unrelated fields may remain co-owned. No SSA release removes kubectl-set Update ownership of DRY_RUN_URL; D6 must be adopt. Its removal or tenant-ID change needs a separate approved managedFields edit outside this procedure.

| Step | Proposed exact command / admission | Observation; abort and recovery |
|---|---|---|
| 0.1 read-only | Q3; per object `k apply --server-side --dry-run=server --field-manager=ok-170-acceptance --show-managed-fields -f "$OWNERSHIP_ADOPT" -o json` through Q3 projection | Unchanged named-field adoption must preserve full spec, generation and ordered env lists, and add only selected co-ownership. Server dry-runs admit all four baseline objects unchanged. Different image conflicts with ok-172-live; different selector/rules conflict with both old managers. Existing env-value changes conflict; new stale override admits. Require exact manager/operation/time/named-field owner output. |
| 0.2a CHANGES ok-shared | Per approved object: `k apply --server-side --field-manager=ok-170-acceptance -f "$OWNERSHIP_ADOPT"` | Before apply, require dry-run spec == live spec, generation unchanged and ordered env lists identical. Adopt only baseline values; no rollout/spec change allowed. Q3 must show new owner of every selected value before any release. Unexpected delta stops, retain existing config and escalate; do not release fields lacking new ownership. |
| 0.2b CHANGES ok-shared; sequential per old owner | Before each release: `k apply --server-side --dry-run=server --field-manager="$RELEASING_MANAGER" --show-managed-fields -f "$OWNERSHIP_RELEASE" -o json`; only after dry-run output spec == live spec, generation unchanged, identical ordered env lists and no newly owned fields: `k apply --server-side --field-manager="$RELEASING_MANAGER" -f "$OWNERSHIP_RELEASE"` | RELEASING_MANAGER is exactly the approved ok-173-breakglass, ok-170-preview or ok-172-live owner from the table. Service/Ingress omission dry-runs succeed unchanged and remove that owner’s selector/rules ownership. Deployment image release before persisted adoption fails required-image validation; never skip 0.2a. Other pre-adoption release outputs can change spec and are rejected. Stop on any spec delta; retain prior spec and escalate ownership recovery, never continue partially reconciled. |
| 0.3 read-only gate | D10 Yes: after all ownership gates, set `PROCEDURE_MANAGER=ok-170-acceptance`; D10 No: set `PROCEDURE_MANAGER=ok-172-live`. Then Q3 and non-forced admission of every later unblocked artifact, paired restore and Recovery E | D10 Yes requires sole changed-value ownership by ok-170-acceptance and exact returned fields/ordered env lists; D10 No requires existing-owner admission for ordinary artifacts only. Dry-runs do not persist a handoff: sequential post-adoption Deployment release and complete later-artifact admission remain gates for the approved window. D10 Yes: until passed, all Phases 2–5 and Recovery E are not executable. D10 No: 4.U and any Ingress correction remain blocked. |

The handoff changes future writers’ ownership; specs/traffic must remain unchanged, ≤60 s per object for inspection. Unexpected rollout/degradation aborts; restore reviewed config through its known owner only after admission and escalate ownership repair. Runtime recovery must not silently restore co-ownership.

**Continuity at every step:** before and after each step (including read-only/browser steps), Q3 records generation + resourceVersion of all four objects. Compare with the prior ledger; either moving without a procedure apply stops progression globally. During an apply, record its returned versions, expected generation/spec delta and explicitly attributed controller/status updates before setting the next checkpoint. Any unexplained change aborts; OK-172 owners keep all listed writers frozen from approval hashing until final handoff, including step 6.5 on D10 Yes. Repeat this check around each individual release/apply, not just phase gates.

## Observation, blast radius and Recovery E

| Change | Blast radius / expected effect | Proposed bound |
|---|---|---|
| Console rollout/epoch/profile | All Console users; intermittent auth during rollout, global reauthentication on epoch change; PostgreSQL sessions/transactions/audit and retained key/schema compatibility. | Initial ≤300 s; later ≤180 s each. |
| Producer image or Service selector | Console is the only consumer. Producer restart interrupts views; selector fault leaves Pod Ready but removes usable routing. No Keycloak/DB change. | Image ≤180 s; selector convergence ≤30 s, hold ≤60 s, recovery ≤120 s. |
| Stale threshold / producer hostname | All Console users' new data reads; latency-qualified data or generic 503. Sessions/trust configuration remain intact during these controls. | Rollout ≤180 s each direction, hold ≤60 s. T restore to 200 within 180 s of restoration apply, including rollout. |
| Dry-run URL drift disposition | Console dependency on `openkubes-system/ok147-console-dry-run`; default adoption retains the same value; removal or tenant-ID changes are out of scope and need a separate approved managedFields edit. No edits to that Service or namespace. | Included in initial rollout; regression aborts acceptance. |
| Browser lifecycle/recovery | Test identities/IdP sessions and Console session/flow/audit/throttle state; bootstrap temporarily disables Console OIDC. Keycloak is off-cluster; no shared IdP edits. | Lifecycle ≤10 min; pending flow <300 s. |
| Ingress correction, if approved | All Console host users; origin/callback and host-only cookies affected. No deletion or private-route assumption. | Separate approved bound and restoration required. |
| Count-only DB inspection | Aggregate counts scoped to retired epochs; retains data/audit, no explicit locks or row deletion. | DB owner approves query budget. |

After every Deployment apply, Q1–Q3 must show exact pair/profile/ledger identifiers, current owner chains and no old Pods. Read-only `curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' "$ORIGIN/health/live"` and `/health/ready` must return 204 under verified TLS. Never disable certificate checks.

Prefer an OIDC baseline session for R1.1 (15 min idle); the break-glass 5 min idle budget equals the initial 300 s rollout bound. Old/revoked-session probes use a fixed Cookie header on **every** request, held only in the approved runner's memory, never a cookie jar. Record `cookieSent=true` without cookie content. Probe protected data routes **before** `/api/console/v0/auth/session`; its 401 clears cookies (`bff/security/httpSession.mjs:35-41`). Record each protected response 403 and session response 401 across both replicas using approved non-sensitive replica attribution. Session lifetimes are exceptional access 5 min idle / 15 min absolute, OIDC 15 min idle / 60 min absolute (`bff/security/session.mjs:11-13`). Run every old-session probe before its idle and absolute expiry; record elapsed time since last valid access and issuance. Add a same-epoch rollout positive control using an otherwise identical reviewed Console artifact with the new openkubes.io/ok170-rollout-control annotation (never restartedAt): the valid session must survive on both replicas. Missing attribution, expiry or failed positive control is inconclusive. `__Host-` cookies are host-only (`bff/security/session.mjs:4`, `:34-41`); no alternate-host access assumption.

Pending-flow check: if a producer transition is required, finish it first; park the flow immediately before the Console apply. Use a separate isolated browser context for each parked flow. Start OIDC and park at Keycloak login form, with **no code issued**. Record transactionCookieSent=true at callback without its value. Add an isolated same-epoch parked-flow positive control over an otherwise identical rollout: callback must succeed within TTL. Do not run the fresh-login control in the parked flow’s browser profile before resuming it; that can replace its transaction cookie. Record start time, then after epoch convergence resume callback within **<300 s** total; require **401 OIDC_TRANSACTION_INVALID**, no new session and protected-route denial. Do not record callback parameters. TTL is 300 s (`bff/security/oidcTransactionStore.mjs:5`); specific rejection is `bff/security/oidc.mjs:124`. Expired flow or generic 401/503 does not prove epoch rejection. A flow crossing an image change proves rejection, not rejection because of epoch; only 2.4 isolates epoch. If convergence cannot meet TTL, stop and redesign the control before claiming a pass.

**Recovery E — CHANGES ok-shared:** restore any active Service fault with 4.U recovery first, then `k apply --server-side --field-manager="$PROCEDURE_MANAGER" -f "$EMERGENCY_P_MANIFEST"`, then `k apply --server-side --field-manager="$PROCEDURE_MANAGER" -f "$EMERGENCY_C_MANIFEST"`. Use approved compatible CR/PR and an unused emergency epoch; skip producer apply only if identical. Console artifact also clears fault overrides. Verify Q1–Q6, health 204, fresh OIDC login and old-context rejection, ≤180 s per Deployment. Keep Ingress present; announce impaired service until verified healthy. Failed recovery is an incident for Arash/recovery owner, never permission to weaken auth/TLS or widen scope.

## Phases 1–3 — announced window, R1 and R3/R5

R1 AC4: “AC4. OIDC login, PostgreSQL-backed session restoration and logout work through the deployed BFF.”

R3 AC2: “AC2. Console runs by the accepted immutable digest and the running Pod image ID matches it.”
AC3: “AC3. The observed-state producer runs from a reviewed immutable revision/image.”
AC11: “AC11. Evidence records exact source revisions, image digests, configuration profile, commands, results and limitations.”

R5 AC6: “AC6. Overview, Clusters, Cluster Detail and Evidence are rendered from real observed state.”

| Step | Future action / change command | Expected observation; abort / immediate recovery |
|---|---|---|
| 1.0 / G1 window | Confirm announcement, remaining window, API recovery access and observer. No Ingress withdrawal. D10 Yes only, after approved Phase-0 reconciliation, optional approved origin correction uses `k apply --server-side --field-manager="$PROCEDURE_MANAGER" -f "$INGRESS_MANIFEST"` only with reviewed restoration sheet. | Canonical origin/callback reachable; TLS valid. Failure stops G1; restore the reviewed routing artifact if changed. No private route is presumed. Repeat gate admission checks. |
| 1.1 baseline browser | Session/audit writes: establish a valid baseline **OIDC preferred** session (15 min idle; exceptional access only with a proven sufficient 5 min budget); retain its fixed header in memory for epoch discrimination. Confirm validity immediately before transition; start a separate parked OIDC flow only when ready for timed control. | Session 200 and protected read 200 before transition. Remaining lifetime must exceed transition; failure/expiry stops before apply. Baseline exceptional access does not satisfy AC4. |
| 1.1a same-epoch controls | **CHANGES ok-shared:** `k apply --server-side --field-manager="$PROCEDURE_MANAGER" -f "$SAME_EPOCH_CONTROL"`; only after completed Phase 0 and successful G1 routing; repeat before later epoch transitions using the current checkpoint's artifact. | Valid session survives rollout on both replicas; isolated parked-flow callback succeeds with transaction cookie sent, within TTL. ≤180 s rollout and all idle/absolute/flow limits apply. Failed positive control stops dependent rejection claims; restore via `k apply --server-side --field-manager="$PROCEDURE_MANAGER" -f "$SAME_EPOCH_RESTORE"` or Recovery E for service regression. Repeat gate admission checks. |
| 2.1 deploy pair | **CHANGES ok-shared:** `k apply --server-side --field-manager="$PROCEDURE_MANAGER" -f "$P1_MANIFEST"`, then `k apply --server-side --field-manager="$PROCEDURE_MANAGER" -f "$C1_INITIAL"`. | Q1–Q3/204; baseline fixed-header rejection and timed pending-flow check above. Producer ≤180 s / Console ≤300 s; wrong pair, auth acceptance or readiness failure → Recovery E. TTL miss leaves callback assertion pending. |
| 2.2 login/restore | Session/audit writes: fresh browser context without Console/Keycloak session; normal OIDC/PKCE/MFA journey, reload/navigate to restore. | Session 200, authenticated views 200, same identity/scope after reload without fresh login; plan's PostgreSQL/both-replica proof. ≤10 min; failures stop, normal logout; service regression → Recovery E. |
| 2.3 logout/replay | Session/audit writes: preserve an in-memory fixed-header copy; validate wrong-Origin/missing-or-wrong-CSRF requests yield 403 without revocation, then normal UI logout. | Logout 204; fixed-header protected-route probes 403 before session 401; fresh deliberate login succeeds. Any accepted revoked session → stop and Recovery E. |
| 2.4 epoch rotation | **CHANGES ok-shared:** `k apply --server-side --field-manager="$PROCEDURE_MANAGER" -f "$C1_EPOCH"`; retain pair/auth revision, change only epoch via reviewed manifest. | Valid-before session and parked flow rejected after convergence by controls above; fresh login succeeds. ≤180 s proposed, callback <300 s total. Repeat gate admission checks. Failure → Recovery E. |
| 2.5 / G2 protocol | Separately reviewed isolated OK-173 protocol sheet; source-matched negative token/JWKS evidence and positive control per plan. No shared realm/signing-key mutation. | Missing exact isolated commands/evidence blocks dependent R1 acceptance. Invalid inputs must not create sessions; 503 is inconclusive. Stop fixtures by their reviewed sheet; Recovery E for Console regression. No AC4 waiver. Repeat gate admission checks. |
| 3.1 R3 identity | Read-only Q1–Q3/Q9 and plan's source/provenance/runtime comparisons. | Every app Pod bound to same frozen pair; mismatch stops before capture. No mid-run image substitution; new image restarts all candidate evidence. |
| 3.2 / G3 R5 views | Session/audit/load effects: authenticated Overview, Clusters, Cluster Detail, Evidence; derive authorized item IDs and use hosting-cluster-sourced cluster. Capture consumed-response correlation by approved bounded telemetry. | Four view field/timestamp assertions per plan, safe UI and partial/Unknown preserved. No `/evidence` collection route; use `/evidence/{evidenceId}`. Missing safe correlation mechanism blocks this phase; instrumentation needs separately reviewed exact SSA start/restore artifacts before approval. Stop capture/logout on unsafe output or regression; Recovery E if service affected. Repeat gate admission checks. |

## Phase 4 — one R4 control at a time; G4U/G4S/G4T

AC8: “AC8. Invalid identity, invalid trust, unavailable producer, stale and partial observations fail closed with safe UI behavior.”

Each command below **CHANGES ok-shared**. Each induction requires healthy authenticated four-view baseline, admission of induction/restoration/Recovery E, active observer and remaining window. Reload/retry views; 401/403 is auth failure, not a passing source drill. G4 requires verified recovery before the next control.

| Step | Exact future command | Expected observation; abort / immediate recovery |
|---|---|---|
| 4.U induce (D10 Yes only; blocked until Phase 0 completed) | `k apply --server-side --field-manager="$PROCEDURE_MANAGER" -f "$U_FAULT"` | No ready Service backends, producer stays Ready; views bounded 503 SOURCE_UNAVAILABLE, safe retry/correlation, no backend details/fixtures. ≤30 s routing + ≤60 s hold; unexpected success, unsafe UI, concurrent drift or budget → 4.U recover. |
| 4.U recover (D10 Yes only) | `k apply --server-side --field-manager="$PROCEDURE_MANAGER" -f "$U_RESTORE"` | Original selector/backend; two four-view 200 probes ≥5 s apart and restored UI within ≤120 s. Failure → Recovery E after owner resolves Service artifact conflict; never force. |
| 4.S induce | `k apply --server-side --field-manager="$PROCEDURE_MANAGER" -f "$S_FAULT"` | D3 Yes: latency-control limitation must be accepted. D3 No: this latency command is not the observation-age drill; add reviewed observation-age induction/restoration artifacts, exact commands, expected age/qualification and recovery budget once the code exists, before execution approval. Until then 4.S is blocked. Current code: measured response age strictly >1 ms yields 200/Stale + SOURCE_STALE; Overview banner (`bff/adapters/openKubesObservedState.mjs:311`, `:330`; `src/App.tsx:100`). No claim of stale-observation proof. ≤180 s rollout + ≤60 s hold; absent qualification, unsafe results or budget → 4.S recover. |
| 4.S recover | `k apply --server-side --field-manager="$PROCEDURE_MANAGER" -f "$S_RESTORE"` | Original absent override, same pair/epoch/auth revision; two 200/Current probes ≥5 s apart, UI restored, ≤180 s. Failure → Recovery E. |
| 4.T induce | `k apply --server-side --field-manager="$PROCEDURE_MANAGER" -f "$T_FAULT"` | No-new-image differential control: same Service, producer Ready, only URL hostname changes to the same Service’s ClusterIP: `https://10.96.49.233:8443/api/console-observed-state/v0alpha2`. Read-only IP-SAN precheck: `k get certificate observed-state-producer-server -o jsonpath='{.spec.dnsNames}{"\n"}{.spec.ipAddresses}{"\n"}'` must show DNS names and no IP addresses; owner must attest the served leaf matches that Certificate before induction; no new route/resources. Generic 503 + safe UI is expected but inconclusive alone. ≤180 s rollout + ≤60 s hold; routing ambiguity, auth failure or unsafe result → 4.T recover. |
| 4.T recover | `k apply --server-side --field-manager="$PROCEDURE_MANAGER" -f "$T_RESTORE"` | Original hostname; same Service/Ready producer/pair/config, restored views 200 within **180 s of restoration apply**, including rollout, two controls ≥5 s apart, UI restored. Failure → Recovery E. Differential evidence supports only the explicitly accepted limitation; full trust discriminator requires code included before the single C1/P1 freeze; acceptance waits. |

## Phase 5 — R6 rollback/forward and profile recovery; G5

AC10: “AC10. Rollback and task-scoped cleanup are demonstrated.”

Before each transition, prepare fresh valid-before fixed-header session and parked flow as above; remaining window and timed-flow budget must suffice. Re-run gate admission for next artifacts, paired restoration and Recovery E. All commands below **CHANGE ok-shared**.

| Step | Exact future command | Expected observation; abort / immediate recovery |
|---|---|---|
| 5.1 rollback | `k apply --server-side --field-manager="$PROCEDURE_MANAGER" -f "$PR_MANIFEST"`, then `k apply --server-side --field-manager="$PROCEDURE_MANAGER" -f "$CR_ROLLBACK"` | Distinct compatible CR/PR; fresh ledger epoch; Q1–Q3/204 and authenticated hosting-cluster views; prior contexts rejected. ≤180 s per Deployment; incompatibility/readiness/auth failure → 5.2 only if known healthy, otherwise Recovery E. No schema downgrade. |
| 5.2 forward | `k apply --server-side --field-manager="$PROCEDURE_MANAGER" -f "$P1_MANIFEST"`, then `k apply --server-side --field-manager="$PROCEDURE_MANAGER" -f "$C1_FORWARD"` | Original frozen C1/P1, unused epoch; Q1–Q3/204, fresh OIDC works, rollback contexts rejected. ≤180 s each; failure → Recovery E. |
| 5.3 bootstrap | `k apply --server-side --field-manager="$PROCEDURE_MANAGER" -f "$R1_BOOTSTRAP_MANIFEST"` | Requires plan's explicit bootstrap-on-breakglass-build decision. Same C1/P1, OIDC=false/bootstrap mode, unused epoch; approved bootstrap login/reason audited; prior contexts rejected. ≤180 s. Unusable recovery access, unexpected profile or acceptance of old context → Recovery E; no assumption of private-only exposure. |
| 5.4 post-recovery | `k apply --server-side --field-manager="$PROCEDURE_MANAGER" -f "$R1_POST_MANIFEST"` | Same C1/P1, OIDC-primary/breakglass, unused final epoch; old/bootstrap sessions and flows denied; new OIDC login/restore/logout/replay across both replicas and four views pass. ≤180 s; failure → Recovery E. |
| G5 | Normal logout of all task sessions; close pending flows; stop any approved capture. | Test sessions unusable, final profile stable. Missing flow/expiry accounting keeps G5 open. No claim that physical rows were deleted. |

## Phase 6 — count-only cleanup evidence and final verification; G6

DB owner uses an approved read-only SQL entrypoint with credentials delivered privately; no Pod exec, ad hoc runner or credential extraction. Resolve aliases to approved rendered **retired** task epoch values from the ledger; before querying, record per-epoch lower bounds for retained session rows and unconsumed transaction rows from successful issuance/flow controls, accounting for known consumption and documented retention. Literal aliases, foreign/active identifiers or missing lower bounds block the query; unexpected zero totals when the ledger expects rows are a failure, not cleanup success. Substitute only those values; do not query active epochs or output row identities. These queries count retained/expired/unusable state; they do not delete it.

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

Column/expiry contracts: `bff/security/postgres/001_console_sessions.sql:11-22`; `bff/security/postgres/002_oidc_transactions.sql:5-8`. Epoch retirement prevents use even before expiry; record aggregate counts immediately and after expiry, distinguish retained rows from usable sessions. Never report retained rows as physically removed. Final-epoch test sessions use normal logout; close abandoned flows and wait at least their 300 s TTL after the last start, without an active-epoch DB scan.

| Step | Future read-only check / normal browser action | Expected observation; abort / recovery |
|---|---|---|
| 6.1 | Count-only retired-epoch queries above, fixed-header rejection evidence and expiry timing. | Retired contexts rejected; elapsed expiry recorded. Unexpired count may be nonzero before expiry; recheck after expiry for zero. SQL error or unexpected count keeps evidence pending, no cleanup mutation. |
| 6.2 | Repeat Q7 retained inventory; compare approved baseline name/UID/owner set. | No disposable objects are created by these Deployment/Service controls; expected controller changes are Pod, ReplicaSet, CertificateRequest, CiliumEndpoint and Endpoints/EndpointSlice churn/renewal, attributed to their retained owners. Endpoints/EndpointSlices are checked separately by Q4 and excluded from retained inventory; certificate renewal is not an unexplained delta. Check ownership and health; unrelated or unaccounted deltas still stop the gate. Retain namespace, DB/PVC, certificates, Secret references, RBAC and audit. Unexpected object delta → stop and investigate; any removal requires a separate reviewed procedure. |
| 6.3 | Repeat Q1–Q9, canonical public TLS/204 checks and final R1/R5; then normal logout and wait pending-flow TTL. | C1/P1 stable, final approved epoch/profile, original Service/URL/stale default, drift decision applied, all faults/capture stopped; unauthenticated protected reads 403/session 401. No reopening action: Ingress stayed present. Failure → active-fault restore/Recovery E as appropriate. |
| 6.4 / G6 | At final gate, repeat Recovery E admission; prepare sanitized evidence for the final hash after closing step 6.5; observer records results/timing and announcement. | Retained infrastructure healthy, no unexplained residue; count/expiry evidence accurately scoped. Missing result keeps gate open. Final baseline is C1/P1 OIDC-primary/breakglass, not the abort pair. |


### 6.5 — closing handoff, then release the freeze

On every exit (success after G6, global abort, Recovery E or partial Phase-0 handoff), keep writers frozen until this closing path passes. Use the actual approved healthy exit pair/profile/current active epoch: C1/P1 on success, approved recovery pair on abort. If health or ownership cannot be restored, retain the freeze and escalate; never unfreeze a partial handoff. On D10 Yes, ok-170-acceptance still owns changed values, so an ordinary non-forced OK-172 promotion conflicts. The current forced verifier (`deploy/kubernetes/verify-ok-shared-live.sh:65`) would reclaim them and restore main’s overlay digest/E0 (retired; `deploy/kubernetes/overlays/ok-shared-live/kustomization.yaml:18`, `:53-56`). Before **any verifier run**, land the reviewed overlay aligned to the actual healthy exit digests, active epoch/auth revision, profile and retained configuration; prepare a complete non-forced dry-run without running that verifier. No new image or retired epoch may be introduced.

| Step | Future command / requirement | Required observation; abort |
|---|---|---|
| 6.5a CHANGES ok-shared (D10 Yes only) | `k apply --server-side --dry-run=server --field-manager=ok-172-live --show-managed-fields -f "$HANDBACK_ADOPT" -o json`, then approved `k apply --server-side --field-manager=ok-172-live -f "$HANDBACK_ADOPT"` | On each actually touched object, adopt every field owned by ok-170-acceptance at the actual healthy exit values, not only selected drill fields; preserve spec/generation/order via Q3 preserve mode. This also reverses partial handoff safely. Render from the aligned exit overlay; Q3 shows intended co-ownership. Unexpected delta blocks apply/unfreeze. |
| 6.5b CHANGES ok-shared (D10 Yes only) | `k apply --server-side --dry-run=server --field-manager=ok-170-acceptance --show-managed-fields -f "$HANDBACK_RELEASE" -o json`, then approved `k apply --server-side --field-manager=ok-170-acceptance -f "$HANDBACK_RELEASE"` | Derive release from the overlay ok-170-acceptance last applied and omit **all** fields it owns (identity-only artifact). Q3 release mode requires spec/generation/order equality and zero new ownership; require no remaining ok-170-acceptance managedFields entry on all touched objects. Never release before persisted full adoption by ok-172-live. |
| 6.5c read-only | Q1–Q6; non-forced dry-run of final aligned OK-172 manifests, Q3 complete ownership comparison, continuity ledger | Actual exit values unchanged; no ok-170-acceptance entry on any of the four objects, final changed-value owner ok-172-live. Non-forced changed-value dry-run under ok-172-live must admit a reviewed harmless image/epoch variation, then verify unchanged exit artifact admission; do not persist the variation. Require overlay alignment. ≤60 s inspection per object. Any failure retains freeze and escalates ownership repair; no force/imperative workaround. On success, OK-172 owners may release freeze. D10 No skips ownership transfer but still requires exit overlay alignment, admission and continuity before unfreezing. After closing evidence is captured, hash the complete sanitized record with `sha256sum docs/evidence/ok-170/*.json docs/evidence/ok-170/*.md`; record closing dry-runs/applies/ownership results too. |

## Global abort and evidence boundary

Stop induction/tests at approval/window/budget expiry, lost observer/recovery owner/API access, generation/resourceVersion movement without a procedure apply, concurrent reconciliation, unapproved drift, unrelated degradation, readiness/quota/DB/audit/IdP failure, accepted invalid context, auth/TLS bypass, fixture fallback, missing consumed-response correlation or unsafe output. Execute the active fault's paired restoration first even if rollout is incomplete, then Recovery E for image/profile failure. A conflict stops the phase and requires reviewed reconciliation; never force a later artifact or issue an imperative edit; ownership changes require the separate Phase-0 approval. Keep Ingress present, announce impaired service and escalate failed recovery to Arash. Every termination routes through closing step 6.5 with the actual healthy exit configuration; partial ownership handoff must be reversed before unfreeze. Do not call service restored until pair/profile/health/auth and old-context denial are verified.

Record UTC/step/approval, operator/observer, exact sanitized commands/status/error codes, manifest hashes, source/pair/profile, generations/owner chains/app imageIDs, non-sensitive epoch/revision ledger, consumed-response fields/correlation, cookieSent booleans, callback/session elapsed times, transactionCookieSent booleans, same-epoch session/flow controls, UI observations, recovery timing, aggregate retired-epoch counts/expiry and retained inventory. Preserve sanitized evidence with SHA-256 immediately in the approved evidence record. Never persist Secret values/hashes, tokens, cookies, CSRF, codes/state/nonce/PKCE, credential names, callback parameters, raw objects/logs, HAR, storage dumps or browser traces. No macOS access is available; Arash must verify macOS-only browser behavior.

**Scope of this evidence:** Applies to the approved frozen pair/profile/window; Shown in the eventual recorded phase observations; Follow-ups remain in the [acceptance plan](acceptance-plan.md). Read-only baseline facts establish planning inputs only.
