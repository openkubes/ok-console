import { readFile, stat } from 'node:fs/promises'
import { deploymentPolicyAllows } from './deploymentPolicy.mjs'
import { injectInstallation, installationDocument } from './installation.mjs'

const API_ROOT = '/api/console/v0'
const LIVE_PATH = '/health/live'
const READY_PATH = '/health/ready'
const MAX_ASSET_BYTES = 10 * 1_024 * 1_024
const DEFAULT_STATIC_ROOT = new URL('../dist/', import.meta.url)

const commonHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
}

const staticHeaders = {
  ...commonHeaders,
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  'Strict-Transport-Security': 'max-age=31536000',
}

const sendEmpty = (response, status, extra = {}) => {
  response.writeHead(status, { ...commonHeaders, 'Cache-Control': 'no-store', ...extra })
  response.end()
}

const sendText = (response, status, message, extra = {}, head = false) => {
  const body = Buffer.from(message)
  response.writeHead(status, {
    ...staticHeaders,
    'Cache-Control': 'no-store',
    'Content-Length': String(body.length),
    'Content-Type': 'text/plain; charset=utf-8',
    ...extra,
  })
  response.end(head ? undefined : body)
}

const BRANDING_PATH = /^\/branding\/([a-z0-9][a-z0-9-]{0,62}\.(svg|png|webp|ico|json))$/

const assetFor = (pathname) => {
  let decoded
  try { decoded = decodeURIComponent(pathname) } catch { return null }
  if (decoded === '/' || decoded === '/index.html') return { filename: 'index.html', contentType: 'text/html; charset=utf-8', cache: 'no-store' }
  const branding = BRANDING_PATH.exec(decoded)
  if (branding) return { root: 'branding', filename: branding[1] }
  if (decoded === '/openkubes-icon.png') return { filename: 'openkubes-icon.png', contentType: 'image/png', cache: 'public, max-age=3600' }
  if (!/^\/assets\/[A-Za-z0-9._-]+\.(?:css|js)$/.test(decoded)) return null
  return {
    filename: decoded.slice(1),
    contentType: decoded.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8',
    cache: 'public, max-age=31536000, immutable',
  }
}

export const createRuntimeHttpHandler = ({
  apiHandler,
  readiness = async () => true,
  staticRoot = DEFAULT_STATIC_ROOT,
  brandingAssets = null,
  brandingDocument = null,
  deploymentPolicy = null,
  readAsset = readFile,
  statAsset = stat,
}) => {
  const installation = installationDocument({ branding: brandingDocument, deploymentPolicy })
  return async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://console.local')

    if (url.pathname === LIVE_PATH || url.pathname === READY_PATH) {
      if (!['GET', 'HEAD'].includes(request.method ?? '')) {
        sendEmpty(response, 405, { Allow: 'GET, HEAD' })
        return
      }
      if (url.pathname === LIVE_PATH) {
        sendEmpty(response, 204)
        return
      }
      let ready = false
      try { ready = await readiness() === true } catch { ready = false }
      sendEmpty(response, ready ? 204 : 503)
      return
    }

    if (url.pathname === API_ROOT || url.pathname.startsWith(`${API_ROOT}/`)) {
      if (!deploymentPolicyAllows(deploymentPolicy, request.method ?? 'GET', url.pathname)) {
        const body = Buffer.from(JSON.stringify({ error: { code: 'DEPLOYMENT_POLICY_READ_ONLY', message: `Refused by deployment policy ${deploymentPolicy.name}: this installation is read-only.` } }))
        response.writeHead(403, { ...staticHeaders, 'Cache-Control': 'no-store', 'Content-Length': String(body.length), 'Content-Type': 'application/json; charset=utf-8' })
        response.end(body)
        return
      }
      await apiHandler(request, response)
      return
    }

    const head = request.method === 'HEAD'
    if (request.method !== 'GET' && !head) {
      sendText(response, 405, 'Method not allowed.', { Allow: 'GET, HEAD' })
      return
    }
    const asset = assetFor(url.pathname)
    if (!asset) {
      sendText(response, 404, 'Not found.', {}, head)
      return
    }
    if (asset.root === 'branding') {
      // Branding is served only from the snapshot validated at startup: no file system access per request,
      // so symlink swaps or later edits in the mounted directory cannot change what is served.
      const entry = brandingAssets?.get(asset.filename)
      if (entry) {
        response.writeHead(200, { ...staticHeaders, 'Cache-Control': 'no-cache', 'Content-Length': String(entry.body.length), 'Content-Type': entry.contentType })
        response.end(head ? undefined : entry.body)
      } else {
        sendText(response, 404, 'Not found.', {}, head)
      }
      return
    }
    try {
      const target = new URL(asset.filename, staticRoot)
      const metadata = await statAsset(target)
      if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_ASSET_BYTES) throw new Error('invalid asset')
      let body = await readAsset(target)
      if (body.length !== metadata.size) throw new Error('asset changed')
      if (asset.filename === 'index.html') body = Buffer.from(injectInstallation(body.toString('utf8'), installation))
      response.writeHead(200, {
        ...staticHeaders,
        'Cache-Control': asset.cache,
        'Content-Length': String(body.length),
        'Content-Type': asset.contentType,
      })
      response.end(head ? undefined : body)
    } catch {
      sendText(response, 503, 'Runtime asset unavailable.', {}, head)
    }
  }
}
