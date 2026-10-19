// @vitest-environment node

import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createConsoleServer } from './server.mjs'

let server: Server | undefined
let closeRuntime: (() => Promise<void>) | undefined

afterEach(async () => {
  if (server?.listening) {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()))
  }
  server = undefined
  await closeRuntime?.()
  closeRuntime = undefined
})

describe('Console server prototype startup', () => {
  it.each(['0.0.0.0', '::', '10.0.0.5', 'console.example'])('rejects unsafe prototype bind %s before creating the HTTP server', async (host) => {
    const serverFactory = vi.fn((handler) => createServer(handler))

    await expect(createConsoleServer({
      env: { OK_CONSOLE_DEV_PROTOTYPE_ENABLED: 'true', OK_CONSOLE_BFF_HOST: host },
      serverFactory,
    })).rejects.toThrow('prototype BFF host')
    expect(serverFactory).not.toHaveBeenCalled()
  })

  it('rejects a malformed disposable-cluster acknowledgment before creating the HTTP server', async () => {
    const serverFactory = vi.fn((handler) => createServer(handler))

    await expect(createConsoleServer({
      env: {
        OK_CONSOLE_DEV_PROTOTYPE_ENABLED: 'true', OK_CONSOLE_BFF_HOST: '0.0.0.0',
        OK_CONSOLE_DISPOSABLE_LOCAL_CLUSTER_ACKNOWLEDGED: 'True',
      },
      serverFactory,
    })).rejects.toThrow('prototype BFF host')
    expect(serverFactory).not.toHaveBeenCalled()
  })

  it('serves the fixture-backed API when prototype mode is explicitly enabled', async () => {
    const runtime = await createConsoleServer({ env: { OK_CONSOLE_DEV_PROTOTYPE_ENABLED: 'true' } })
    server = runtime.server
    closeRuntime = runtime.sessionRuntime.close
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Prototype test server did not expose a TCP address.')

    const response = await fetch(`http://127.0.0.1:${address.port}/api/console/v0/overview`)
    const body = await response.json()

    expect(runtime.sessionRuntime.prototypeEnabled).toBe(true)
    expect(response.status).toBe(200)
    expect(body).toMatchObject({ kind: 'PlatformOverview' })
  })
})
