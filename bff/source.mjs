import { FixtureObservedStateAdapter } from './adapters/fixtureObservedState.mjs'
import { OpenKubesObservedStateAdapter } from './adapters/openKubesObservedState.mjs'
import { createObservedStateMtlsFetchFromFiles } from './adapters/mtlsFetch.mjs'

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
  const sourceUrl = new URL(environment.OK_CONSOLE_OBSERVED_STATE_URL)
  const loopbackHttp = sourceUrl.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(sourceUrl.hostname)
  const fetchImpl = options.fetchImpl ?? (loopbackHttp ? fetch : createObservedStateMtlsFetchFromFiles({
    caFile: environment.OK_CONSOLE_OBSERVED_STATE_CA_FILE,
    certificateFile: environment.OK_CONSOLE_OBSERVED_STATE_CLIENT_CERT_FILE,
    privateKeyFile: environment.OK_CONSOLE_OBSERVED_STATE_CLIENT_KEY_FILE,
  }))

  return new OpenKubesObservedStateAdapter({
    url: sourceUrl,
    timeoutMs: positiveInteger(environment.OK_CONSOLE_OBSERVED_STATE_TIMEOUT_MS, 5_000, 'OK_CONSOLE_OBSERVED_STATE_TIMEOUT_MS'),
    staleAfterMs: positiveInteger(environment.OK_CONSOLE_OBSERVED_STATE_STALE_AFTER_MS, 300_000, 'OK_CONSOLE_OBSERVED_STATE_STALE_AFTER_MS'),
    fetchImpl,
    now: options.now,
  })
}
