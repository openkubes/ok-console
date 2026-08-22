// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import { createSessionRuntime, SessionRuntimeConfigurationError } from './runtime.mjs'

const key = Buffer.alloc(32, 7).toString('base64')
const files: Record<string, string> = {
  '/run/secrets/postgres-url': 'postgresql://console:secret@127.0.0.1:5432/console',
  '/run/secrets/postgres-ca': 'test-ca',
  '/run/secrets/envelope-keys': JSON.stringify({ 'key-2026-08': key }),
}

const baseEnv = {
  OK_CONSOLE_SESSION_STORE_MODE: 'postgres',
  OK_CONSOLE_ORIGIN: 'https://console.openkubes.example',
  OK_CONSOLE_ENVIRONMENT_ID: 'community-preview',
  OK_CONSOLE_SESSION_EPOCH: 'epoch-2026-08',
  OK_CONSOLE_AUTHORIZATION_REVISION: 'rbac-42',
  OK_CONSOLE_POSTGRES_URL_FILE: '/run/secrets/postgres-url',
  OK_CONSOLE_POSTGRES_CA_FILE: '/run/secrets/postgres-ca',
  OK_CONSOLE_SESSION_ENVELOPE_PRIMARY_KEY_ID: 'key-2026-08',
  OK_CONSOLE_SESSION_ENVELOPE_KEYS_FILE: '/run/secrets/envelope-keys',
}

const fileReader = async (filename: string) => {
  const value = files[filename]
  if (value === undefined) throw new Error('missing')
  return Buffer.from(value)
}

describe('session runtime configuration', () => {
  it('keeps the session service explicitly disabled without reading secrets', async () => {
    const reader = vi.fn()
    const runtime = await createSessionRuntime({ env: {}, fileReader: reader })

    expect(runtime).toMatchObject({ mode: 'disabled', sessionStore: null, authorizer: undefined })
    expect(reader).not.toHaveBeenCalled()
    await runtime.close()
  })

  it('does not expose a non-fixture source through the prototype authorizer', async () => {
    await expect(createSessionRuntime({
      env: { OK_CONSOLE_OBSERVED_STATE_MODE: 'openkubes' },
    })).rejects.toThrow('requires the PostgreSQL session runtime')
  })

  it('builds verified TLS and session authorization from secret files', async () => {
    let poolConfiguration: Record<string, unknown> | undefined
    let storeConfiguration: Record<string, unknown> | undefined
    const end = vi.fn(async () => {})
    const authorize = vi.fn(async () => ({ allowed: true, identity: { id: 'user-1' } }))
    const runtime = await createSessionRuntime({
      env: baseEnv,
      fileReader,
      poolFactory: (configuration) => {
        poolConfiguration = configuration
        return { end }
      },
      storeFactory: (configuration) => {
        storeConfiguration = configuration
        return { authorize }
      },
    })

    expect(poolConfiguration).toMatchObject({
      connectionString: files['/run/secrets/postgres-url'],
      ssl: { ca: 'test-ca', rejectUnauthorized: true },
      max: 10,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 5_000,
    })
    expect(storeConfiguration).toMatchObject({ deploymentEpoch: 'epoch-2026-08' })
    const validator = storeConfiguration?.authorizationRevisionValidator as (input: { revision: string }) => Promise<boolean>
    expect(await validator({ revision: 'rbac-42' })).toBe(true)
    expect(await validator({ revision: 'rbac-41' })).toBe(false)

    const request = { headers: { cookie: '__Host-ok_console_session=opaque' } }
    await expect(runtime.authorizer?.({ request, permission: 'clusters.read' })).resolves.toMatchObject({ allowed: true })
    expect(authorize).toHaveBeenCalledWith(request.headers.cookie, {
      permission: 'clusters.read',
      environmentId: 'community-preview',
    })
    await runtime.close()
    await runtime.close()
    expect(end).toHaveBeenCalledTimes(1)
  })

  it('allows insecure transport only for an explicitly selected loopback database', async () => {
    let poolConfiguration: Record<string, unknown> | undefined
    await createSessionRuntime({
      env: { ...baseEnv, OK_CONSOLE_POSTGRES_ALLOW_INSECURE_LOOPBACK: 'true' },
      fileReader,
      poolFactory: (configuration) => {
        poolConfiguration = configuration
        return { end: async () => {} }
      },
      storeFactory: () => ({ authorize: async () => ({ allowed: false }) }),
    })

    expect(poolConfiguration?.ssl).toBe(false)
  })

  it.each([
    [{ ...baseEnv, OK_CONSOLE_ORIGIN: 'http://console.openkubes.example' }, 'exact HTTPS origin'],
    [{ ...baseEnv, OK_CONSOLE_POSTGRES_URL_FILE: 'postgres-url' }, 'absolute file path'],
    [{ ...baseEnv, OK_CONSOLE_SESSION_STORE_MODE: 'memory' }, 'disabled or postgres'],
    [{ ...baseEnv, OK_CONSOLE_POSTGRES_POOL_MAX: '1000' }, 'integer between 1 and 50'],
  ])('fails closed for invalid configuration', async (env, message) => {
    await expect(createSessionRuntime({ env, fileReader })).rejects.toThrow(message)
  })

  it('rejects non-loopback insecure transport without exposing its secret', async () => {
    const secret = 'postgresql://console:do-not-leak@db.internal:5432/console'
    const reader = async (filename: string) => filename === '/run/secrets/postgres-url'
      ? Buffer.from(secret)
      : fileReader(filename)

    let error: unknown
    try {
      await createSessionRuntime({
        env: { ...baseEnv, OK_CONSOLE_POSTGRES_ALLOW_INSECURE_LOOPBACK: 'true' },
        fileReader: reader,
      })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(SessionRuntimeConfigurationError)
    expect(String(error)).not.toContain('do-not-leak')
  })

  it('rejects database URL parameters that could override trusted TLS', async () => {
    const reader = async (filename: string) => filename === '/run/secrets/postgres-url'
      ? Buffer.from(`${files['/run/secrets/postgres-url']}?sslmode=disable`)
      : fileReader(filename)

    await expect(createSessionRuntime({ env: baseEnv, fileReader: reader })).rejects.toThrow(
      'PostgreSQL TLS is configured only through the trusted runtime profile.',
    )
  })
})
