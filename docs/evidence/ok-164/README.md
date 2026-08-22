# OK-164 browser and accessibility acceptance record

Status: **Automated evidence candidate — independent review pending**

## Runtime boundary

The suite builds the browser with `VITE_CONSOLE_DATA_MODE=bff` and explicit
prototype authentication, then starts the production-shaped OK-166 runtime on
one origin. Static assets and every `/api/console/v0` request therefore cross
the same HTTP listener. Failure tests rewrite only the query string and still
reach the real BFF failure-injection boundary; they do not fulfill responses in
the browser.

## Reproducible journeys

Both `chromium-desktop` (1440 × 1000) and `chromium-compact` (390 × 844) run:

- prototype sign-in → Overview → Clusters → `ok-mgmt` Detail → Evidence drawer;
- keyboard entry, visible skip link, and focus transfer to the main landmark;
- stale and degraded but usable observations; and
- forbidden, unavailable, and incompatible fail-closed views with bounded
  correlation IDs and no backend diagnostics.

Each primary journey emits `overview.png` and `cluster-evidence.png` into the
Playwright test output. GitHub uploads those screenshots, the HTML report,
axe results, traces, videos, and failure screenshots as the `ok-164-browser-evidence`
artifact even when the job fails.

## Accessibility baseline and fail policy

The automated baseline is **zero axe violations** for WCAG 2.0/2.1 A and AA on
the authenticated Overview and modal Evidence surfaces in both viewports. No
rule or DOM region is excluded. Any reported violation fails CI. Keyboard tests
are a separate mandatory gate because automated scanning cannot prove keyboard
operability or sensible focus behavior.

This is a strict automated baseline, not a full accessibility conformance claim.
Manual screen-reader, zoom/reflow, cognitive, forced-colors, localization, and
assistive-technology testing remain required before such a claim.

## Run locally

```bash
pnpm exec playwright install chromium
pnpm test:e2e
```

The suite owns its local server and refuses committed focused tests in CI.
