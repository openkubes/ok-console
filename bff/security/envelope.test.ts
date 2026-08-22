// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { SessionEnvelopeCodec, SessionEnvelopeError } from './envelope.mjs'

const keyOne = Buffer.alloc(32, 1)
const keyTwo = Buffer.alloc(32, 2)

describe('ADR-038 session envelope', () => {
  it('round-trips an encrypted context without exposing plaintext', () => {
    const codec = new SessionEnvelopeCodec({ primaryKeyId: 'key-1', keys: { 'key-1': keyOne } })
    const value = { subject: { id: 'subject-private' }, permissions: ['platform.read'] }
    const encrypted = codec.encrypt(value)

    expect(encrypted.keyId).toBe('key-1')
    expect(encrypted.ciphertext).not.toContain('subject-private')
    expect(codec.decrypt(encrypted)).toEqual(value)
  })

  it('fails closed for tampering, unknown keys and invalid key material', () => {
    const codec = new SessionEnvelopeCodec({ primaryKeyId: 'key-1', keys: { 'key-1': keyOne } })
    const encrypted = codec.encrypt({ value: 'protected' })
    const tampered = `${encrypted.ciphertext.slice(0, -1)}A`

    expect(() => codec.decrypt({ ...encrypted, ciphertext: tampered })).toThrow(SessionEnvelopeError)
    expect(() => codec.decrypt({ ...encrypted, keyId: 'missing' })).toThrow(SessionEnvelopeError)
    expect(() => codec.encrypt({ oversized: 'x'.repeat(300_000) })).toThrow(SessionEnvelopeError)
    expect(() => codec.decrypt({ keyId: 'key-1', ciphertext: 'x'.repeat(600_000) })).toThrow(SessionEnvelopeError)
    expect(() => new SessionEnvelopeCodec({ primaryKeyId: 'short', keys: { short: Buffer.alloc(8) } })).toThrow(SessionEnvelopeError)
  })

  it('supports a bounded read-old/write-new key rotation window', () => {
    const oldCodec = new SessionEnvelopeCodec({ primaryKeyId: 'key-1', keys: { 'key-1': keyOne } })
    const rotatingCodec = new SessionEnvelopeCodec({
      primaryKeyId: 'key-2',
      keys: { 'key-1': keyOne, 'key-2': keyTwo },
    })
    const oldEnvelope = oldCodec.encrypt({ revision: 1 })
    const newEnvelope = rotatingCodec.encrypt({ revision: 2 })

    expect(rotatingCodec.decrypt(oldEnvelope)).toEqual({ revision: 1 })
    expect(newEnvelope.keyId).toBe('key-2')
    expect(rotatingCodec.decrypt(newEnvelope)).toEqual({ revision: 2 })
  })
})
