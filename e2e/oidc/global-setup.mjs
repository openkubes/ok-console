import { buildModes, startHarness, stopHarness } from './harness.mjs'

// Playwright runs the returned function as global teardown; signals take the same path so an
// interrupted run still removes the compose project, its volumes and the temp directory.
export default async function globalSetup() {
  buildModes()
  const { state, proxies } = await startHarness()
  let stopping
  const stop = () => (stopping ??= stopHarness(state, proxies))
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { stop().finally(() => process.exit(130)) })
  return stop
}
