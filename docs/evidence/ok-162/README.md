# OK-162 controlled observed-state integration

This evidence records the first real HTTP OpenKubes observed-state path behind
the Console BFF source interface.

## Controlled environment

`bff/openKubesObservedState.test.ts` starts two independent loopback servers:

1. a controlled OpenKubes query endpoint serving the versioned
   `ConsoleObservedState` envelope;
2. the real Console BFF configured with `OpenKubesObservedStateAdapter`.

The test requests Session, Overview, Cluster list, Cluster detail and Evidence
through HTTP and validates every resulting Presentation Contract response.

## Security and resilience evidence

- The adapter copies only explicitly allowed observed-state fields.
- Injected credential and raw Kubernetes fields are discarded before the
  presentation layer.
- External plaintext HTTP endpoints are rejected; loopback HTTP remains
  available for controlled integration tests.
- Query timeout and response size are bounded.
- Invalid query contracts fail closed as a redaction-safe, retryable BFF error.
- Freshness is derived from `observedAt` and a configured local threshold.
- Partial observations produce a safe warning; upstream diagnostic strings are
  ignored.
- Runtime source selection is explicit and has no silent fixture fallback.

## Runtime and rollback

The configuration and explicit fixture rollback procedure are documented in
`bff/README.md` and `.env.example`. Upstream identity and credential transport
remain intentionally deferred to OK-163.
