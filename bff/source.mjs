import { FixtureObservedStateAdapter } from './adapters/fixtureObservedState.mjs'
import { OpenKubesObservedStateAdapter } from './adapters/openKubesObservedState.mjs'

const positiveInteger = (value, fallback, name) => {
  const parsed = Number.parseInt(value ?? String(fallback), 10)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`)
  return parsed
}

export const createObservedStateSource = (environment = process.env, options = {}) => {
  const mode = environment.OK_CONSOLE_OBSERVED_STATE_MODE ?? 'fixture'
  if (mode === 'fixture') return new FixtureObservedStateAdapter(options.fixtureUrl)
  if (mode !== 'openkubes') throw new Error('OK_CONSOLE_OBSERVED_STATE_MODE must be fixture or openkubes.')
  if (!environment.OK_CONSOLE_OBSERVED_STATE_URL) throw new Error('OK_CONSOLE_OBSERVED_STATE_URL is required in openkubes mode.')

  return new OpenKubesObservedStateAdapter({
    url: environment.OK_CONSOLE_OBSERVED_STATE_URL,
    timeoutMs: positiveInteger(environment.OK_CONSOLE_OBSERVED_STATE_TIMEOUT_MS, 5_000, 'OK_CONSOLE_OBSERVED_STATE_TIMEOUT_MS'),
    staleAfterMs: positiveInteger(environment.OK_CONSOLE_OBSERVED_STATE_STALE_AFTER_MS, 300_000, 'OK_CONSOLE_OBSERVED_STATE_STALE_AFTER_MS'),
    fetchImpl: options.fetchImpl,
    now: options.now,
  })
}
