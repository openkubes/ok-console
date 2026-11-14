import { readFile } from 'node:fs/promises'
import { createServer as createHttpsServer } from 'node:https'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { createConsoleBffHandler, prototypeAuthorizer } from './app.mjs'
import { createObservedStateSource } from './source.mjs'
import { createSessionRuntime } from './security/runtime.mjs'
import { createRuntimeHttpHandler } from './runtimeHttp.mjs'
import { createClusterDryRunHttpAdapter } from './adapters/createClusterDryRun.mjs'
import { loadBrandingDirectory } from './brandingRuntime.mjs'
import { resolveDeploymentPolicy } from './deploymentPolicy.mjs'

export const createConsoleServer = async ({
  env = process.env,
  serverFactory,
  sessionRuntimeFactory = createSessionRuntime,
  sourceFactory = createObservedStateSource,
  runtimeHttpFactory = createRuntimeHttpHandler,
  dryRunFactory = createClusterDryRunHttpAdapter,
  brandingLoader = loadBrandingDirectory,
  sourceFailureLog = (line) => console.log(line),
} = {}) => {
  const host = env.OK_CONSOLE_BFF_HOST ?? '127.0.0.1'
  const port = Number.parseInt(env.OK_CONSOLE_BFF_PORT ?? '8787', 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('OK_CONSOLE_BFF_PORT must be an integer between 1 and 65535.')
  }

  // Both fail closed before anything listens. They are independent: branding never decides permissions.
  const deploymentPolicy = resolveDeploymentPolicy(env)
  const branding = await brandingLoader(env.OK_CONSOLE_BRANDING_DIR)
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
    authenticationAudit: sessionRuntime.authenticationAudit,
    localIdentityHandler: sessionRuntime.localIdentityHandler,
    enableFailureInjection: env.OK_CONSOLE_BFF_ENABLE_FAILURE_INJECTION === 'true',
    dryRunExecutor,
    sourceFailureObserver: sourceFailureLog,
    requestObserver: ({ stage, method, pathname, correlationId }) => {
      console.log(`${method} ${pathname} · ${correlationId} stage=${stage}`)
    },
  })
  let factory = serverFactory ?? createServer
  if (env.OK_CONSOLE_LOCAL_IDENTITY_ENABLED === 'true') {
    const tlsFile = async (name) => {
      if (!env[name]?.startsWith('/')) throw new Error('Local HTTPS requires absolute certificate/key paths.')
      const bytes = await readFile(env[name])
      if (!bytes.length || bytes.length > 65536) throw new Error('Invalid local HTTPS material.')
      return bytes
    }
    const tls = { cert: await tlsFile('OK_CONSOLE_LOCAL_TLS_CERT_FILE'), key: await tlsFile('OK_CONSOLE_LOCAL_TLS_KEY_FILE'), minVersion: 'TLSv1.2' }
    factory = serverFactory ?? ((handler) => createHttpsServer(tls, handler))
  }
  const server = factory(runtimeHttpFactory({ apiHandler, readiness: sessionRuntime.ready, brandingAssets: branding?.assets ?? null, brandingDocument: branding?.branding ?? null, deploymentPolicy }))
  return { server, sessionRuntime, host, port, branding: branding?.branding ?? null, deploymentPolicy, sourceMode: env.OK_CONSOLE_OBSERVED_STATE_MODE ?? 'fixture' }
}

const startConsoleServer = async () => {
  const runtime = await createConsoleServer()
  const { server, sessionRuntime, host, port, sourceMode, branding, deploymentPolicy } = runtime
  server.listen(port, host, () => {
    console.log(`OpenKubes Console runtime listening on ${process.env.OK_CONSOLE_LOCAL_IDENTITY_ENABLED === 'true' ? 'https' : 'http'}://${host}:${port}`)
    console.log(`Observed-state source: ${sourceMode}`)
    console.log(`Failure injection: ${process.env.OK_CONSOLE_BFF_ENABLE_FAILURE_INJECTION === 'true' ? 'enabled' : 'disabled'}`)
    console.log(`Session store: ${sessionRuntime.mode}`)
    console.log(`Deployment policy: ${deploymentPolicy?.name ?? 'default'}`)
    console.log(`Branding: ${branding ? `${branding.productName} (OK_CONSOLE_BRANDING_DIR)` : 'built-in default'}`)
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
