// @vitest-environment node

import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRuntimeHttpHandler } from './runtimeHttp.mjs'

let server: Server | undefined

const start = async (options: Parameters<typeof createRuntimeHttpHandler>[0]) => {
  server = createServer(createRuntimeHttpHandler(options))
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Runtime test server did not bind.')
  return `http://127.0.0.1:${address.port}`
}

afterEach(async () => {
  if (!server) return
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()))
  server = undefined
})

describe('secure Console runtime HTTP boundary', () => {
  it('keeps liveness independent and makes readiness fail closed without details', async () => {
    const apiHandler = vi.fn()
    const baseUrl = await start({ apiHandler, readiness: async () => { throw new Error('database secret detail') } })
    const live = await fetch(`${baseUrl}/health/live`)
    const ready = await fetch(`${baseUrl}/health/ready`)

    expect(live.status).toBe(204)
    expect(ready.status).toBe(503)
    expect(await ready.text()).toBe('')
    expect(ready.headers.get('cache-control')).toBe('no-store')
    expect(apiHandler).not.toHaveBeenCalled()
  })

  it('delegates only the fixed Console API prefix', async () => {
    const apiHandler = vi.fn((_request, response) => { response.writeHead(418); response.end() })
    const baseUrl = await start({ apiHandler })
    expect((await fetch(`${baseUrl}/api/console/v0/overview`)).status).toBe(418)
    expect(apiHandler).toHaveBeenCalledTimes(1)
  })

  it('serves only allowlisted built assets with restrictive browser headers', async () => {
    const body = Buffer.from('<!doctype html><div id="root"></div>')
    const baseUrl = await start({
      apiHandler: vi.fn(),
      readAsset: async () => body,
      statAsset: async () => ({ isFile: () => true, size: body.length }),
    })
    const index = await fetch(`${baseUrl}/`)
    const traversal = await fetch(`${baseUrl}/..%2fpackage.json`)

    expect(index.status).toBe(200)
    expect(await index.text()).toContain('id="root"')
    expect(index.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect(index.headers.get('cache-control')).toBe('no-store')
    expect(traversal.status).toBe(404)
  })

  it('supports body-free HEAD and rejects static mutations', async () => {
    const body = Buffer.from('console')
    const baseUrl = await start({
      apiHandler: vi.fn(),
      readAsset: async () => body,
      statAsset: async () => ({ isFile: () => true, size: body.length }),
    })
    const head = await fetch(`${baseUrl}/assets/index-hash.js`, { method: 'HEAD' })
    const mutation = await fetch(`${baseUrl}/`, { method: 'POST' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe(String(body.length))
    expect(await head.text()).toBe('')
    expect(mutation.status).toBe(405)
  })
})
