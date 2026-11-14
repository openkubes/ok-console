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

const installationOf = (html: string) => JSON.parse(/<script type="application\/json" id="ok-console-installation">([^<]*)<\/script>/.exec(html)?.[1] ?? 'null')

describe('per-installation branding assets', () => {
  const brandingAssets = new Map([
    ['acme-mark.svg', { body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), contentType: 'image/svg+xml' }],
  ])
  const brandingDocument = {
    schema: 'openkubes.console.branding/v1' as const, productName: 'Acme <Ops> Console', logo: { file: 'acme-mark.svg', alt: 'Acme' },
    favicon: 'acme-mark.svg', colors: { primary: '#0f6e4a', accent: '#f2b134' },
  }
  const indexHtml = Buffer.from('<head><meta name="theme-color" content="#064fc8" /><meta name="description" content="OpenKubes" /><link rel="icon" type="image/png" href="./openkubes-icon.png" /><title>OpenKubes Console</title></head>')
  const staticIo = () => ({
    readAsset: vi.fn(async () => indexHtml),
    statAsset: vi.fn(async () => ({ isFile: () => true, size: indexHtml.length })),
  })

  it('serves only validated logo and favicon from the snapshot, never the file system', async () => {
    const io = staticIo()
    const baseUrl = await start({ apiHandler: vi.fn(), brandingAssets, brandingDocument, ...io })
    const logo = await fetch(`${baseUrl}/branding/acme-mark.svg`)
    expect(logo.status).toBe(200)
    expect(logo.headers.get('content-type')).toBe('image/svg+xml')
    expect(logo.headers.get('cache-control')).toBe('no-cache')
    expect(logo.headers.get('content-security-policy')).toContain("script-src 'self'")
    expect(io.statAsset).not.toHaveBeenCalled()
    for (const path of ['/branding/branding.json', '/branding/other-mark.svg', '/branding/..%2fpackage.json', '/branding/sub/acme-mark.svg', '/branding/Acme-Mark.svg', '/branding/acme-mark.gif']) {
      expect((await fetch(`${baseUrl}${path}`)).status, path).toBe(404)
    }
  })

  it('answers 404 for every branding path without configuration', async () => {
    const baseUrl = await start({ apiHandler: vi.fn(), ...staticIo() })
    expect((await fetch(`${baseUrl}/branding/branding.json`)).status).toBe(404)
    expect((await fetch(`${baseUrl}/branding/acme-mark.svg`)).status).toBe(404)
  })

  it('brands index.html and embeds the installation data before it reaches the browser', async () => {
    const baseUrl = await start({ apiHandler: vi.fn(), brandingAssets, brandingDocument, ...staticIo() })
    const html = await (await fetch(`${baseUrl}/`)).text()
    expect(html).toContain('<title>Acme &lt;Ops&gt; Console</title>')
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="./branding/acme-mark.svg" />')
    expect(html).toContain('<meta name="theme-color" content="#0f6e4a" />')
    expect(html).not.toMatch(/OpenKubes|openkubes-icon/)
    expect(html).not.toContain('Acme <Ops>')
    expect(installationOf(html)).toEqual({
      schema: 'openkubes.console.installation/v1',
      branding: brandingDocument,
      deploymentPolicy: { schema: 'openkubes.console.deployment-policy/v1', policy: 'default', clusterLifecycle: true },
    })
  })

  it('keeps index.html unbranded without configuration, adding only the installation data', async () => {
    const baseUrl = await start({ apiHandler: vi.fn(), ...staticIo() })
    const html = await (await fetch(`${baseUrl}/`)).text()
    expect(html).toContain('<title>OpenKubes Console</title>')
    expect(html).toContain('href="./openkubes-icon.png"')
    expect(installationOf(html)).toMatchObject({ branding: null, deploymentPolicy: { policy: 'default', clusterLifecycle: true } })
  })
})

describe('deployment policy', () => {
  const readOnly = { name: 'fixture-read-only', clusterLifecycle: false, liveClusterAccess: false, writeApis: false } as const
  const html = Buffer.from('<head><title>OpenKubes Console</title></head>')
  const io = { readAsset: vi.fn(async () => html), statAsset: vi.fn(async () => ({ isFile: () => true, size: html.length })) }

  it('leaves the API untouched without a policy', async () => {
    const apiHandler = vi.fn((_request, response) => response.end('{}'))
    const baseUrl = await start({ apiHandler, ...io })
    await fetch(`${baseUrl}/api/console/v0/operations/create-cluster/dry-run`, { method: 'POST', body: '{}' })
    expect(apiHandler).toHaveBeenCalledTimes(1)
  })

  it('enforces fixture-read-only on the server before the API handler runs and tells the Console', async () => {
    const apiHandler = vi.fn((_request, response) => response.end('{}'))
    const baseUrl = await start({ apiHandler, deploymentPolicy: readOnly, ...io })
    expect(installationOf(await (await fetch(`${baseUrl}/`)).text()).deploymentPolicy).toEqual({ schema: 'openkubes.console.deployment-policy/v1', policy: 'fixture-read-only', clusterLifecycle: false })
    for (const [method, path] of [['POST', '/api/console/v0/operations/create-cluster/dry-run'], ['GET', '/api/console/v0/operations/create-cluster/dry-run'], ['POST', '/api/console/v0/local-identity/create'], ['DELETE', '/api/console/v0/clusters/ok-mgmt']]) {
      const refused = await fetch(`${baseUrl}${path}`, { method })
      expect(refused.status, `${method} ${path}`).toBe(403)
      expect((await refused.json()).error.code).toBe('DEPLOYMENT_POLICY_READ_ONLY')
    }
    expect(apiHandler).not.toHaveBeenCalled()
    await fetch(`${baseUrl}/api/console/v0/overview`)
    await fetch(`${baseUrl}/api/console/v0/auth/local`, { method: 'POST', body: '{}' })
    expect(apiHandler).toHaveBeenCalledTimes(2)
  })
})
