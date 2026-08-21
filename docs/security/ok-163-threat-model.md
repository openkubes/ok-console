# OK-163 Console authentication threat model

Status: **Implementation input — independent security review pending**

This threat model applies ADR-Platform-037 to the Console BFF, browser session,
OIDC provider, observed-state producer and exceptional local access. The React
login simulation is excluded from the trusted computing base.

## Assets and trust boundaries

| Asset | Trust boundary | Required property |
| --- | --- | --- |
| OIDC code, verifier and provider tokens | IdP ↔ BFF callback | Server custody, one-time use, exact issuer/audience/redirect/state/nonce/PKCE validation |
| Opaque Console session | Browser ↔ BFF | Secure, HttpOnly, SameSite cookie; origin binding, rotation, expiry and revocation |
| Stable subject mapping | Identity mapper ↔ authorization | Trusted provider ID plus issuer-scoped subject; no email/display-name authority |
| Tenant/environment membership | Session store ↔ point-of-use evaluator | Exact current scope; ambiguity and removal fail closed |
| CSRF secret | Browser form/header ↔ BFF | Bound to session and origin; required in addition to SameSite for mutations |
| Observed state | BFF ↔ producer | TLS, explicit trust root and workload identity; read-only authorization |
| Break-glass credential and reason | Operator ↔ local verifier | Disabled by default, memory-hard verifier, rate limit, MFA where sustainable, short session and audit |
| Authentication Evidence | BFF ↔ audit store | Correlatable but no credentials, tokens, codes, cookies or unnecessary claims |

## Primary threats and controls

| Threat | Control and negative evidence |
| --- | --- |
| Session fixation or stolen cookie | Rotate after authentication/privilege change; opaque revocable reference; Secure/HttpOnly/SameSite; expiry tests |
| CSRF on future mutations | Origin validation plus session-bound CSRF token; missing/mismatched token denied |
| XSS steals provider tokens | Provider tokens never reach browser JavaScript or browser storage; CSP remains a defense-in-depth follow-up |
| Forged or confused-provider identity | Server-configured issuer only; signature/algorithm/audience/azp/time/nonce/state/PKCE validation |
| Email/group claim privilege escalation | Stable provider-scoped subject mapping; explicit reviewed mapping; unknown or conflicting membership denied |
| Cross-tenant/environment access | Scope is bound into the server context and rechecked at point of use |
| Expired, revoked or stale membership continues | Idle and absolute expiry plus server revocation; no outage-based extension |
| Authentication becomes operation authority | Evaluator checks exact permission/scope/assurance; later mutation still traverses Policy, Authority and execution |
| Producer impersonation or observation interception | HTTPS with explicit CA and workload identity; no plaintext shared-service exception |
| Break-glass becomes everyday fallback | Independently disableable, reason-bound, shorter expiry, rate limiting, high-signal Evidence and periodic review |
| Error/log/support-bundle credential leak | Normalized unauthenticated errors and recursive forbidden-field tests; never log headers or secret material |

## Security decisions still requiring implementation evidence

1. OIDC library/provider interoperability, JWKS rotation and negative tokens.
2. Session-store durability, encryption, key rotation and revocation propagation.
3. Cookie issuance/logout and CSRF/origin implementation.
4. TLS certificate issuance and workload identity for the producer path.
5. Identity/group mapping lifecycle and removal behavior.
6. Break-glass hashing parameters, MFA, credential custody and offline recovery.
7. Audit/Evidence retention and privacy access policy.

## Implemented evidence

The first server-side session slice covers opaque cookie references, hashed
store keys, rotation, shorter exceptional-session expiry, idle and absolute
expiry, revocation, cookie-smuggling rejection and origin-plus-token CSRF
checks. The current store is in-memory and therefore deliberately not accepted
for multi-replica production use or durable revocation.

The HTTP boundary now provides authenticated inspection, rotation and logout.
It keeps the opaque session reference in an HttpOnly cookie, delivers the
session-bound CSRF value in a separate readable Secure cookie, requires the
value in a header together with an exact configured Origin for both mutations,
and clears both cookies after invalid session detection or logout. It does not
offer a browser-driven session creation endpoint.

None of these is satisfied by the graphical prototype or by the v0alpha1 data
shapes alone.
