import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ENVELOPE_VERSION = 'v1'
const AAD = Buffer.from('auth.console.openkubes.io/console-session-envelope/v1')
const MAX_ENVELOPE_BYTES = 256 * 1_024

export class SessionEnvelopeError extends Error {
  constructor() {
    super('Session envelope processing failed.')
    this.name = 'SessionEnvelopeError'
  }
}

const keyBuffer = (value) => Buffer.isBuffer(value) ? value : Buffer.from(value ?? '', 'base64')

export class SessionEnvelopeCodec {
  constructor({ primaryKeyId, keys, random = randomBytes }) {
    if (typeof primaryKeyId !== 'string' || primaryKeyId.length === 0 || !keys || typeof random !== 'function') {
      throw new SessionEnvelopeError()
    }
    this.keys = new Map(Object.entries(keys).map(([keyId, value]) => [keyId, keyBuffer(value)]))
    if (![...this.keys.values()].every((key) => key.length === 32) || !this.keys.has(primaryKeyId)) {
      throw new SessionEnvelopeError()
    }
    this.primaryKeyId = primaryKeyId
    this.random = random
  }

  encrypt(value) {
    try {
      const plaintext = Buffer.from(JSON.stringify(value), 'utf8')
      if (plaintext.length === 0 || plaintext.length > MAX_ENVELOPE_BYTES) throw new SessionEnvelopeError()
      const nonce = this.random(12)
      if (!Buffer.isBuffer(nonce) || nonce.length !== 12) throw new SessionEnvelopeError()
      const cipher = createCipheriv('aes-256-gcm', this.keys.get(this.primaryKeyId), nonce)
      cipher.setAAD(AAD)
      const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
      const tag = cipher.getAuthTag()
      return {
        keyId: this.primaryKeyId,
        ciphertext: [ENVELOPE_VERSION, nonce.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.'),
      }
    } catch {
      throw new SessionEnvelopeError()
    }
  }

  decrypt({ keyId, ciphertext }) {
    try {
      const key = this.keys.get(keyId)
      if (typeof ciphertext !== 'string' || ciphertext.length === 0 || ciphertext.length > MAX_ENVELOPE_BYTES * 2) {
        throw new SessionEnvelopeError()
      }
      const [version, nonceValue, tagValue, encryptedValue, extra] = String(ciphertext).split('.')
      if (!key || version !== ENVELOPE_VERSION || extra !== undefined) throw new SessionEnvelopeError()
      const nonce = Buffer.from(nonceValue, 'base64url')
      const tag = Buffer.from(tagValue, 'base64url')
      const encrypted = Buffer.from(encryptedValue, 'base64url')
      if (nonce.length !== 12 || tag.length !== 16 || encrypted.length === 0) throw new SessionEnvelopeError()
      const decipher = createDecipheriv('aes-256-gcm', key, nonce)
      decipher.setAAD(AAD)
      decipher.setAuthTag(tag)
      return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8'))
    } catch {
      throw new SessionEnvelopeError()
    }
  }
}
