import { defineConfig } from '@playwright/test'
import { brandingE2eTargets } from './e2e/branding/targets'

// Minimal browser E2E for per-installation branding and the deployment policy (MVP-0, slice 1). One BFF
// per variant on its own port, all serving the same build: the built-in default, the default under
// fixture-read-only, and every directory listed in
// OK_CONSOLE_E2E_BRANDING_DIRS (colon-separated, absolute). Without that variable the synthetic test
// brand in src/branding/test-fixtures/example is used, so the suite needs nothing outside this repo.
export default defineConfig({
  testDir: './e2e/branding',
  outputDir: 'test-results/e2e-branding',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: [['list']],
  expect: { timeout: 10_000 },
  use: {
    colorScheme: 'light',
    locale: 'en-US',
    reducedMotion: 'reduce',
    screenshot: 'only-on-failure',
    timezoneId: 'UTC',
    viewport: { width: 1440, height: 900 },
  },
  webServer: brandingE2eTargets().map((target) => ({
    command: `node bff/server.mjs`,
    env: {
      OK_CONSOLE_DEV_PROTOTYPE_ENABLED: 'true',
      OK_CONSOLE_BFF_HOST: '127.0.0.1',
      OK_CONSOLE_BFF_PORT: String(target.port),
      ...(target.dir ? { OK_CONSOLE_BRANDING_DIR: target.dir } : {}),
      ...(target.policy ? { OK_CONSOLE_DEPLOYMENT_POLICY: target.policy } : {}),
    },
    url: `http://127.0.0.1:${target.port}/health/ready`,
    reuseExistingServer: false,
    timeout: 30_000,
  })),
  projects: [{ name: 'chromium-desktop', use: { browserName: 'chromium' } }],
})
