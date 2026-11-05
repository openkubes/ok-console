import https from 'node:https'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { emitKeypressEvents } from 'node:readline'

// No password flags, environment variables, cookie files or database access.
export class LocalIdentityClient {
  constructor({ origin, ca }) {
    const url = new URL(origin)
    if (url.origin !== origin || url.protocol !== 'https:' || !['127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('An exact HTTPS loopback origin is required.')
    this.origin = origin
    this.ca = ca
    this.cookies = new Map()
  }
  async request(path, body) {
    const method = body === undefined ? 'GET' : body === null ? 'DELETE' : 'POST'
    const payload = body ? JSON.stringify(body) : undefined
    const csrf = this.cookies.get('__Host-ok_console_csrf')
    return new Promise((resolveRequest, reject) => {
      const fail = () => reject(new Error('Local identity request failed; no credential details are available.'))
      const request = https.request(new URL(path, this.origin), {
        method, ca: this.ca, rejectUnauthorized: true, timeout: 10000,
        headers: { Origin: this.origin, Accept: 'application/json', 'Content-Type': 'application/json',
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
          Cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '),
        },
      }, (response) => {
        let size = 0
        const chunks = []
        response.on('data', (chunk) => { size += chunk.length; if (size > 262144) { response.destroy(); fail() } else chunks.push(chunk) })
        response.on('error', fail)
        response.on('end', () => {
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) return fail()
          for (const header of response.headers['set-cookie'] ?? []) {
            const [pair] = header.split(';')
            const index = pair.indexOf('=')
            const name = pair.slice(0,index)
            if (['__Host-ok_console_session','__Host-ok_console_csrf'].includes(name)) this.cookies.set(name, pair.slice(index+1))
          }
          try { resolveRequest(size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) } catch { fail() }
        })
      })
      request.on('error', fail)
      request.on('timeout', () => request.destroy())
      request.end(payload)
    })
  }
  async close() {
    try { if (this.cookies.size) await this.request('/api/console/v0/auth/session', null) } finally { this.cookies.clear() }
  }
}
export const protectedPrompt = async (label) => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('An attended terminal is required.')
  emitKeypressEvents(process.stdin)
  process.stdin.setRawMode(true)
  process.stdin.resume()
  return new Promise((done, reject) => {
    let input = ''
    const finish = (error) => {
      process.stdin.off('keypress', onKey)
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdout.write('\n')
      if (error) { input = ''; reject(error) } else done(input)
    }
    const onKey = (text, key = {}) => {
      if (key.ctrl && key.name === 'c') return finish(new Error('Cancelled.'))
      if (key.name === 'return') return finish()
      if (key.name === 'backspace') input = input.slice(0,-1)
      else if (text && !key.ctrl && !key.meta && ![...text].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) && Buffer.byteLength(input + text) <= 256) input += text
    }
    process.stdin.on('keypress', onKey)
    process.stdout.write(`${label}: `)
  })
}
const run = async () => {
  const args = process.argv.slice(2)
  const operation = args[0]
  const target = args[1]
  const allowed = new Set(['initialize','create','list','disable','recover'])
  if (!allowed.has(operation) || (operation !== 'list' && (!target || target.startsWith('--')))) throw new Error('Usage: localIdentity.mjs initialize|create|list|disable|recover [username-or-id] --admin NAME [--console-reader]')
  const adminIndex = args.indexOf('--admin')
  const admin = args[adminIndex + 1]
  if (adminIndex < 0 || !admin || admin.startsWith('--')) throw new Error('A named --admin is required.')
  const permitted = operation === 'list' ? [operation] : [operation,target]
  permitted.push('--admin',admin)
  if (operation === 'create') permitted.push('--console-reader')
  if (args.length !== permitted.length || args.some((arg) => !permitted.includes(arg))) throw new Error('Unexpected options; credential flags are prohibited.')
  const client = new LocalIdentityClient({ origin: process.env.OK_CONSOLE_ORIGIN, ca: await readFile(process.env.OK_CONSOLE_LOCAL_TLS_CA_FILE) })
  let password = await protectedPrompt('Administrator password')
  try {
    const exceptional = operation === 'initialize' || operation === 'recover'
    await client.request(exceptional ? '/api/console/v0/auth/local' : '/api/console/v0/local-identity/login', {
      username: admin, password, ...(exceptional ? { reason: operation === 'initialize' ? 'Attended ordinary-local administrator initialization' : 'Attended offline local-administrator recovery' } : {}),
    })
    password = ''
    const input = operation === 'disable' ? { id: target } : { username: target, consoleReader: operation === 'create' }
    if (['initialize','create','recover'].includes(operation)) {
      input.password = await protectedPrompt('New account password (15+ characters)')
      const confirmation = await protectedPrompt('Confirm new account password')
      if (input.password !== confirmation) throw new Error('Passwords did not match.')
    }
    const result = await client.request(`/api/console/v0/local-identity/${operation}`, operation === 'list' ? undefined : input)
    delete input.password
    // Only explicit public account fields reach stdout.
    const safe = (row) => ({ id: row.id, username: row.username, enabled: row.enabled, administrator: row.administrator })
    process.stdout.write(JSON.stringify(result.users ? { users: result.users.map(safe) } : { user: safe(result.user) }, null, 2) + '\n')
  } finally { password = ''; await client.close() }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch(() => { process.stderr.write('Local identity command failed. Check configuration, authorization and audit evidence.\n'); process.exitCode = 1 })
}
