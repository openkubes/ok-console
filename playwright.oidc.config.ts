import { defineConfig } from '@playwright/test'

// OK-173 disposable OIDC proof. Opt-in (`pnpm test:e2e:oidc`), needs Docker; never part of
// `pnpm test:e2e`. Specs use the *.oidc.ts suffix so the default config's testMatch skips them.
// The Console origin is chosen at run time by the harness, so specs read it from harness state.
export default defineConfig({
  testDir: './e2e/oidc',
  testMatch: '**/*.oidc.ts',
  outputDir: 'test-results/e2e-oidc/artifacts',
  globalSetup: './e2e/oidc/global-setup.mjs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 120_000,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report-oidc', open: 'never' }]],
  expect: { timeout: 15_000 },
  use: {
    browserName: 'chromium',
    viewport: { width: 1440, height: 1000 },
    // Browser-side only: the test CA is not installed in Chromium. The BFF validates the issuer
    // certificate itself through NODE_EXTRA_CA_CERTS.
    ignoreHTTPSErrors: true,
    colorScheme: 'light',
    locale: 'en-US',
    timezoneId: 'UTC',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'oidc-breakglass', testIgnore: /rollback\.oidc\.ts$/ },
    { name: 'rollback', testMatch: /rollback\.oidc\.ts$/, dependencies: ['oidc-breakglass'] },
  ],
})
