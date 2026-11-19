import { buildModes, startHarness, stopHarness } from './harness.mjs'

// startHarness installs SIGINT/SIGTERM cleanup before anything starts; Playwright runs the
// returned function as global teardown. stopHarness runs at most once per run.
export default async function globalSetup() {
  buildModes()
  const { state, proxies, dispose } = await startHarness()
  return () => stopHarness(state, proxies).finally(dispose)
}
