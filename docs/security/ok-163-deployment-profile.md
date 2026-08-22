# OK-163 Console security deployment profile

Status: **Candidate production profile — independent review and operational evidence pending**

This profile turns the OK-163 runtime assumptions into deployment requirements.
It is deliberately vendor-neutral and does not claim that a production image,
chart, cluster policy, identity provider, or recovery procedure already exists.

## Required topology

- Publish the browser and `/api/console/v0` under one exact HTTPS origin. Route
  API traffic to the BFF without enabling cross-origin credential requests.
- Keep the BFF Service private. Only the selected Gateway or ingress workload
  may reach its listener; PostgreSQL and the observed-state producer are never
  exposed through the Console route.
- Run every BFF replica against the same PostgreSQL read/write primary. Session,
  OIDC transaction, throttle, and audit correctness must not depend on replica
  memory or clock.
- Preserve the configured public origin through the edge. Do not derive trust
  from unvalidated forwarded headers; edge/IP rate limiting is owned by the
  selected trusted gateway profile.
- Use default-deny ingress and egress, then allow only gateway ingress and the
  required DNS, PostgreSQL, OIDC-provider, and observed-state destinations.
  Confirm that the cluster network implementation actually enforces
  `NetworkPolicy`.

Kubernetes documents that network policies are additive, that default-deny
egress also blocks DNS, and that enforcement depends on the network plugin:
[Network Policies](https://kubernetes.io/docs/concepts/services-networking/network-policies/).

## Workload hardening contract

The Console workload must satisfy the Kubernetes Restricted Pod Security
Standard and additionally declare:

- a dedicated ServiceAccount with automount disabled unless a reviewed workload
  identity mechanism explicitly requires it;
- non-root UID/GID, `allowPrivilegeEscalation: false`, all Linux capabilities
  dropped, and `seccompProfile.type: RuntimeDefault`;
- a read-only root filesystem with bounded writable temporary storage only where
  the selected Node.js/container runtime proves it is required;
- CPU and memory requests/limits sized to include concurrent scrypt work;
- at least two replicas, disruption controls, and topology spreading for a
  production availability claim; and
- startup, readiness, and liveness signals with different semantics. Readiness
  must fail when the replica cannot safely serve sessions; liveness must not
  restart replicas merely because an external identity provider is unavailable.

These requirements follow the upstream
[Pod Security Standards](https://kubernetes.io/docs/concepts/security/pod-security-standards/)
and the documented distinction between
[startup, readiness, and liveness probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-probes/).
OK-166 now provides empty health endpoints, a digest-pinned non-root image recipe,
and an intentionally non-deployable, default-deny Kubernetes base. This is
executable scaffolding for review and target validation; release provenance,
real image digest, target overlays, policy enforcement, and operational exercises
remain production gates.

## Secret contract

Secret values must be mounted as read-only files at the absolute paths configured
in `.env.example`. They must not be placed in Vite variables, command arguments,
ConfigMaps, checked-in manifests, or general-purpose log/event fields.

| Material | Consumer | Rotation rule |
| --- | --- | --- |
| PostgreSQL URL and CA | BFF only | Rotate credentials independently; retain CA overlap until every replica trusts the new chain |
| Session envelope key set | BFF only | Add new key, select it for writes, retain old decrypt keys beyond maximum session/transaction lifetime, then remove |
| OIDC client secret | BFF only | Coordinate overlap/cutover with the provider and verify callback interoperability |
| OIDC subject mapping | BFF only | Review as authority-bearing policy; publish a new authorization revision with every change |
| Local account verifier mapping | BFF only | Keep disabled except reviewed Bootstrap/BreakGlass windows; rotate after use or suspected exposure |
| Local-access HMAC pepper | BFF only | Rotation invalidates throttle/audit correlation; require an explicit evidence-retention decision before cutover |

Namespace RBAC must deny routine human identities and unrelated workloads
`get`, `list`, and `watch` on these Secrets. The secret delivery system must encrypt values at
rest, record access, and support rotation without committing cleartext or
base64-only manifests. See Kubernetes
[Good practices for Secrets](https://kubernetes.io/docs/concepts/security/secrets-good-practices/)
and [RBAC good practices](https://kubernetes.io/docs/concepts/security/rbac-good-practices/).

## PostgreSQL identities and migration ownership

Use separate migration and runtime identities:

- the migration identity owns numbered schema changes and is unavailable to the
  request-serving workload;
- the runtime identity receives only the session/transaction/throttle DML needed
  by the adapters;
- the runtime identity receives `INSERT` only on `local_access_audit`; retention
  and deletion belong to a separately audited operator identity; and
- backups, restores, failover, and key loss must be exercised with the deployment
  epoch. Ambiguous or restored old sessions are invalidated, never extended.

PostgreSQL authorization traffic must use the read/write primary through
verified TLS. A replica must not serve authorization reads.

## Evidence and privacy operations

- Export correlation-ID-bearing authentication, authorization-denial, session
  revocation, and exceptional-access Evidence without headers, cookies,
  credentials, provider tokens, codes, verifiers, or raw issuer subjects.
- Treat the exceptional-access operational reason as sensitive operational data:
  prohibit secrets, restrict readers, and define retention/deletion policy.
- Alert on exceptional-access grants, repeated denials, global throttling,
  authorization revision mismatch, envelope decryption failure, and audit write
  failure.
- Prove that application, gateway, database, and support-bundle logs preserve the
  redaction boundary before production acceptance.

## Production acceptance gates

The following evidence is required before a production claim:

1. independent security review records **GO** for the threat model, contracts,
   implementation, and this deployment profile;
2. provider-specific OIDC discovery, callback, JWKS rotation, logout, and
   adversarial-token tests pass;
3. the OK-168 workload-identity and TLS profile to the observed-state producer
   is independently reviewed, then certificate rotation/revocation is exercised;
4. a digest-pinned, non-root image plus SBOM, provenance/signature, vulnerability
   policy, and reproducible release process exist;
5. deployable manifests pass Restricted Pod Security and effective network-policy
   tests in the target cluster;
6. PostgreSQL migration, failover, restore, key rotation, and authorization-
   revision removal exercises pass; and
7. Bootstrap/BreakGlass credential custody, recovery, disablement, audit review,
   and MFA feasibility are exercised by named operators.

Until every gate is evidenced, the correct disposition is **REVISE**, not a
production-readiness claim.
