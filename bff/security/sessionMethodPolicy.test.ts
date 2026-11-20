// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { SessionEnvelopeCodec } from './envelope.mjs'
import { PostgresSessionStore, SESSION_METHODS } from './postgresSessionStore.mjs'
import { allowedSessionMethods } from './runtime.mjs'

const codec = new SessionEnvelopeCodec({ primaryKeyId: 'key', keys: { key: Buffer.alloc(32, 5) } })
const recordingPool = () => {
  const calls: { sql: string, params: unknown[] }[] = []
  const client = {
    query: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return { rows: [], rowCount: 0 } },
    release: () => {}, on: () => {}, removeListener: () => {},
  }
  return { calls, pool: { ...client, connect: async () => client } }
}
const cookie = `__Host-ok_console_session=${'a'.repeat(43)}`

describe('session store allowed methods', () => {
  it.each([
    ['absent', undefined],
    ['null', null],
    ['a string', 'OIDC'],
    ['a number entry', [1]],
    ['an unknown method', ['SAML']],
    ['a lower-case method', ['oidc']],
    ['a duplicate', ['OIDC', 'OIDC']],
    ['an object', { OIDC: true }],
  ])('rejects %s as configuration', (_case, allowedMethods) => {
    const { pool } = recordingPool()
    expect(() => new PostgresSessionStore({ pool, codec, deploymentEpoch: 'epoch', allowedMethods } as never))
      .toThrow(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }))
  })

  it('accepts an empty set, which honours no session', () => {
    const { pool } = recordingPool()
    expect(new PostgresSessionStore({ pool, codec, deploymentEpoch: 'epoch', allowedMethods: [] }).allowedMethods).toEqual([])
  })

  it('filters every active-session read and the rotation lock on the allowed methods', async () => {
    const { pool, calls } = recordingPool()
    const methods = ['Bootstrap']
    const store = new PostgresSessionStore({ pool, codec, deploymentEpoch: 'epoch', allowedMethods: methods })
    methods.push('OIDC')

    expect(await store.resolve(cookie, { touch: false })).toBeNull()
    expect(await store.resolve(cookie)).toBeNull()
    expect(await store.rotate(cookie)).toBeNull()
    const reads = calls.filter(call => call.sql.includes('authentication_method = ANY($3::text[])'))
    expect(reads.map(call => call.sql.trim().split(/\s+/)[0])).toEqual(['SELECT', 'UPDATE', 'SELECT'])
    for (const call of reads) expect(call.params[2]).toEqual(['Bootstrap'])
  })

  it('keeps revocation method-agnostic so a stale cookie can still log out', async () => {
    const { pool, calls } = recordingPool()
    const store = new PostgresSessionStore({ pool, codec, deploymentEpoch: 'epoch', allowedMethods: ['Bootstrap'] })
    expect(await store.revoke(cookie)).toBe(false)
    expect(calls.some(call => call.sql.includes('authentication_method'))).toBe(false)
  })
})

describe('allowed session methods for the runtime mode', () => {
  it.each([
    [{ OK_CONSOLE_LOCAL_ACCESS_MODE: 'bootstrap' }, false, ['Bootstrap']],
    [{ OK_CONSOLE_OIDC_ENABLED: 'true', OK_CONSOLE_LOCAL_ACCESS_MODE: 'breakglass' }, false, ['OIDC', 'BreakGlass']],
    [{ OK_CONSOLE_OIDC_ENABLED: 'true' }, false, ['OIDC']],
    [{ OK_CONSOLE_OIDC_ENABLED: 'TRUE' }, false, []],
    [{ OK_CONSOLE_LOCAL_ACCESS_MODE: 'disabled' }, false, []],
    [{}, true, ['Local']],
    [{ OK_CONSOLE_LOCAL_ACCESS_MODE: 'bootstrap' }, true, ['Bootstrap', 'Local']],
  ])('%j with local identity %s enables %j', (env, ordinaryLocal, expected) => {
    expect(allowedSessionMethods(env, ordinaryLocal)).toEqual(expected)
    expect(expected.every(method => SESSION_METHODS.includes(method))).toBe(true)
  })
})
