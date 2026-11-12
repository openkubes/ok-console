// @vitest-environment node
import { createServer, type Socket } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import { createLocalAccessVerifier, PostgresLocalAccessThrottle, PostgresLocalAccessAudit } from './localAccess.mjs'
import { startErrorCode } from '../diagnostics.mjs'
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const packet = (tag: string, body: Buffer) => { const h = Buffer.alloc(5); h.write(tag); h.writeInt32BE(body.length + 4, 1); return Buffer.concat([h, body]) }
const ready = Buffer.from('5a0000000549', 'hex')
const serve = async (reply: (socket: Socket, query: string) => void) => {
  const sockets = new Set<Socket>(); const queries: string[] = []; let count = 0
  const server = createServer(socket => { count++; sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); let started = false
    socket.on('data', data => { if (!started) { started = true; socket.write(Buffer.from('5200000008000000005a0000000549', 'hex')); return }; if (data[0] === 88) { socket.end(); return }; const query = data.toString('latin1'); queries.push(query); reply(socket, query) })
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  cleanup.push(() => new Promise<void>(done => { for (const socket of sockets) socket.destroy(); server.close(() => done()) }))
  const pool = new Pool({ host: '127.0.0.1', port: (server.address() as { port: number }).port, user: 'x', database: 'x', query_timeout: 2000, connectionTimeoutMillis: 500, max: 1 })
  cleanup.push(() => pool.end()); return { pool, queries, count: () => count }
}

it.each(['blocked', 'failure', 'success', 'record'] as const)('M1 real pg wire 57014 at local-access %s crosses pg boundary', async site => {
  const { pool } = await serve(socket => socket.write(Buffer.concat([packet('E', Buffer.from('SERROR\0VERROR\0C57014\0Munrelated private message\0\0')), ready])))
  const throttle = new PostgresLocalAccessThrottle({ pool, pepper: Buffer.alloc(32) })
  const audit = new PostgresLocalAccessAudit({ pool, pepper: Buffer.alloc(32) })
  const error = await (site === 'record' ? audit.record({ principal: 'reader', method: 'Bootstrap', outcome: 'Denied', cause: 'INVALID_CREDENTIAL', reason: 'local recovery exercise', correlationId: 'corr-test' }) : throttle[site]('reader')).catch(error => error)
  expect(startErrorCode(error)).toBe('PG_STATEMENT_TIMEOUT')
})
it('R1 invalid credential failure is counted before an audit outage is attempted', async () => {
  let failures = 0
  const attempted: string[] = []
  const verify = createLocalAccessVerifier({ mode: 'Bootstrap', accounts: [], authorizationRevision: 'rev', sessionStore: { create: vi.fn() },
    throttle: { blocked: async () => false, failure: async () => { await new Promise(r => setTimeout(r, 5)); failures++; attempted.push('failure') }, success: vi.fn() },
    derive: async () => Buffer.alloc(32), audit: async () => { attempted.push('audit'); expect(failures).toBe(1); throw new Error('audit unavailable') },
  })
  await expect(verify({ username: 'reader', password: 'wrong', reason: 'local recovery exercise' })).rejects.toMatchObject({ code: 'LOCAL_ACCESS_UNAVAILABLE', step: 'AUDIT' })
  expect(failures).toBe(1)
  expect(attempted).toEqual(['failure', 'audit'])
})
