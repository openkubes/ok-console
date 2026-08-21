# OK-159 responsive acceptance evidence

This record captures the visual acceptance pass for the Developer B read-only
Console slice in [OK-159](https://kubernauts.atlassian.net/browse/OK-159).

## Verified journeys

| Scenario | Viewport | Result | Evidence |
|---|---:|---|---|
| Fixture-backed Platform Overview | 1440 × 1000 | Pass | [Desktop overview](desktop-overview.png) |
| Fixture-backed Platform Overview | 390 × 844 | Pass | [Compact overview](mobile-overview.png) |
| Compact primary navigation | 390 × 844 | Pass | [Compact navigation](mobile-navigation.png) |
| Cluster inventory → `ok-mgmt` detail | 390 × 844 | Pass | [Compact cluster detail](mobile-cluster-detail.png) |
| BFF unavailable → safe retry | 390 × 844 | Pass | [Compact unavailable state](mobile-bff-unavailable.png) |

The compact journeys completed without document-level horizontal overflow. The
overview preserved the management-plane-first ordering (`ok-mgmt`, then `ok-ai`),
and the cluster detail kept the guarded **Open Shell** action reachable. In BFF
mode, an unreachable endpoint produced the bounded `NETWORK_ERROR` state; **Retry
safely** repeated the read-only request and retained the same non-destructive
fallback.

## Reproduce

Fixture mode:

```bash
pnpm dev
```

BFF-unavailable mode (with no service listening at the configured same-origin
endpoint):

```bash
VITE_CONSOLE_DATA_MODE=bff pnpm dev
```

Then complete the prototype OIDC journey and verify the pages at desktop and
compact viewports. Automated coverage is provided by `pnpm lint`, `pnpm test`,
`pnpm test:contract`, and `pnpm build`.

## Remaining integration boundary

This evidence validates the Console-owned adapter, responsive presentation, and
failure behavior. End-to-end validation against Developer A's real OK-158 Console
BFF remains an integration activity after its endpoint is available and the
shared OK-160 Presentation Contract handshake is complete.
