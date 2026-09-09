import { createServer } from 'node:http'
import { createConsoleBffHandler } from './app.mjs'
import { createObservedStateSource } from './source.mjs'
import { createSessionRuntime } from './security/runtime.mjs'
import { createRuntimeHttpHandler } from './runtimeHttp.mjs'
import { createClusterDryRunHttpAdapter } from './adapters/createClusterDryRun.mjs'

const host = process.env.OK_CONSOLE_BFF_HOST ?? '127.0.0.1'
const port = Number.parseInt(process.env.OK_CONSOLE_BFF_PORT ?? '8787', 10)
const enableFailureInjection = process.env.OK_CONSOLE_BFF_ENABLE_FAILURE_INJECTION === 'true'
const sourceMode = process.env.OK_CONSOLE_OBSERVED_STATE_MODE ?? 'fixture'
const sessionRuntime = await createSessionRuntime()
const dryRunExecutor = process.env.OK_CONSOLE_DRY_RUN_URL
  ? createClusterDryRunHttpAdapter({ url: process.env.OK_CONSOLE_DRY_RUN_URL })
  : null

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('OK_CONSOLE_BFF_PORT must be an integer between 1 and 65535.')
}

const apiHandler = createConsoleBffHandler({
  source: createObservedStateSource(),
  ...(sessionRuntime.authorizer ? { authorizer: sessionRuntime.authorizer } : {}),
  sessionStore: sessionRuntime.sessionStore,
  expectedOrigin: sessionRuntime.expectedOrigin,
  oidcHandler: sessionRuntime.oidcHandler,
  localAccessHandler: sessionRuntime.localAccessHandler,
  enableFailureInjection,
  dryRunExecutor,
  requestObserver: ({ method, pathname, correlationId }) => {
    console.log(`${method} ${pathname} · ${correlationId}`)
  },
})
const server = createServer(createRuntimeHttpHandler({ apiHandler, readiness: sessionRuntime.ready }))

server.listen(port, host, () => {
  console.log(`OpenKubes Console runtime listening on http://${host}:${port}`)
  console.log(`Observed-state source: ${sourceMode}`)
  console.log(`Failure injection: ${enableFailureInjection ? 'enabled' : 'disabled'}`)
  console.log(`Session store: ${sessionRuntime.mode}`)
})

let shuttingDown = false
const shutdown = (signal) => {
  if (shuttingDown) return
  shuttingDown = true
  server.close((error) => {
    if (error) {
      console.error(error)
      process.exitCode = 1
    }
    sessionRuntime.close()
      .catch((closeError) => {
        console.error(closeError)
        process.exitCode = 1
      })
      .finally(() => console.log(`OpenKubes Console BFF stopped after ${signal}.`))
  })
}

process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))
