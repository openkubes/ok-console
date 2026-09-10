# OK-168 observed-state workload identity evidence

Status: **implementation candidate — independent review pending**

## Trust boundary

The Console BFF and observed-state producer use a deliberately narrow mutual
TLS profile:

- the BFF trusts only the configured producer CA and verifies the Service DNS
  identity;
- the BFF presents a client certificate and private key loaded from bounded,
  read-only mounted files;
- the producer trusts only its configured client CA and authorizes the exact
  `spiffe://openkubes.io/ns/openkubes-console/sa/ok-console` URI SAN;
- TLS 1.2 is the minimum on both sides;
- the versioned query remains GET-only, bounded and redaction-safe; and
- TLS or identity failure never falls back to fixtures.

NetworkPolicy narrows reachability but does not substitute for identity. The
HTTPS health endpoint exposes no observed state and accepts no credentials.

## Executable evidence

The producer suite proves valid, missing, different, untrusted and wrong-purpose
client certificates. The Console suite starts a real certificate-authenticated
HTTPS server and proves client-certificate presentation, explicit-CA server
verification, hostname verification and missing-file startup rejection.

Repository review surfaces:

- producer: `openkubes/openkubes` PR #311;
- Console client: this repository's OK-168 PR;
- Kubernetes Secret/file contract: `deploy/kubernetes/base/deployment.json`;
- producer TLS/identity contract:
  `platform/console/observed-state-producer` in `openkubes/openkubes`.

## Honest remaining boundary

The tests use ephemeral, test-only certificate authorities. They prove protocol
and policy behavior, not production CA custody. A production claim still needs
reviewed certificate issuance, rotation overlap, revocation behavior, expiry
alerting, target-cluster NetworkPolicy enforcement and recovery exercises.
