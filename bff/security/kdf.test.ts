// @vitest-environment node

import { pbkdf2, pbkdf2Sync, scrypt, scryptSync } from 'node:crypto'
import { promisify } from 'node:util'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createKdf, KdfUnavailableError } from './kdf.mjs'
import { createLocalAccessVerifier } from './localAccess.mjs'
import { LocalIdentity } from './localIdentity.mjs'

const FAST = { N: 1024, r: 8, p: 1 }
const salt = Buffer.alloc(16, 7)
const closers: Array<() => Promise<void>> = []
const kdfFor = (options = {}) => {
  const kdf = createKdf(options)
  closers.push(() => kdf.close())
  return kdf
}
const until = async (predicate: () => boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > end) throw new Error('condition not reached')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
// A worker that never answers: stands in for a derivation that cannot finish in time.
const stuckWorkers: Worker[] = []
const stuckFactory = () => {
  const worker = new Worker("require('node:worker_threads').parentPort.on('message', () => { for (;;) {} })", { eval: true })
  stuckWorkers.push(worker)
  return worker
}

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()))
  await Promise.all(stuckWorkers.splice(0).map((worker) => worker.terminate()))
})

describe('bounded key derivation', () => {
  it('derives the same key as node:crypto scrypt and reuses one worker per slot', async () => {
    const factory = vi.fn(() => new Worker(`
      const { parentPort } = require('node:worker_threads'); const { scryptSync } = require('node:crypto')
      parentPort.on('message', ({ id, password, salt, keylen, params }) => parentPort.postMessage({ id, key: scryptSync(password, salt, keylen, params) }))`, { eval: true }))
    const kdf = kdfFor({ slots: 1, workerFactory: factory })
    for (const password of ['first password', 'second password']) {
      const lease = kdf.acquire()
      expect(await lease.derive(password, salt, 32, FAST)).toEqual(scryptSync(password, salt, 32, FAST))
      lease.release()
    }
    expect(factory).toHaveBeenCalledTimes(1)
    expect(kdf.held).toBe(0)
    // The production worker source derives the same bytes as the factory above.
    const real = kdfFor({ slots: 1 })
    const lease = real.acquire()
    expect(await lease.derive('first password', salt, 32, FAST)).toEqual(scryptSync('first password', salt, 32, FAST))
  })

  it('completes while the libuv threadpool is saturated, where promisified scrypt waits behind it', async () => {
    // Size blockers from a measurement so each occupies a pool thread for ~1.5 s.
    const started = Date.now()
    pbkdf2Sync('x', 'y', 20_000, 64, 'sha512')
    const iterations = Math.ceil(20_000 * 1500 / Math.max(1, Date.now() - started))
    const poolSize = Number(process.env.UV_THREADPOOL_SIZE) || 4
    const order: string[] = []
    const blockers = Array.from({ length: poolSize }, (_, index) => promisify(pbkdf2)('x', `y${index}`, iterations, 64, 'sha512').then(() => order.push('blocker')))
    const legacy = promisify(scrypt)('password', salt, 32, FAST).then(() => order.push('legacy'))
    const kdf = kdfFor({ slots: 1 })
    const lease = kdf.acquire()
    await lease.derive('password', salt, 32, FAST).then(() => order.push('bounded'))
    await Promise.all([...blockers, legacy])
    // The bounded derivation finished before any pool work; the legacy one only after a blocker.
    expect(order[0]).toBe('bounded')
    expect(order.indexOf('legacy')).toBeGreaterThan(order.indexOf('blocker'))
  }, 30_000)

  it('rejects at the deadline, terminates the worker and holds the slot until the thread has exited', async () => {
    const kdf = kdfFor({ slots: 1, deadlineMs: 150, workerFactory: stuckFactory })
    const lease = kdf.acquire()
    const exited = new Promise((resolve) => setImmediate(() => stuckWorkers[0].once('exit', resolve)))
    await expect(lease.derive('password', salt, 32, FAST)).rejects.toMatchObject({ reason: 'DEADLINE' })
    lease.release()
    // Still held immediately after the rejection: the worker has not necessarily exited yet.
    expect(kdf.held).toBe(1)
    expect(() => kdf.acquire()).toThrow(KdfUnavailableError)
    await exited
    await until(() => kdf.held === 0)
    expect(kdf.idle).toBe(0)
    const next = kdf.acquire()
    next.release()
    expect(kdf.held).toBe(0)
  })

  it('refuses beyond capacity without queueing, and frees an unused lease on release', async () => {
    const kdf = kdfFor({ slots: 2 })
    const first = kdf.acquire(), second = kdf.acquire()
    expect(() => kdf.acquire()).toThrow(expect.objectContaining({ reason: 'CAPACITY' }))
    first.release()
    first.release()
    expect(kdf.held).toBe(1)
    second.release()
    expect(kdf.held).toBe(0)
    await expect(second.derive('password', salt, 32, FAST)).rejects.toMatchObject({ reason: 'LEASE_USED' })
  })

  it('fails closed on invalid parameters and discards that worker', async () => {
    const kdf = kdfFor({ slots: 1 })
    const lease = kdf.acquire()
    await expect(lease.derive('password', salt, 32, { N: 3, r: 8, p: 1 })).rejects.toMatchObject({ reason: 'FAILED' })
    await until(() => kdf.held === 0)
    expect(kdf.idle).toBe(0)
  })

  it.each([{ slots: 0 }, { slots: 1.5 }, { deadlineMs: 0 }, { deadlineMs: Infinity }, { workerFactory: 'x' }])('rejects invalid configuration %j', (options) => {
    expect(() => createKdf(options as never)).toThrow(TypeError)
  })
})

describe('login paths use the bounded derivation', () => {
  const account = (password: string) => ({
    username: 'recovery-admin', enabled: true, salt: salt.toString('base64'),
    verifier: scryptSync(password, salt, 32, { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('base64'),
    identityId: 'local-1', displayName: 'Recovery Admin', environmentId: 'prod', tenantIds: ['platform'], permissions: ['platform.read'],
  })
  const verifierWith = (kdf: ReturnType<typeof createKdf>) => {
    const throttle = { reserve: vi.fn(async () => ({ blocked: false })), success: vi.fn(async () => ({ refused: false })) }
    const sessionStore = { create: vi.fn(async () => ({ cookie: 'session' })) }
    const verify = createLocalAccessVerifier({ mode: 'BreakGlass', accounts: [account('correct horse battery')], throttle, sessionStore, authorizationRevision: 'rbac-1', kdf })
    return { verify, throttle, sessionStore }
  }
  const input = (password: string) => ({ username: 'recovery-admin', password, reason: 'OIDC provider recovery', correlationId: 'c' })

  it('verifies exceptional access through the KDF by default', async () => {
    const { verify, sessionStore } = verifierWith(kdfFor())
    await expect(verify(input('correct horse battery'))).resolves.toMatchObject({ cookie: 'session' })
    await expect(verify(input('wrong horse battery'))).rejects.toMatchObject({ code: 'LOCAL_ACCESS_REJECTED' })
    expect(sessionStore.create).toHaveBeenCalledTimes(1)
  })

  it('refuses exceptional access at capacity before consuming a throttle attempt', async () => {
    const kdf = kdfFor({ slots: 1 })
    const held = kdf.acquire()
    const { verify, throttle } = verifierWith(kdf)
    await expect(verify(input('correct horse battery'))).rejects.toMatchObject({ code: 'LOCAL_ACCESS_UNAVAILABLE', step: 'KDF' })
    expect(throttle.reserve).not.toHaveBeenCalled()
    held.release()
  })

  it('maps an exceptional-access KDF deadline to unavailable and frees the slot after the worker exits', async () => {
    const kdf = kdfFor({ slots: 1, deadlineMs: 100, workerFactory: stuckFactory })
    const { verify, sessionStore } = verifierWith(kdf)
    await expect(verify(input('correct horse battery'))).rejects.toMatchObject({ code: 'LOCAL_ACCESS_UNAVAILABLE', step: 'KDF' })
    expect(sessionStore.create).not.toHaveBeenCalled()
    await until(() => kdf.held === 0)
  })

  it('maps an ordinary-login KDF deadline to 503 and frees the slot after the worker exits', async () => {
    const kdf = kdfFor({ slots: 2, deadlineMs: 100, workerFactory: stuckFactory })
    const identity = new LocalIdentity({ pool: {}, sessions: {}, throttle: {}, scope: {}, authorizationRevision: 'r', kdf })
    await expect(identity.hash('password', salt)).rejects.toMatchObject({ status: 503 })
    expect(identity.hashing).toBe(1)
    await until(() => identity.hashing === 0)
    // Capacity is the KDF's: two leases out means the next ordinary hash is refused with 503.
    const leases = [identity.hashSlot(), identity.hashSlot()]
    expect(() => identity.hashSlot()).toThrow(expect.objectContaining({ status: 503 }))
    leases.forEach((lease) => lease.release())
    expect(identity.hashing).toBe(0)
  })
})
