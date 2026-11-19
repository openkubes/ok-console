import { Worker } from 'node:worker_threads'

// Bounded password key derivation.
//
// node:crypto's async scrypt runs on libuv's shared threadpool, so a login can queue
// behind unrelated blocking work with no upper bound. Here each slot owns a dedicated
// worker thread that derives synchronously, so a login never waits on that pool.
// A derivation that misses its deadline is rejected AND its worker is terminated; the
// slot stays held until that thread has actually exited, so the number of concurrent
// derivations (and their memory) never exceeds `slots`, even after timeouts.

export const KDF_DEADLINE_MS = 10_000

export class KdfUnavailableError extends Error {
  constructor(reason, options) {
    super('Key derivation is unavailable.', options)
    this.name = 'KdfUnavailableError'
    this.reason = reason
  }
}

const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads')
const { scryptSync } = require('node:crypto')
parentPort.on('message', ({ id, password, salt, keylen, params }) => {
  let key
  try { key = scryptSync(password, salt, keylen, params) } catch { parentPort.postMessage({ id, failed: true }); return }
  parentPort.postMessage({ id, key })
})`

const defaultWorkerFactory = () => new Worker(WORKER_SOURCE, { eval: true })

export const createKdf = ({ slots = 2, deadlineMs = KDF_DEADLINE_MS, workerFactory = defaultWorkerFactory } = {}) => {
  if (!Number.isInteger(slots) || slots < 1 || !Number.isFinite(deadlineMs) || deadlineMs <= 0 || typeof workerFactory !== 'function') {
    throw new TypeError('Invalid key derivation configuration.')
  }
  const idle = []
  let held = 0
  let sequence = 0

  const run = (worker, message) => new Promise((resolve, reject) => {
    const finish = (error, key) => {
      clearTimeout(timer)
      worker.off('message', onMessage)
      worker.off('error', onError)
      worker.off('exit', onExit)
      if (error) reject(error)
      else resolve(key)
    }
    const onMessage = (reply) => {
      if (reply?.id !== message.id) return
      if (reply.failed || !(reply.key instanceof Uint8Array) || reply.key.byteLength !== message.keylen) finish(new KdfUnavailableError('FAILED'))
      else finish(null, Buffer.from(reply.key.buffer, reply.key.byteOffset, reply.key.byteLength))
    }
    const onError = (cause) => finish(new KdfUnavailableError('FAILED', { cause }))
    const onExit = () => finish(new KdfUnavailableError('EXITED'))
    const timer = setTimeout(() => finish(new KdfUnavailableError('DEADLINE')), deadlineMs)
    worker.on('message', onMessage)
    worker.on('error', onError)
    worker.on('exit', onExit)
    worker.postMessage(message)
  })

  // A lease is one slot for one derivation. It is returned when the derivation has settled
  // and no worker is still computing for it, or when release() is called on an unused lease.
  // release() on a lease whose derivation is still running never frees the slot early.
  const acquire = () => {
    if (held >= slots) throw new KdfUnavailableError('CAPACITY')
    held++
    let used = false, released = false, busy = false, freed = false
    const free = () => {
      if (freed || !released || busy) return
      freed = true
      held--
    }
    return {
      async derive(password, salt, keylen, params) {
        if (used || released) throw new KdfUnavailableError('LEASE_USED')
        used = true
        busy = true
        let worker
        try { worker = idle.pop() ?? workerFactory() } catch (cause) {
          busy = false
          released = true
          free()
          throw new KdfUnavailableError('FAILED', { cause })
        }
        worker.ref()
        try {
          const key = await run(worker, { id: ++sequence, password, salt, keylen, params })
          worker.unref()
          idle.push(worker)
          busy = false
          released = true
          free()
          return key
        } catch (error) {
          // Never reuse a worker after a failure: it may still be computing. Hold the slot
          // until the thread is gone so a timed-out derivation cannot outlive its bound.
          released = true
          Promise.resolve().then(() => worker.terminate()).catch(() => {}).finally(() => {
            busy = false
            free()
          })
          throw error
        }
      },
      release() {
        released = true
        free()
      },
    }
  }

  return {
    acquire,
    get held() { return held },
    get idle() { return idle.length },
    async close() {
      await Promise.all(idle.splice(0).map((worker) => worker.terminate().catch(() => {})))
    },
  }
}
