import { expect, type BrowserContext, type Page, type Request } from '@playwright/test'
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { loadState, startBff } from './harness.mjs'

export const SESSION_COOKIE = '__Host-ok_console_session'
export const CSRF_COOKIE = '__Host-ok_console_csrf'
export const OIDC_TRANSACTION_COOKIE = '__Host-ok_console_oidc'
export const CALLBACK_PATH = '/api/console/v0/auth/oidc/callback'
export const SESSION_PATH = '/api/console/v0/auth/session'
export const LOCAL_PATH = '/api/console/v0/auth/local'

export const harness = () => loadState()
export const restartBff = (mode: 'breakglass' | 'bootstrap', options: { epoch?: string } = {}) => startBff(loadState(), mode, options)

let pool: pg.Pool | undefined
export const query = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
  pool ??= new pg.Pool({ connectionString: harness().pgUrl, max: 2 })
  return (await pool.query(sql, params)).rows as T[]
}
export const databaseNow = async () => (await query<{ now: Date }>('SELECT clock_timestamp() AS now'))[0].now
export const sessionsSince = (since: Date) => query<{ authentication_method: string, revoked_at: Date | null, issued_at: Date, absolute_expires_at: Date, idle_lifetime_ms: string, deployment_epoch: string }>(
  'SELECT authentication_method, revoked_at, issued_at, absolute_expires_at, idle_lifetime_ms, deployment_epoch FROM ok_console.sessions WHERE issued_at >= $1 ORDER BY issued_at', [since])
export const authenticationAuditSince = (since: Date) => query<{ authentication_method: string, outcome: string, cause: string, operational_reason: string, correlation_id: string, principal_digest: string | null }>(
  'SELECT authentication_method, outcome, cause, operational_reason, correlation_id, principal_digest FROM ok_console.authentication_audit WHERE occurred_at >= $1 ORDER BY event_id', [since])

export const openSignIn = async (page: Page) => {
  await page.goto(`${harness().origin}/`)
  await expect(page.getByRole('heading', { name: /Welcome to/ })).toBeVisible()
}

/** Starts the federated flow from the Console UI and returns the authorization request URL. */
export const startOidc = async (page: Page) => {
  const { issuerOrigin } = harness()
  const authorization = page.waitForRequest((request) => request.url().startsWith(issuerOrigin) && new URL(request.url()).pathname.endsWith('/protocol/openid-connect/auth'))
  await openSignIn(page)
  await page.getByRole('button', { name: /Continue with OpenKubes Identity/ }).click()
  await page.getByRole('button', { name: /Continue to identity provider/ }).click()
  const request = await authorization
  await expect(page.locator('#username')).toBeVisible()
  return new URL(request.url())
}

export const submitKeycloakLogin = async (page: Page, username: string, password: string) => {
  await page.locator('#username').fill(username)
  await page.locator('#password').fill(password)
  await page.locator('#kc-login').click()
}

/** Collects every callback URL the browser requests (it carries the authorization code). */
export const recordCallbacks = (page: Page) => {
  const urls: string[] = []
  page.on('request', (request: Request) => { if (request.url().includes(CALLBACK_PATH)) urls.push(request.url()) })
  return urls
}

export const cookie = async (context: BrowserContext, name: string) => (await context.cookies(harness().origin)).find((item) => item.name === name)

/** Values that must never reach browser storage or logs: recorded at the issuer by the harness proxy. */
export const protectedValues = () => {
  const state = harness()
  const values = new Set<string>([state.clientSecret])
  for (const line of readFileSync(state.tapFile, 'utf8').split('\n').filter(Boolean)) {
    const exchange = JSON.parse(line) as { request: string, authorization: string, response: string }
    const form = new URLSearchParams(exchange.request)
    for (const key of ['code', 'code_verifier', 'client_secret']) { const value = form.get(key); if (value) values.add(value) }
    if (exchange.authorization) values.add(exchange.authorization.replace(/^Basic\s+/i, ''))
    try {
      const tokens = JSON.parse(exchange.response) as Record<string, unknown>
      for (const key of ['id_token', 'access_token', 'refresh_token']) {
        const token = tokens[key]
        if (typeof token !== 'string') continue
        values.add(token)
        // Payload and signature are token-specific; the header segment is shared by every token
        // signed with the same key (including the provider's own session cookies), so it is no needle.
        for (const segment of token.split('.').slice(1)) if (segment.length >= 16) values.add(segment)
      }
    } catch { /* non-JSON error body: nothing to protect */ }
  }
  return [...values].filter((value) => value.length >= 8)
}
export const tokenExchanges = () => readFileSync(harness().tapFile, 'utf8').split('\n').filter(Boolean).length

export const leaks = (haystack: string, needles: string[]) => needles.filter((needle) => haystack.includes(needle)).map((needle) => `${needle.slice(0, 6)}… (${needle.length} chars)`)

/** Everything the browser keeps: JS-visible storage and DOM plus every cookie, HttpOnly included. */
export const browserStorageDump = async (page: Page) => JSON.stringify({
  page: await page.evaluate(async () => ({
    local: Object.entries(localStorage),
    session: Object.entries(sessionStorage),
    cookie: document.cookie,
    indexedDb: 'databases' in indexedDB ? await indexedDB.databases() : [],
    href: location.href,
    html: document.documentElement.outerHTML,
  })),
  // Console-origin cookies, HttpOnly included. The provider's own cookies live on its origin.
  cookies: await page.context().cookies(harness().origin),
})

/** Records status, headers and (where readable) bodies of every Console-origin response. */
export const recordConsoleResponses = (page: Page) => {
  const pending: Promise<string>[] = []
  page.on('response', (response) => {
    if (!response.url().startsWith(harness().origin)) return
    pending.push((async () => {
      const within = <T>(work: Promise<T>, fallback: T) => Promise.race([work.catch(() => fallback), new Promise<T>((resolve) => setTimeout(() => resolve(fallback), 5_000))])
      const body = response.status() >= 300 && response.status() < 400 ? '' : await within(response.text(), '')
      const headers = await within(response.headersArray(), [] as { name: string, value: string }[])
      return JSON.stringify({ url: response.url().split('?')[0], status: response.status(), headers, body })
    })())
  })
  return async () => (await Promise.all(pending)).join('\n')
}

/** Raw Set-Cookie values of a response (the cookie API reports SameSite=Lax by default). */
export const setCookies = async (response: { headersArray: () => Promise<{ name: string, value: string }[]> }) => (await response.headersArray())
  .filter((header) => header.name.toLowerCase() === 'set-cookie').map((header) => header.value)
export const expectCookieAttributes = (values: string[], name: string, attributes: string[]) => {
  const value = values.find((item) => item.startsWith(`${name}=`))
  expect(value, `Set-Cookie for ${name}`).toBeDefined()
  const parts = value!.split(';').map((part) => part.trim().toLowerCase())
  for (const attribute of attributes) expect(parts, `${name} ${attribute}`).toContain(attribute.toLowerCase())
}

/** Harness-generated secrets that must never appear in logs either. */
export const harnessSecrets = () => {
  const state = harness()
  return [state.clientSecret, state.pgPassword, state.envelopeKey, state.pepper, ...Object.values(state.passwords) as string[]]
}

/** Guards the log scans against a capture that silently stopped: the log must show this request. */
export const expectLogged = (marker: string) => expect(bffLog(), `BFF log should contain ${marker}`).toContain(marker)

export const bffLog = () => readFileSync(harness().bffLog, 'utf8')

export const sessionRequest = async (page: Page, method: 'GET' | 'DELETE', { csrf, cookieHeader }: { csrf?: string, cookieHeader?: string } = {}) => {
  const { origin } = harness()
  const headers: Record<string, string> = { origin }
  if (csrf) headers['x-csrf-token'] = csrf
  if (cookieHeader !== undefined) headers.cookie = cookieHeader
  return page.request.fetch(`${origin}${SESSION_PATH}`, { method, headers, failOnStatusCode: false, ignoreHTTPSErrors: true })
}

/** Full federated sign-in for the mapped user; returns the callback URL the browser followed. */
export const signInMapped = async (page: Page) => {
  const callbacks = recordCallbacks(page)
  await startOidc(page)
  await submitKeycloakLogin(page, 'mapped-operator', harness().passwords.mapped)
  await page.waitForURL(`${harness().origin}/`)
  await expect(page.getByText('Federated identity')).toBeVisible()
  return callbacks[0]
}

export const localAccess = (page: Page, body: Record<string, unknown>, origin = harness().origin) => page.request.fetch(`${harness().origin}${LOCAL_PATH}`, {
  method: 'POST',
  headers: { origin, 'content-type': 'application/json' },
  data: JSON.stringify(body),
  failOnStatusCode: false,
  ignoreHTTPSErrors: true,
})
