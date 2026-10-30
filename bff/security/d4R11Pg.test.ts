// @vitest-environment node
// K8g: protocol fixtures use the pinned real pg driver against a fake wire server.
// PostgreSQL-server state and Docker pause checks live in test-results/d4-r11/pg-real.sh.
import { createServer, type Socket } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import { PostgresSessionStore } from './postgresSessionStore.mjs'
import { pgQuery } from './pgFailure.mjs'
import { handleSessionHttp } from './httpSession.mjs'
import { digestSessionValue } from './session.mjs'
import { startErrorCode, createLifecycle, withLifecycle } from '../diagnostics.mjs'
const cookie = '__Host-ok_console_session=' + 'a'.repeat(43)
const authorization = { subject: { id: 'user', providerId: 'test', subjectId: 'test', displayName: 'User', method: 'OIDC', assurance: ['Federated'] }, scope: { environmentId: 'test', tenantIds: ['platform'] }, permissions: ['platform.read'], authorizationRevision: 'rev-test' }
const codec = { encrypt: () => ({ ciphertext: 'cipher', keyId: 'key' }), decrypt: () => authorization }
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const packet = (tag: string, body: Buffer) => { const h = Buffer.alloc(5); h.write(tag); h.writeInt32BE(body.length + 4, 1); return Buffer.concat([h, body]) }
const ready = Buffer.from('5a0000000549', 'hex')
const complete = Buffer.concat([packet('C', Buffer.from('SELECT 1\0')), ready])
const row = { session_digest: 'b'.repeat(64), session_family_digest: 'b'.repeat(64), key_id: 'key', context_envelope: 'cipher', csrf_digest: 'c'.repeat(64), authorization_revision: 'rev-test', deployment_epoch: 'epoch-test', issued_at: new Date().toISOString(), database_now: new Date().toISOString(), idle_expires_at: new Date(Date.now() + 60000).toISOString(), absolute_expires_at: new Date(Date.now() + 600000).toISOString(), idle_lifetime_ms: '60000', authentication_method: 'OIDC' }
const rowReply = () => {
  const fields = Object.entries(row); const n = Buffer.alloc(2); n.writeInt16BE(fields.length)
  const description = fields.map(([name]) => { const metadata = Buffer.alloc(18); metadata.writeInt32BE(25, 6); metadata.writeInt16BE(-1, 10); metadata.writeInt32BE(-1, 12); return Buffer.concat([Buffer.from(name + '\0'), metadata]) })
  const values = fields.map(([, value]) => { const data = Buffer.from(value); const size = Buffer.alloc(4); size.writeInt32BE(data.length); return Buffer.concat([size, data]) })
  return Buffer.concat([packet('T', Buffer.concat([n, ...description])), packet('D', Buffer.concat([n, ...values])), complete])
}
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
it('K8a real pg driver fake wire C57014 is classified independently of server message', async () => {
  const { pool } = await serve(socket => socket.write(Buffer.concat([packet('E', Buffer.from('SERROR\0VERROR\0C57014\0Munrelated private message\0\0')), ready])))
  const error = await pgQuery(pool, 'SELECT 1').catch(error => error)
  expect(error.code).toBe('PG_STATEMENT_TIMEOUT'); expect(startErrorCode(error)).toBe('PG_STATEMENT_TIMEOUT')
})
const boundaries = [ ['create', 'INSERT INTO'], ['rotate', 'SET revoked_at'], ['rotate', 'INSERT INTO'], ['rotate', 'COMMIT'], ['revoke', 'SET revoked_at'], ['revoke', 'COMMIT'], ['purgeExpired', 'DELETE FROM'] ] as const
it.each(boundaries)('K5 real pg client against protocol-level fake hang %s at %s retains timeout classification', async (operation, target) => {
  const { pool, queries } = await serve((socket, query) => { if (!query.includes(target)) socket.write(/BEGIN|ROLLBACK/.test(query) ? complete : rowReply()) })
  const store = new PostgresSessionStore({ pool, codec, deploymentEpoch: 'epoch-test' })
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const lifecycle = createLifecycle('corr-00000000-0000-4000-8000-000000000001')
  const error = await withLifecycle(lifecycle, () => target === 'COMMIT' ? handleSessionHttp({ request: { method: operation === 'rotate' ? 'POST' : 'DELETE', headers: { cookie, origin: 'https://console.invalid', 'x-csrf-token': 'token' } }, response: {}, correlationId: 'corr-00000000-0000-4000-8000-000000000001', pathname: '/api/console/v0/auth/session' + (operation === 'rotate' ? '/rotate' : ''), expectedOrigin: 'https://console.invalid', sessionStore: { resolve: async () => ({ csrfDigest: digestSessionValue('token'), subject: { method: 'OIDC' } }), rotate: value => store.rotate(value), revoke: value => store.revoke(value) } }) : operation === 'create' ? store.create(authorization) : operation === 'purgeExpired' ? store.purgeExpired() : store[operation](cookie)).catch(error => error)
  expect(startErrorCode(error)).toBe('PG_QUERY_TIMEOUT')
  if (target === 'COMMIT') {
    const cause = operation === 'rotate' ? 'SESSION_ROTATE_COMMIT' : 'SESSION_REVOKE_COMMIT'
    expect(error.step).toBe(cause); expect(error.cause.step).toBe(cause); expect(log).toHaveBeenCalledTimes(1); expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ cause, errorCode: 'PG_QUERY_TIMEOUT' })
  }
  if (operation === 'rotate' || operation === 'revoke') { expect(pool.totalCount).toBe(0); expect(queries.some(query => query.includes('ROLLBACK'))).toBe(false) }
  if (operation === 'purgeExpired') { expect(lifecycle.hasFailure(error)).toBe(true); expect(log).toHaveBeenCalledTimes(1); expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ cause: 'SESSION_PURGE', correlationId: 'corr-00000000-0000-4000-8000-000000000001', errorCode: 'PG_QUERY_TIMEOUT' }) }
})
it.each([['23505', 'PG_UNIQUE_VIOLATION'], ['23514', 'PG_CHECK_VIOLATION']])('K7 real pg driver fake wire SQLSTATE %s has bounded distinct code %s', async (code, expected) => {
  const { pool } = await serve(socket => socket.write(Buffer.concat([packet('E', Buffer.from(`SERROR\0VERROR\0C${code}\0Mprivate constraint detail\0\0`)), ready])))
  const store = new PostgresSessionStore({ pool, codec, deploymentEpoch: 'epoch-test' })
  expect(startErrorCode(await store.resolve(cookie).catch(error => error))).toBe(expected)
})
it('K7 real store decrypt failure retains DECRYPT_FAILED', async () => {
  const { pool } = await serve(socket => socket.write(rowReply()))
  const { SessionEnvelopeCodec } = await import('./envelope.mjs')
  const missingKeyCodec = new SessionEnvelopeCodec({ primaryKeyId: 'other', keys: { other: Buffer.alloc(32, 9) } })
  const store = new PostgresSessionStore({ pool, codec: missingKeyCodec, deploymentEpoch: 'epoch-test' })
  expect(startErrorCode(await store.resolve(cookie).catch(error => error))).toBe('DECRYPT_FAILED')
})
it('K8b real pg driver fake wire rotate INSERT 23505 destroys failed transaction without rollback and next rotate succeeds', async () => {
  let fail = true
  const { pool, queries, count } = await serve((socket, query) => {
    if (fail && query.includes('INSERT INTO')) { fail = false; socket.write(Buffer.concat([packet('E', Buffer.from('SERROR\0VERROR\0C23505\0Mduplicate\0\0')), ready])); return }
    socket.write(/BEGIN|COMMIT|ROLLBACK/.test(query) ? complete : rowReply())
  })
  const store = new PostgresSessionStore({ pool, codec, deploymentEpoch: 'epoch-test' })
  const error = await store.rotate(cookie).catch(error => error)
  expect(error.code).toBe('SESSION_COLLISION'); expect(startErrorCode(error)).toBe('PG_UNIQUE_VIOLATION')
  expect(pool.totalCount).toBe(0); expect(queries.some(query => query.includes('ROLLBACK'))).toBe(false)
  await expect(store.rotate(cookie)).resolves.toMatchObject({ cookie: expect.any(String) })
  expect(count()).toBe(2)
})
