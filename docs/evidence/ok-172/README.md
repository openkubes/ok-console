# OK-172 hosting-cluster observation evidence

Status: **Phase-B1 verified; intentionally bounded observation scope**

Date: 2026-10-20

## Scope

The live `ok-shared` deployment runs the observed-state producer in
`hosting-cluster` mode. It observes only the hosting cluster (`ok-shared`) and
the Console workload in `openkubes-console`. It does not claim an observation
of the OpenKubes management plane (`ok-mgmt`) or any management-plane
capabilities.

This boundary is deliberate: the producer has no management-plane source
configured in this slice, so the Console must preserve unknown state rather
than infer readiness.

## Expected presentation

The Console therefore presents:

- `ok-shared` as Ready, with the observed Kubernetes version and node evidence;
- `ok-mgmt` as Unknown / not observed by the hosting-cluster source;
- a `Platform data is partially degraded` banner;
- zero fabricated capabilities, workload claims, or findings for the missing
  management-plane observation.

The degraded banner is an honest presentation of source coverage, not a
producer health failure.

## Verification

The following checks passed against `ok-shared-admin@ok-shared`:

```text
Producer /healthz: 200
Observed-state endpoint: 200
Console replicas: 2/2 Ready
OK-172 live verifier: passed
Console image: ghcr.io/openkubes/ok-console@sha256:e54efd5e3901160309709d49eb7c99f8a34f82208f70ff7addf54500b2f6b2d4
Producer image: ghcr.io/openkubes/observed-state-producer@sha256:9f239237c4f5b51815e61a537b24d2da7aa7b3b6092d84b1422362d2a1fe6297
```

The next scope expansion is a separately reviewed management-plane source;
until then, `ok-mgmt: Unknown` and the partial-data banner are the accepted
contract.
