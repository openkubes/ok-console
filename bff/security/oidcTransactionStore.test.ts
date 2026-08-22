// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import { PostgresOidcTransactionStore } from './oidcTransactionStore.mjs'

const payload = { codeVerifier: 'verifier', state: 'state', nonce: 'nonce' }

describe('PostgreSQL OIDC transaction store', () => {
  it('stores an encrypted transaction behind a digest-only reference', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }))
    const codec = { encrypt: vi.fn(() => ({ keyId: 'key-1', ciphertext: 'encrypted' })), decrypt: vi.fn() }
    const store = new PostgresOidcTransactionStore({ pool: { query }, codec, deploymentEpoch: 'epoch-1', random: () => Buffer.alloc(32, 3) })
    const issued = await store.create(payload)
    const parameters = query.mock.calls[0][1]

    expect(codec.encrypt).toHaveBeenCalledWith(payload)
    expect(parameters).toEqual([expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), 'encrypted', 'key-1', 'epoch-1', 300])
    expect(issued.cookie).toContain('__Host-ok_console_oidc=')
    expect(issued.cookie).toContain('Secure')
    expect(issued.cookie).toContain('HttpOnly')
    expect(JSON.stringify(parameters)).not.toContain(issued.cookie.split('=')[1]?.split(';')[0])
  })

  it('atomically deletes and decrypts a transaction exactly once', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ payload_envelope: 'encrypted', key_id: 'key-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    const codec = { encrypt: vi.fn(), decrypt: vi.fn(() => payload) }
    const store = new PostgresOidcTransactionStore({ pool: { query }, codec, deploymentEpoch: 'epoch-1' })
    const cookie = '__Host-ok_console_oidc=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

    await expect(store.consume(cookie)).resolves.toEqual(payload)
    await expect(store.consume(cookie)).resolves.toBeNull()
    expect(query.mock.calls[0][0]).toContain('DELETE FROM ok_console.oidc_transactions')
    expect(codec.decrypt).toHaveBeenCalledTimes(1)
  })

  it('rejects duplicate cookie values before touching PostgreSQL', async () => {
    const query = vi.fn()
    const store = new PostgresOidcTransactionStore({
      pool: { query }, codec: { encrypt: vi.fn(), decrypt: vi.fn() }, deploymentEpoch: 'epoch-1',
    })
    await expect(store.consume('__Host-ok_console_oidc=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA; __Host-ok_console_oidc=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB')).resolves.toBeNull()
    expect(query).not.toHaveBeenCalled()
  })
})
