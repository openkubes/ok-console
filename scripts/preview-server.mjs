// Static, dependency-free server. Fixture mode only; no BFF or Kubernetes API.
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

const root = resolve('/app/dist')
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json', '.webp': 'image/webp' }
const port = Number(process.env.PORT || 8787)
createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
  let pathname
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname) }
  catch { res.writeHead(400); res.end(); return }
  if (pathname.startsWith('/api/') || pathname.includes('\\') || pathname.split('/').includes('..')) {
    res.writeHead(404); res.end(); return
  }
  const requested = resolve(root, '.' + pathname)
  if (requested !== root && !requested.startsWith(root + sep)) { res.writeHead(404); res.end(); return }
  let file = requested
  try { if (!(await stat(file)).isFile()) file = resolve(root, 'index.html') }
  catch { if (pathname.includes('.')) { res.writeHead(404); res.end(); return } file = resolve(root, 'index.html') }
  try {
    const content = await readFile(file)
    const ext = file.slice(file.lastIndexOf('.'))
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'" })
    res.end(req.method === 'HEAD' ? undefined : content)
  } catch { res.writeHead(500); res.end() }
}).listen(port, '0.0.0.0')
