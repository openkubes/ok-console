// @vitest-environment node
import { readFileSync } from 'node:fs'
import { CONSOLE_ERROR_REASONS } from '../../src/domain/presentationContract'
import schema from '../../contracts/presentation/v0alpha1/schema.json'
import { describe, expect, it } from 'vitest'
import { classifySourceFailure, sourceFailureLogLine, sourceHttpError, sourceDeadlineError, contractFailure } from './sourceFailure.mjs'

const trust = `UNSPECIFIED UNABLE_TO_GET_ISSUER_CERT UNABLE_TO_GET_CRL UNABLE_TO_DECRYPT_CERT_SIGNATURE UNABLE_TO_DECRYPT_CRL_SIGNATURE UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY CERT_SIGNATURE_FAILURE CRL_SIGNATURE_FAILURE CERT_NOT_YET_VALID CERT_HAS_EXPIRED CRL_NOT_YET_VALID CRL_HAS_EXPIRED ERROR_IN_CERT_NOT_BEFORE_FIELD ERROR_IN_CERT_NOT_AFTER_FIELD ERROR_IN_CRL_LAST_UPDATE_FIELD ERROR_IN_CRL_NEXT_UPDATE_FIELD DEPTH_ZERO_SELF_SIGNED_CERT SELF_SIGNED_CERT_IN_CHAIN UNABLE_TO_GET_ISSUER_CERT_LOCALLY UNABLE_TO_VERIFY_LEAF_SIGNATURE CERT_CHAIN_TOO_LONG CERT_REVOKED INVALID_CA PATH_LENGTH_EXCEEDED INVALID_PURPOSE CERT_UNTRUSTED CERT_REJECTED HOSTNAME_MISMATCH ERR_TLS_CERT_ALTNAME_INVALID ERR_TLS_CERT_ALTNAME_FORMAT`.split(' ')
const unreachable = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETDOWN', 'EHOSTDOWN', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT']
const ambiguous = ['ECONNRESET', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE']
const alertNames = ['UNKNOWN_CA', 'BAD_CERTIFICATE', 'CERTIFICATE_UNKNOWN', 'CERTIFICATE_EXPIRED', 'CERTIFICATE_REVOKED', 'UNSUPPORTED_CERTIFICATE', 'HANDSHAKE_FAILURE', 'ACCESS_DENIED', 'DECRYPT_ERROR', 'CERTIFICATE_REQUIRED']
const alerts = ['SSLV3', 'TLSV1', 'TLSV13', 'SSL/TLS'].flatMap((family) => alertNames.map((name) => `ERR_SSL_${family}_ALERT_${name}`))
const canary = 'password=canary-super-secret /secret/cert.pem issuer=private.example 192.0.2.9'

describe('closed source failure observations', () => {
  for (const [codes, classification, reason] of [[trust, 'TRUST_REJECTED', 'CERTIFICATE_VERIFICATION'], [unreachable, 'SOURCE_UNREACHABLE', 'TRANSPORT_FAILURE'], [ambiguous, 'INCONCLUSIVE', 'TRANSPORT_AMBIGUOUS'], [alerts, 'INCONCLUSIVE', 'PEER_TLS_ALERT']] as const) {
    it.each(codes)('classifies own code %s', (code) => {
      const diagnostic = classifySourceFailure({ code, message: canary, cert: canary })
      expect(diagnostic).toEqual({ class: classification, reason, nodeCode: reason === 'PEER_TLS_ALERT' ? code.split('_ALERT_')[1] : code, httpStatus: 'NONE' })
      expect(Object.isFrozen(diagnostic)).toBe(true)
      const line = sourceFailureLogLine('/api/console/v0/overview', diagnostic, 'corr-test')
      expect(Object.keys(JSON.parse(line))).toEqual(['time', 'stage', 'route', 'correlationId', 'class', 'reason', 'nodeCode', 'httpStatus', 'failedStage', 'elapsedMs', 'phaseMs', 'wallClockStepMs', 'clockOffsetMs', 'clockStepSinceLastObservationMs', 'lastObservationAgeMs', 'stages'])
      expect(Buffer.byteLength(line + '\n')).toBeLessThanOrEqual(512)
      expect(line).not.toContain(canary)
    })
  }
  it.each([undefined, null, {}, { code: null }, { code: 503 }, { code: {} }, { code: 'ERR_SSL_FAKE_ALERT' }, { code: 'ERR_SSL_FOREIGN_ALERT_UNKNOWN_CA' }, ...['SSLV3', 'TLSV1', 'SSL/TLS', 'TLSV13'].flatMap((family) => ['ARBITRARY', 'UNKNOWN_CA_suffix', 'unknown_ca', 'UNKNOWN_CA\n'].map((name) => ({ code: `ERR_SSL_${family}_ALERT_${name}` }))), { code: 'CERT_HAS_EXPIRED_suffix' }, { code: 'cert_has_expired' }, { message: 'CERT_HAS_EXPIRED' }, { cause: { code: 'CERT_HAS_EXPIRED' } }, new AggregateError([{ code: 'CERT_HAS_EXPIRED' }]), Object.create({ code: 'CERT_HAS_EXPIRED' }), { get code() { throw new Error(canary) } }])('ignores unknown, nested, inherited and accessor codes %#', (error) => {
    expect(classifySourceFailure(error)).toEqual({ class: 'INCONCLUSIVE', reason: 'UNCLASSIFIED', nodeCode: 'OTHER', httpStatus: 'NONE' })
  })
  it('ignores cyclic and conflicting causes and secret fields', () => {
    const error = { code: 'ECONNRESET', cause: null as unknown, errors: [{ code: 'CERT_HAS_EXPIRED' }], message: canary }
    error.cause = error
    expect(classifySourceFailure(error).class).toBe('INCONCLUSIVE')
    const line = sourceFailureLogLine('/api/console/v0/clusters/' + canary, classifySourceFailure(error), 'corr-test')
    expect(Object.keys(JSON.parse(line))).toEqual(['time', 'stage', 'route', 'correlationId', 'class', 'reason', 'nodeCode', 'httpStatus', 'failedStage', 'elapsedMs', 'phaseMs', 'wallClockStepMs', 'clockOffsetMs', 'clockStepSinceLastObservationMs', 'lastObservationAgeMs', 'stages'])
    expect(JSON.parse(line).route).toBe('OTHER')
    expect(Buffer.byteLength(line + '\n')).toBeLessThanOrEqual(512)
    expect(line).not.toContain(canary)
  })
  it.each([[401, 'IDENTITY_REJECTED', 'IDENTITY_REJECTED'], [403, 'IDENTITY_REJECTED', 'IDENTITY_REJECTED'], [500, 'HTTP_SERVER_ERROR', '5XX'], [599, 'HTTP_SERVER_ERROR', '5XX'], [302, 'HTTP_NON_SUCCESS', 'OTHER'], [404, 'HTTP_NON_SUCCESS', 'OTHER']])('closes HTTP status %s', (status, reason, httpStatus) => {
    expect(classifySourceFailure(sourceHttpError(status))).toEqual({ class: 'INCONCLUSIVE', reason, nodeCode: 'OTHER', httpStatus })
  })
  it('keeps EPROTO inconclusive', () => {
    expect(classifySourceFailure({ code: 'EPROTO' })).toEqual({ class: 'INCONCLUSIVE', reason: 'TLS_PROTOCOL_FAILURE', nodeCode: 'EPROTO', httpStatus: 'NONE' })
  })
  it('has explicit deadline and contract observations', () => {
    expect(classifySourceFailure(sourceDeadlineError())).toEqual({ class: 'SOURCE_UNREACHABLE', reason: 'DEADLINE_EXCEEDED', nodeCode: 'OTHER', httpStatus: 'NONE' })
    expect(contractFailure()).toEqual({ class: 'CONTRACT_INCOMPATIBLE', reason: 'CONTRACT_VALIDATION', nodeCode: 'OTHER', httpStatus: 'NONE' })
    expect(classifySourceFailure({ code: 'ABORT_ERR' }).class).toBe('INCONCLUSIVE')
  })
})

// Derive the vocabulary from every observation emitted by the classifier. This
// makes a new/renamed classifier reason require matching schema and TS changes.
it('ties classifier outputs to the schema enum and TypeScript reason union', () => {
  const reasons = new Set([
    ...[...trust, ...unreachable, ...ambiguous, ...alerts, 'EPROTO', 'unknown'].map((code) => classifySourceFailure({ code }).reason),
    ...[401, 503, 404].map((status) => classifySourceFailure(sourceHttpError(status)).reason),
    classifySourceFailure(sourceDeadlineError()).reason,
    classifySourceFailure(sourceDeadlineError(true)).reason,
  ])
  // Ensure the enumerated test inputs cover every literal reason in production.
  const classifier = readFileSync(new URL('./sourceFailure.mjs', import.meta.url), 'utf8')
  const literals = [...classifier.matchAll(/observation\(\s*'[^']+',\s*([^,)]+)/g)].flatMap((match) => [...match[1].matchAll(/'([^']+)'/g)].map((literal) => literal[1]))
  for (const reason of literals.filter((item) => item !== 'CONTRACT_VALIDATION')) expect(reasons.has(reason)).toBe(true)
  expect([...reasons].sort()).toEqual([...schema.$defs.errorResponse.properties.error.properties.reason.enum].sort())
  const source = readFileSync(new URL('../../src/domain/presentationContract.ts', import.meta.url), 'utf8')
  const declaration = source.split('export interface ConsoleErrorResponse {')[1].split('export ')[0]
  const union = /reason\?: ([^\n]+)/.exec(declaration)?.[1] ?? ''
  expect(union).toBe('ConsoleErrorReason')
  expect(source).toContain('export type ConsoleErrorReason = (typeof CONSOLE_ERROR_REASONS)[number]')
  expect(source).toMatch(/export const CONSOLE_ERROR_REASONS = \[[^\n]+\] as const/)
  expect([...CONSOLE_ERROR_REASONS].sort()).toEqual([...reasons].sort())
})

it.each(['x'.repeat(4096), 'corr-' + 'a'.repeat(4096), 'corr-00000000-0000-0000-0000-000000000000\n', 'password=private', 42, null, {}, undefined])('bounds untrusted correlation IDs locally %#', (id) => {
  const line = sourceFailureLogLine('/api/console/v0/overview', classifySourceFailure({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }), id)
  expect(JSON.parse(line).correlationId).toBe('OTHER')
  expect(Buffer.byteLength(line + '\n')).toBeLessThanOrEqual(512)
  expect(line).not.toContain('password=private')
})
it('preserves a server-format correlation ID', () => {
  const id = 'corr-12345678-1234-1234-1234-123456789abc'
  expect(JSON.parse(sourceFailureLogLine('/', classifySourceFailure({}), id)).correlationId).toBe(id)
})

it.each(['ERR_SSL_TLSV12_ALERT_UNKNOWN_CA', 'ERR_SSL_TLSV130_ALERT_UNKNOWN_CA'])('rejects nearby alert families %s', (code) => {
  expect(classifySourceFailure({ code })).toEqual({ class: 'INCONCLUSIVE', reason: 'UNCLASSIFIED', nodeCode: 'OTHER', httpStatus: 'NONE' })
})
