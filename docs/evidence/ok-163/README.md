# OK-163 security acceptance record

Status: **Ready for independent review — recommended disposition: REVISE for production**

- Implementation DRI: Arash Kaffamanesh
- Independent security/backend reviewer: Suchit Thakkar

This record assembles the review surface for OK-163. `REVISE` does not reject
the architecture: it means the implementation evidence is sufficient for
independent review, while provider and deployment operations are not yet proven
for production.

## Jira acceptance matrix

| Acceptance criterion | Evidence | Current result |
| --- | --- | --- |
| Reviewed threat model and security architecture exist | [`ok-163-threat-model.md`](../../security/ok-163-threat-model.md), ADR-Platform-037 and ADR-Platform-038 | Implementation complete; independent reviewer decision pending |
| Production session and authorization contract is versioned | [`auth.console.openkubes.io/v0alpha1`](../../../contracts/security/v0alpha1/README.md), PostgreSQL store and HTTP boundary under `bff/security` | Pass for the reviewed v0alpha1 boundary |
| Negative tests cover privilege expansion, expired sessions, and cross-tenant access | `bff/security/authorization.test.ts`, session/store conformance tests, GitHub PostgreSQL service | Pass in CI |
| No production auth claim is inferred from the prototype | Explicit `prototype`, `oidc`, `bootstrap`, and `breakglass` modes; live modes require BFF data; unknown modes fail startup | Pass |

## Scope evidence

| OK-163 scope | Implemented evidence | Remaining production evidence |
| --- | --- | --- |
| OIDC server-side session boundary | Authorization Code + PKCE, State, Nonce, one-time encrypted PostgreSQL transaction, stable subject mapping | Target-provider interoperability and adversarial tokens |
| Tenant/environment and point-of-use permission binding | Versioned authorization context, current revision check, explicit permission/environment/tenant evaluation | Identity-policy publication and removal drill |
| CSRF, cookie, expiry, logout, and audit | Secure opaque cookies, exact Origin + session-bound CSRF, idle/absolute expiry, family revocation, exceptional-access audit; OK-166 same-origin static security headers and empty health probes | Gateway policy inspection, retention, alerting, restore/failover exercise |
| Break-glass failure modes | Disabled-by-default Bootstrap/BreakGlass modes, same KDF for unknown users, principal/global PostgreSQL throttle, audit-fail-closed behavior | Credential custody, recovery drill, MFA feasibility, operator review cadence |
| Keep credentials/tokens out of browser storage | Provider tokens remain server-side; local password is submitted once and cleared after every outcome | Browser/gateway/support-bundle operational inspection |
| Deployment and secret management | [`ok-163-deployment-profile.md`](../../security/ok-163-deployment-profile.md); OK-166 non-root image recipe and fail-closed Kubernetes scaffold; OK-168 explicit producer CA and Console BFF mTLS workload-identity profile | Release provenance, real digest/overlays, independent OK-168 review, certificate rotation/revocation, target-cluster enforcement and exercises |

## Reviewer checklist

Suchit should record one decision with findings linked to code or documents:

1. Are the browser, edge, BFF, identity provider, PostgreSQL, producer, and audit
   trust boundaries complete?
2. Do session rotation/revocation and authorization-revision behavior fail closed
   under concurrency, failover, and restore?
3. Can any provider claim, browser field, or backend field expand identity,
   tenant, environment, permission, or assurance?
4. Are Bootstrap/BreakGlass enablement, enumeration resistance, throttle, audit,
   and recovery controls proportionate?
5. Is the deployment profile sufficient to begin image/manifests and operational
   exercises without silently inventing trust?
6. Record **GO**, **REVISE**, or **STOP**, with blocking findings explicitly
   separated from later hardening recommendations.

## Decision rule

- **GO**: OK-163 architecture and implementation are accepted for the next
  deployment-validation tasks. This is not itself production approval.
- **REVISE**: specific security findings must be corrected and re-reviewed.
- **STOP**: the proposed boundary is unsafe or unsuitable and must be redesigned.

The Jira issue must remain **In Progress** until the independent decision is
recorded. Production readiness remains **REVISE** until every gate in the
deployment profile has executable evidence.
