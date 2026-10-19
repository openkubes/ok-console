import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { createConsoleBffHandler, prototypeAuthorizer } from './app.mjs'
import { createObservedStateSource } from './source.mjs'
import { createSessionRuntime } from './security/runtime.mjs'
import { createRuntimeHttpHandler } from './runtimeHttp.mjs'
import { createClusterDryRunHttpAdapter } from './adapters/createClusterDryRun.mjs'

export const createConsoleServer = async ({
  env = process.env,
  serverFactory = createServer,
  sessionRuntimeFactory = createSessionRuntime,
  sourceFactory = createObservedStateSource,
  runtimeHttpFactory = createRuntimeHttpHandler,
  dryRunFactory = createClusterDryRunHttpAdapter,
} = {}) => {
  const host = env.OK_CONSOLE_BFF_HOST ?? '127.0.0.1'
  const port = Number.parseInt(env.OK_CONSOLE_BFF_PORT ?? '8787', 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('OK_CONSOLE_BFF_PORT must be an integer between 1 and 65535.')
  }

  const sessionRuntime = await sessionRuntimeFactory({ env })
  const dryRunExecutor = env.OK_CONSOLE_DRY_RUN_URL
    ? dryRunFactory({ url: env.OK_CONSOLE_DRY_RUN_URL })
    : null
  const apiHandler = createConsoleBffHandler({
    source: sourceFactory(env),
    ...(sessionRuntime.prototypeEnabled ? { authorizer: prototypeAuthorizer } : {}),
    ...(sessionRuntime.authorizer ? { authorizer: sessionRuntime.authorizer } : {}),
    sessionStore: sessionRuntime.sessionStore,
    expectedOrigin: sessionRuntime.expectedOrigin,
    oidcHandler: sessionRuntime.oidcHandler,
    localAccessHandler: sessionRuntime.localAccessHandler,
    enableFailureInjection: env.OK_CONSOLE_BFF_ENABLE_FAILURE_INJECTION === 'true',
    dryRunExecutor,
    requestObserver: ({ method, pathname, correlationId }) => {
      console.log(`${method} ${pathname} · ${correlationId}`)
    },
  })
  const server = serverFactory(runtimeHttpFactory({ apiHandler, readiness: sessionRuntime.ready }))
  return { server, sessionRuntime, host, port, sourceMode: env.OK_CONSOLE_OBSERVED_STATE_MODE ?? 'fixture' }
}

const startConsoleServer = async () => {
  const runtime = await createConsoleServer()
  const { server, sessionRuntime, host, port, sourceMode } = runtime
  server.listen(port, host, () => {
    console.log(`OpenKubes Console runtime listening on http://${host}:${port}`)
    console.log(`Observed-state source: ${sourceMode}`)
    console.log(`Failure injection: ${process.env.OK_CONSOLE_BFF_ENABLE_FAILURE_INJECTION === 'true' ? 'enabled' : 'disabled'}`)
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
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startConsoleServer()
}
