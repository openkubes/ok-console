import type { PrototypeSession } from './AuthEntry'

export type AuthMode = 'prototype' | 'oidc'

export class ConsoleAuthError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message)
    this.name = 'ConsoleAuthError'
  }
}

export type ConsoleAuthClient = {
  mode: AuthMode
  restoreSession: () => Promise<PrototypeSession | null>
  startOidc: () => void
  logout: () => Promise<void>
}

const API_ROOT = '/api/console/v0'
const CSRF_COOKIE = '__Host-ok_console_csrf'

const sessionProjection = (value: unknown): PrototypeSession => {
  const response = value as {
    apiVersion?: unknown
    kind?: unknown
    data?: {
      subject?: { displayName?: unknown, provider?: unknown, method?: unknown, assurance?: unknown }
      session?: { absoluteExpiresAt?: unknown }
    }
  }
  const subject = response.data?.subject
  const absoluteExpiresAt = response.data?.session?.absoluteExpiresAt
  if (response.apiVersion !== 'auth.console.openkubes.io/v0alpha1'
    || response.kind !== 'ConsoleSession'
    || typeof subject?.displayName !== 'string'
    || typeof subject.provider !== 'string'
    || subject.method !== 'OIDC'
    || !Array.isArray(subject.assurance)
    || !subject.assurance.every((item) => typeof item === 'string')
    || typeof absoluteExpiresAt !== 'string'
    || !Number.isFinite(Date.parse(absoluteExpiresAt))) {
    throw new ConsoleAuthError('The authentication service returned an incompatible session.', false)
  }
  return {
    method: 'oidc',
    identity: subject.displayName,
    source: subject.provider,
    assurance: subject.assurance.join(' · '),
    expiresIn: `Until ${new Date(absoluteExpiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
  }
}

const csrfToken = (cookieHeader: string) => {
  const values = cookieHeader.split(';').map((item) => item.trim()).filter((item) => item.startsWith(`${CSRF_COOKIE}=`))
  if (values.length !== 1) return null
  const value = values[0].slice(CSRF_COOKIE.length + 1)
  return /^[A-Za-z0-9_-]{40,128}$/.test(value) ? value : null
}

export const createConsoleAuthClient = ({
  mode,
  fetcher = window.fetch.bind(window),
  navigate = (url: string) => window.location.assign(url),
  readCookie = () => document.cookie,
}: {
  mode: AuthMode
  fetcher?: typeof fetch
  navigate?: (url: string) => void
  readCookie?: () => string
}): ConsoleAuthClient => ({
  mode,
  restoreSession: async () => {
    if (mode === 'prototype') return null
    let response: Response
    try {
      response = await fetcher(`${API_ROOT}/auth/session`, {
        method: 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' },
      })
    } catch {
      throw new ConsoleAuthError('The authentication service is unavailable.', true)
    }
    if (response.status === 401) return null
    if (!response.ok) throw new ConsoleAuthError('The authentication service is unavailable.', response.status >= 500)
    try {
      return sessionProjection(await response.json())
    } catch (error) {
      if (error instanceof ConsoleAuthError) throw error
      throw new ConsoleAuthError('The authentication service returned an incompatible session.', false)
    }
  },
  startOidc: () => {
    if (mode !== 'oidc') return
    navigate(`${API_ROOT}/auth/oidc/start`)
  },
  logout: async () => {
    if (mode === 'prototype') return
    const token = csrfToken(readCookie())
    if (!token) throw new ConsoleAuthError('The session cannot be signed out safely. Refresh and try again.', true)
    let response: Response
    try {
      response = await fetcher(`${API_ROOT}/auth/session`, {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: { 'X-CSRF-Token': token },
      })
    } catch {
      throw new ConsoleAuthError('Sign-out could not reach the authentication service.', true)
    }
    if (response.status !== 204 && response.status !== 401) {
      throw new ConsoleAuthError('The authentication service did not confirm sign-out.', response.status >= 500)
    }
  },
})

export const consoleAuthMode: AuthMode = import.meta.env.VITE_CONSOLE_AUTH_MODE === 'oidc' ? 'oidc' : 'prototype'
export const consoleAuth = createConsoleAuthClient({ mode: consoleAuthMode })
