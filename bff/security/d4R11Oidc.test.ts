// @vitest-environment node
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { startErrorCode } from '../diagnostics.mjs'
const exec = promisify(execFile)
const classify = (error: unknown) => {
  let result: string | null | undefined
  expect(() => { result = startErrorCode(error) }).not.toThrow()
  return result
}

it('K2 K3 real openid-client preserves protocol context and distinct strict TLS failures', async () => {
  const { stdout } = await exec(process.execPath, ['bff/test-fixtures/d4R11OidcModes.mjs', 'all'], { timeout: 60000 })
  console.info('D4_R11_OIDC_REAL ' + stdout.trim())
  const results = stdout.trim().split('\n').map(line => JSON.parse(line))
  const expected = {
    bodycode: 'OAUTH_RESPONSE_BODY_ERROR', bodycodeallowed: 'OAUTH_RESPONSE_BODY_ERROR', bodycause: 'OAUTH_RESPONSE_BODY_ERROR',
    wrongname: 'ERR_TLS_CERT_ALTNAME_INVALID', untrusted: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', selfsigned: 'DEPTH_ZERO_SELF_SIGNED_CERT',
    expired: 'CERT_HAS_EXPIRED', future: 'CERT_NOT_YET_VALID',
    html500: 'OAUTH_RESPONSE_IS_NOT_CONFORM', json500: 'OAUTH_RESPONSE_IS_NOT_CONFORM', notjson: 'OAUTH_RESPONSE_IS_NOT_JSON', malformedjson: 'OAUTH_PARSE_ERROR', noaccess: 'OAUTH_INVALID_RESPONSE',
    noid: 'OIDC_ID_TOKEN_MISSING', badstate: 'OAUTH_INVALID_RESPONSE', grant: 'OAUTH_RESPONSE_BODY_ERROR', reset: 'ECONNRESET', enotfound: 'ENOTFOUND',
    chainroot: 'SELF_SIGNED_CERT_IN_CHAIN', chainintermediate: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', client401: 'OAUTH_WWW_AUTHENTICATE_CHALLENGE',
  }
  expect(results.map(result => result.mode)).toEqual(Object.keys(expected))
  for (const result of results) {
    expect(result, result.mode).toMatchObject({ status: 401, cause: 'TOKEN_EXCHANGE', errorCode: expected[result.mode as keyof typeof expected] })
    expect(JSON.parse(result.body).error.code).toBe('OIDC_CALLBACK_REJECTED')
  }
}, 65000)

it('K2 cause traversal ignores untrusted records, accessors and cycles', () => {
  for (const cause of [{ code: 'ECONNREFUSED' }, { cause: { code: '57P01' } }, Object.assign(() => {}, { code: '57P01' })]) {
    expect(classify(Object.assign(new Error('opaque'), { code: 'OAUTH_RESPONSE_BODY_ERROR', cause }))).toBe('OAUTH_RESPONSE_BODY_ERROR')
  }
  const leaf = Object.assign(new Error('opaque'), { code: 'ECONNREFUSED' })
  expect(classify(Object.assign(new Error('opaque', { cause: leaf }), { code: 'OTHER_WRAPPER' }))).toBe('ECONNREFUSED')
  const cyclic = Object.assign(new Error('opaque'), { code: 'ECONNRESET' }); cyclic.cause = cyclic
  expect(classify(cyclic)).toBe('ECONNRESET')
  const accessor = Object.defineProperty(new Error('opaque'), 'cause', { get() { throw new Error('Accessor read') } })
  expect(classify(accessor)).toBe(null)
})

it('K3 missing ID token context stays distinct from invalid state and token validation', () => {
  const coded = (code: string, cause?: unknown) => Object.assign(new Error('opaque', { cause }), { code })
  const validBody = { access_token: 'fixture', token_type: 'Bearer' }
  expect(classify(coded('OAUTH_INVALID_RESPONSE', { body: validBody }))).toBe('OIDC_ID_TOKEN_MISSING')
  expect(classify(coded('OAUTH_INVALID_RESPONSE', { expected: 'state' }))).toBe('OAUTH_INVALID_RESPONSE')
  expect(classify(coded('OAUTH_INVALID_RESPONSE', { body: { ...validBody, id_token: 'invalid' } }))).toBe('OAUTH_INVALID_RESPONSE')
  expect(classify(coded('OAUTH_INVALID_RESPONSE', { body: { ...validBody, id_token: null } }))).toBe('OAUTH_INVALID_RESPONSE')
  expect(classify(coded('OAUTH_RESPONSE_BODY_ERROR', { body: validBody }))).toBe('OAUTH_RESPONSE_BODY_ERROR')
  expect(classify(coded('OAUTH_INVALID_RESPONSE'))).toBe('OAUTH_INVALID_RESPONSE')
  for (const body of [undefined, null, 'foreign', 42, true, [], () => {}, Object.assign([], validBody), Object.assign(() => {}, validBody), {}, { access_token: 'fixture' }, { token_type: 'Bearer' }]) {
    expect(classify(coded('OAUTH_INVALID_RESPONSE', { body }))).toBe('OAUTH_INVALID_RESPONSE')
  }
  for (const access_token of [undefined, null, '', 42, true, {}, []]) {
    expect(classify(coded('OAUTH_INVALID_RESPONSE', { body: { ...validBody, access_token } }))).toBe('OAUTH_INVALID_RESPONSE')
  }
  for (const token_type of [undefined, null, '', 42, true, {}, []]) {
    expect(classify(coded('OAUTH_INVALID_RESPONSE', { body: { ...validBody, token_type } }))).toBe('OAUTH_INVALID_RESPONSE')
  }
  for (const field of ['access_token', 'token_type']) {
    const inherited = Object.assign(Object.create({ [field]: validBody[field as keyof typeof validBody] }), field === 'access_token' ? { token_type: 'Bearer' } : { access_token: 'fixture' })
    expect(classify(coded('OAUTH_INVALID_RESPONSE', { body: inherited }))).toBe('OAUTH_INVALID_RESPONSE')
    const accessor = Object.defineProperty({ ...validBody }, field, { get() { throw new Error('Token marker accessor read') } })
    expect(classify(coded('OAUTH_INVALID_RESPONSE', { body: accessor }))).toBe('OAUTH_INVALID_RESPONSE')
  }
  expect(classify(coded('OAUTH_INVALID_RESPONSE', Object.create({ body: {} })))).toBe('OAUTH_INVALID_RESPONSE')
  const context = Object.defineProperty({}, 'body', { get() { throw new Error('Body accessor read') } })
  expect(classify(coded('OAUTH_INVALID_RESPONSE', context))).toBe('OAUTH_INVALID_RESPONSE')
})

it('K3 shared classifier preserves bounded database and decrypt failures', () => {
  for (const [code, expected] of [['23505', 'PG_UNIQUE_VIOLATION'], ['23514', 'PG_CHECK_VIOLATION'], ['DECRYPT_FAILED', 'DECRYPT_FAILED'], ['untrusted', 'OTHER']]) {
    expect(classify(Object.assign(new Error('opaque'), { code }))).toBe(expected)
  }
})

it('K3 strict TLS and protocol allowlist entries stay bounded', () => {
  for (const code of ['ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'OAUTH_RESPONSE_IS_NOT_CONFORM', 'OAUTH_RESPONSE_IS_NOT_JSON', 'OAUTH_PARSE_ERROR', 'OIDC_ID_TOKEN_MISSING', 'PG_UNIQUE_VIOLATION', 'PG_CHECK_VIOLATION', 'DECRYPT_FAILED']) {
    expect(classify(Object.assign(new Error('opaque'), { code })), code).toBe(code)
  }
})
