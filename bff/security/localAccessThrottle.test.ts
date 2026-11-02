// @vitest-environment node
import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createLocalAccessVerifier, PostgresLocalAccessThrottle } from './localAccess.mjs'

const pepper = Buffer.alloc(32, 6)
const fixture = ({ locked = 'both', updated = 'both', fail = '', timeout = '300' } = {}) => {
  const queries: { sql: string, args: unknown[] }[] = []
  const release = vi.fn()
  const error = new Error('client failed')
  const query = vi.fn(async (sql: string, args: unknown[] = []) => {
    queries.push({ sql, args })
    if (fail && sql.includes(fail)) throw error
    const keys = [throttle.digest('reader'), throttle.globalDigest()].sort()
    if (sql.includes('pg_settings')) return { rows: [{ statement_timeout: timeout, now: '1700000000123456' }] }
    const rows = (mode: string) => (mode === 'one' ? keys.slice(0, 1) : mode === 'foreign' ? [keys[0], 'foreign'] : mode === 'duplicate' ? [keys[0], keys[0]] : keys)
      .map(principal_digest => ({ principal_digest, window: '1700000000123456', blocked: mode === 'blocked' }))
    if (sql.includes('FOR UPDATE')) return { rows: rows(locked) }
    if (sql.includes('RETURNING')) return { rows: rows(updated), rowCount: updated === 'count' ? 1 : rows(updated).length }
    return { rows: [], rowCount: 0 }
  })
  const client = { query, release }
  const pool = { query: vi.fn(async () => ({ rows: [] })), connect: vi.fn(async () => client) }
  const throttle = new PostgresLocalAccessThrottle({ pool, pepper })
  return { throttle, queries, pool, release, error }
}

describe('reservation exact-row and transaction guards', () => {
  it.each(['one', 'foreign', 'duplicate'])('refuses %s locked rows before UPDATE or KDF', async locked => {
    const { throttle, queries, release } = fixture({ locked })
    const derive = vi.fn(), create = vi.fn()
    const verify = createLocalAccessVerifier({ mode: 'Bootstrap', accounts: [], throttle, derive, sessionStore: { create } })
    await expect(verify({ username: 'reader', password: 'wrong', reason: 'Emergency recovery attempt' })).rejects.toMatchObject({ code: 'LOCAL_ACCESS_UNAVAILABLE', step: 'THROTTLE_RESERVE' })
    expect(queries.some(q => q.sql.includes('UPDATE ok_console'))).toBe(false)
    expect(queries.some(q => q.sql === 'COMMIT' || q.sql === 'ROLLBACK')).toBe(false)
    expect(release).toHaveBeenCalledWith(expect.any(Error))
    expect(derive).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled()
  })

  it.each(['one', 'foreign', 'duplicate', 'count'])('refuses %s UPDATE results before COMMIT', async updated => {
    const { throttle, queries, release } = fixture({ updated })
    await expect(throttle.reserve('reader')).rejects.toMatchObject({ code: 'LOCAL_ACCESS_UNAVAILABLE' })
    expect(queries.some(q => q.sql === 'COMMIT')).toBe(false)
    expect(release).toHaveBeenCalledWith(expect.any(Error))
  })

  it.each(['BEGIN', 'pg_settings', 'set_config', 'INSERT INTO', 'FOR UPDATE', 'RETURNING', 'COMMIT'])('destroys client without queuing rollback after %s error', async fail => {
    const { throttle, queries, release, error } = fixture({ fail })
    await expect(throttle.reserve('reader')).rejects.toBe(error)
    expect(release).toHaveBeenCalledExactlyOnceWith(error)
    expect(queries.some(q => q.sql === 'ROLLBACK')).toBe(false)
  })

  it('uses ordered locking, updates only locked keys, caps timeouts and commits before returning', async () => {
    const { throttle, queries, release } = fixture()
    await expect(throttle.reserve('reader')).resolves.toMatchObject({ blocked: false, globalWindow: '1700000000123456' })
    expect(queries[0].sql).toBe('BEGIN ISOLATION LEVEL READ COMMITTED')
    expect(queries.find(q => q.sql.includes('set_config'))?.args).toEqual(['299ms', '299ms'])
    expect(queries.find(q => q.sql.includes('FOR UPDATE'))?.sql).toMatch(/ORDER BY principal_digest FOR UPDATE/)
    expect(queries.find(q => q.sql.includes('RETURNING'))?.args[0]).toEqual([throttle.digest('reader'), throttle.globalDigest()].sort())
    expect(queries.at(-1)?.sql).toBe('COMMIT'); expect(release).toHaveBeenCalledWith(undefined)
  })

  it.each([
    ['1', ['0ms', '0ms']], ['0', ['1000ms', '5000ms']], ['10000', ['1000ms', '5000ms']],
  ])('bounds transaction timeouts with statement_timeout=%s', async (timeout, expected) => {
    const { throttle, queries } = fixture({ timeout })
    await throttle.reserve('reader')
    expect(queries.find(q => q.sql.includes('set_config'))?.args).toEqual(expected)
  })

  it('locks success in the same SQL order and refuses missing keys', async () => {
    const good = fixture()
    await good.throttle.success('reader', { globalWindow: '1700000000123456' })
    expect(good.queries.find(q => q.sql.includes('FOR UPDATE'))?.sql).toMatch(/ORDER BY principal_digest FOR UPDATE/)
    expect(good.queries.at(-1)?.sql).toBe('COMMIT')
    for (const locked of ['one', 'foreign', 'duplicate']) {
      const bad = fixture({ locked })
      await expect(bad.throttle.success('reader', { globalWindow: '1700000000123456' })).rejects.toMatchObject({ code: 'LOCAL_ACCESS_UNAVAILABLE' })
      expect(bad.queries.some(q => q.sql.includes('UPDATE ok_console'))).toBe(false)
      expect(bad.release).toHaveBeenCalledWith(expect.any(Error))
    }
  })

  it('rolls back a block discovered after precheck without incrementing', async () => {
    const { throttle, queries, release } = fixture({ locked: 'blocked' })
    await expect(throttle.reserve('reader')).resolves.toEqual({ blocked: true })
    expect(queries.at(-1)?.sql).toBe('ROLLBACK')
    expect(queries.some(q => q.sql.includes('UPDATE ok_console'))).toBe(false)
    expect(release).toHaveBeenCalledWith(undefined)
  })

  it('requires both callable pool operations', () => {
    for (const pool of [{ query() {} }, { query: true, connect() {} }]) {
      expect(() => new PostgresLocalAccessThrottle({ pool, pepper })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }))
    }
  })

  it('domain-separates principals, global and audit digests using independently computed inputs', () => {
    const { throttle } = fixture()
    const hmac = (input: string) => createHmac('sha256', pepper).update(input).digest('base64url')
    expect(throttle.digest('__global__')).toBe(hmac('throttle:principal:__global__'))
    expect(throttle.globalDigest()).toBe(hmac('throttle:global'))
    expect(throttle.digest('__global__')).not.toBe(throttle.globalDigest())
    expect(throttle.digest('reader')).not.toBe(hmac('audit:reader'))
  })
})
