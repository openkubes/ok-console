import { buildModes, startHarness, stopHarness } from './harness.mjs'

// startHarness installs SIGINT/SIGTERM cleanup before anything starts; Playwright runs the
// returned function as global teardown.
export default async function globalSetup() {
  buildModes()
  const { state, proxies, dispose } = await startHarness()
  let stopping
  return () => (stopping ??= stopHarness(state, proxies).finally(dispose))
}
