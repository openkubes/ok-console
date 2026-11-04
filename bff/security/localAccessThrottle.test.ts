// @vitest-environment node
import { EventEmitter } from 'node:events'
import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createLocalAccessVerifier, PostgresLocalAccessThrottle } from './localAccess.mjs'

const pepper = Buffer.alloc(32, 6)
const fixture = ({ locked = 'both', updated = 'both', fail = '', timeout = '300', lockTimeout = '0', idleTimeout = '0' } = {}) => {
  const queries: { sql: string, args: unknown[] }[] = []
  const release = vi.fn()
  const error = new Error('client failed')
  const query = vi.fn(async (sql: string, args: unknown[] = []) => {
    queries.push({ sql, args })
    if (fail && sql.includes(fail)) throw error
    const keys = [throttle.digest('reader'), throttle.globalDigest()].sort()
    if (sql.includes('pg_settings')) return { rows: [{ statement_timeout: timeout, lock_timeout: lockTimeout, idle_timeout: idleTimeout }] }
    const rows = (mode: string) => (mode === 'one' ? keys.slice(0, 1) : mode === 'foreign' ? [keys[0], 'foreign'] : mode === 'duplicate' ? [keys[0], keys[0]] : keys)
      .map(principal_digest => ({ principal_digest, window: '1700000000123456', block_token: mode === 'blocked' ? '1800000000000000' : null }))
    if (sql.includes('AS now')) return { rows: [{ now: '1700000000123456' }] }
    if (sql.includes('FOR UPDATE')) return { rows: rows(locked) }
    if (sql.includes('RETURNING')) return { rows: rows(updated), rowCount: updated === 'count' ? 1 : rows(updated).length }
    return { rows: [], rowCount: 0 }
  })
  const client = Object.assign(new EventEmitter(), { query, release })
  const pool = { query: vi.fn(async () => ({ rows: [] })), connect: vi.fn(async () => client) }
  const throttle = new PostgresLocalAccessThrottle({ pool, pepper })
  return { throttle, queries, pool, client, release, error }
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
    ['1', ['1ms', '1ms']], ['0', ['1000ms', '5000ms']], ['10000', ['1000ms', '5000ms']],
  ])('bounds transaction timeouts with statement_timeout=%s', async (timeout, expected) => {
    const { throttle, queries } = fixture({ timeout })
    await throttle.reserve('reader')
    expect(queries.find(q => q.sql.includes('set_config'))?.args).toEqual(expected)
  })

  it('preserves stricter server timeouts', async () => {
    const { throttle, queries } = fixture({ timeout: '5000', lockTimeout: '60', idleTimeout: '120' })
    await throttle.reserve('reader')
    expect(queries.find(q => q.sql.includes('set_config'))?.args).toEqual(['60ms', '120ms'])
  })

  it.each(['SELECT', 'COMMIT', 'release'])('keeps the first asynchronous error through %s and removes its listener after release', async point => {
    const { throttle, client, release } = fixture()
    const failure = Object.assign(new Error('private'), { code: '25P03' })
    if (point === 'release') release.mockImplementation(() => {
      expect(client.listenerCount('error')).toBe(1)
      client.emit('error', failure)
    })
    else throttle.afterStatement = async ({ sql }: { sql: string }) => {
      if (sql.startsWith(point)) {
        client.emit('error', failure)
        throw new Error('generic later rejection')
      }
    }
    await expect(throttle.reserve('reader')).rejects.toMatchObject({ code: 'PG_IDLE_TRANSACTION_TIMEOUT' })
    expect(release).toHaveBeenCalledTimes(1)
    expect(client.listenerCount('error')).toBe(0)
  })

  it('refuses a resolved statement with a recorded error before transaction work continues', async () => {
    const { throttle, client } = fixture()
    const continuation = vi.fn()
    throttle.afterStatement = async ({ sql }: { sql: string }) => {
      if (sql === 'test statement') client.emit('error', Object.assign(new Error('idle'), { code: '25P03' }))
    }
    await expect(throttle.transaction(async (checked: { query: (sql: string) => Promise<unknown> }) => {
      await checked.query('test statement')
      continuation()
    })).rejects.toMatchObject({ code: 'PG_IDLE_TRANSACTION_TIMEOUT' })
    expect(continuation).not.toHaveBeenCalled()
  })

  it('sends no statement after a transaction has recorded an asynchronous failure', async () => {
    const { throttle, client, queries } = fixture()
    await expect(throttle.transaction(async (checked: { query: (sql: string) => Promise<unknown> }) => {
      client.emit('error', Object.assign(new Error('terminated'), { code: '57P01' }))
      await checked.query('must never be sent')
    })).rejects.toMatchObject({ code: 'PG_CONNECTION_TERMINATED' })
    expect(queries.some(q => q.sql === 'must never be sent')).toBe(false)
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
