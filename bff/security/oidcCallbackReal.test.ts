// @vitest-environment node
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { beforeAll, expect, it, vi } from 'vitest'

import { execBudgetMs, hookBudgetMs } from '../test-fixtures/oidcCallbackBudgets.mjs'

const exec = promisify(execFile)
type Result = {
  cookieStrings: string[]; status: number; error: string | null; cookieNames: string[]; onlyClearTransaction: boolean
  sessions: number; transactions: number; audit: { method: string; outcome: string; cause: string }[]
  leaks: string[]; tokenRequests: number; redemptions: number; signedTokens: number; jwks: number
}
type Flow = { elapsedMs: number; fixtureError?: string; mode: string; rejected: string[]; start: { status: number; method: string; challengeMatches: boolean; stateMatches: boolean; nonceMatches: boolean; redirectMatches: boolean }; first: Result; replay?: Result }
const knownModes = ['positive', 'wrong-iss', 'wrong-aud', 'multi-aud-no-azp', 'multi-aud-foreign-azp', 'nonce', 'state', 'pkce', 'redirect', 'expired', 'future-iat', 'future-nbf', 'token-untrusted-tls', 'token-wrong-name', 'http-issuer', 'replay', 'single-aud-foreign-azp', 'missing-id-token', 'nonstring-sub', 'untrusted-tls']
let flows: Flow[]
let childStderr: string
beforeAll(async () => {
  const { stdout, stderr } = await exec(process.execPath, ['bff/test-fixtures/oidcCallbackIssuer.mjs'], { timeout: execBudgetMs, env: Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(NODE_TLS_REJECT_UNAUTHORIZED|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|NODE_USE_ENV_PROXY|NODE_OPTIONS|NODE_EXTRA_CA_CERTS|OIDC_CALLBACK_TLS_DIR|OIDC_CALLBACK_UNTRUSTED)$/i.test(name))) })
  childStderr = stderr
  flows = stdout.trim().split('\n').map(line => JSON.parse(line))
  expect(flows.map(flow => flow.mode).sort()).toEqual([...knownModes].sort())
  console.info('OIDC_SCENARIO_TIMINGS ' + JSON.stringify(flows.map(({ mode, elapsedMs }) => ({ mode, elapsedMs }))))
}, hookBudgetMs)

const scenario = (mode: string) => {
  const flow = flows.find(value => value.mode === mode)!
  expect(flow).toBeDefined()
  if (flow.fixtureError) throw new Error(mode + ': ' + flow.fixtureError)
  return flow
}
const get = (mode: string) => {
  const flow = scenario(mode)
  expect(flow.start).toEqual({ status: 302, method: 'S256', challengeMatches: true, stateMatches: true, nonceMatches: true, redirectMatches: true })
  // Current-library characterization (openid-client 6.8.7); policy decision pending
  // against ADR-Platform-037 §1. This test is evidence, not approval.
  // ID-token signature is not verified and JWKS is not fetched in this code flow;
  // token-endpoint trust is TLS-based per OIDC Core 3.1.3.7.
  // A library change must fail these assertions so it receives review.
  expect(flow.first.jwks).toBe(0)
  if (flow.replay) expect(flow.replay.jwks).toBe(0)
  return flow
}
const auditEvent = (outcome: string, cause: string) => [expect.objectContaining({ method: 'OIDC', outcome, cause })]
const granted = (result: Result) => {
  expect(result).toMatchObject({ status: 303, error: null, sessions: 1, transactions: 0, signedTokens: 1, tokenRequests: 1, redemptions: 1, leaks: [] })
  expect(result.cookieNames).toEqual(['__Host-ok_console_oidc', '__Host-ok_console_session', '__Host-ok_console_csrf'])
  expect(result.cookieStrings).toEqual([
    '__Host-ok_console_oidc=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0',
    '__Host-ok_console_session=<session-id>; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600',
    '__Host-ok_console_csrf=<csrf-token>; Path=/; Secure; SameSite=Lax; Max-Age=3600',
  ])
  expect(result.audit).toEqual(auditEvent('Granted', 'VERIFIED'))
}

it('positive control validates ID token claims over trusted TLS and issues a session (client does not verify the signature in this flow)', () => {
  granted(get('positive').first)
})

it.each(['wrong-iss', 'wrong-aud', 'multi-aud-no-azp', 'multi-aud-foreign-azp', 'nonce', 'state', 'pkce', 'redirect', 'expired', 'future-nbf', 'token-untrusted-tls', 'token-wrong-name', 'missing-id-token', 'nonstring-sub'])('rejects %s through the real protocol client without session or secret disclosure', mode => {
  const { first, rejected } = get(mode)
  expect(first).toMatchObject({ status: 401, error: 'OIDC_CALLBACK_REJECTED', onlyClearTransaction: true, sessions: 0, transactions: 0, leaks: [] })
  expect(first.cookieNames).toEqual(['__Host-ok_console_oidc'])
  expect(first.audit).toEqual(auditEvent('Denied', 'CALLBACK_REJECTED'))
  expect(first.tokenRequests).toBe(['state', 'token-untrusted-tls', 'token-wrong-name'].includes(mode) ? 0 : 1)
  expect(first.signedTokens).toBe(['state', 'pkce', 'redirect', 'token-untrusted-tls', 'token-wrong-name'].includes(mode) ? 0 : 1)
  expect(rejected).toEqual(mode === 'pkce' ? ['pkce'] : mode === 'redirect' ? ['redirect_uri'] : [])
})

it('replay rejects the consumed transaction before a second code redemption', () => {
  const { first, replay } = get('replay')
  granted(first)
  expect(replay).toMatchObject({ status: 401, error: 'OIDC_TRANSACTION_INVALID', onlyClearTransaction: true, sessions: 1, transactions: 0, tokenRequests: 1, redemptions: 1, leaks: [] })
  expect(replay!.cookieStrings).toEqual(['__Host-ok_console_oidc=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0'])
  expect(replay!.audit).toEqual(auditEvent('Denied', 'TRANSACTION_INVALID'))
})

// Current-library characterization (openid-client 6.8.7); policy decision pending
// against ADR-Platform-037 §1. This test is evidence, not approval.
// A single-audience token with foreign azp is accepted.
it('current library behaviour (characterization): openid-client 6.8.7 accepts single-audience foreign azp and issues a session', () => {
  granted(get('single-aud-foreign-azp').first)
})

it('untrusted-tls rejects discovery with a certificate verification cause before any HTTP request', () => {
  const flow = scenario('untrusted-tls')
  expect(flow).toMatchObject({ mode: 'untrusted-tls', discoveryRejected: true, discoveryRequests: 0 })
  expect(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN']).toContain((flow as unknown as { causeCode: string }).causeCode)
})

it('http-issuer is rejected by the protocol client factory', () => {
  expect(scenario('http-issuer')).toMatchObject({ discoveryRejected: true, discoveryRequests: 0 })
})

// Current-library characterization (openid-client 6.8.7); policy decision pending
// against ADR-Platform-037 §1. This test is evidence, not approval.
// Future iat is accepted; nbf is checked separately.
it('current library behaviour (characterization): openid-client 6.8.7 accepts future iat (nbf is checked separately)', () => {
  granted(get('future-iat').first)
})

// With expectedNonce active, the real library rejects missing id_token before
// the adapter guard. Numeric sub reaches the subject guard (removal changes 401
// to 403 SUBJECT_UNMAPPED). Stub returns supplement the wire cases with all
// defensive guard shapes, including those the real library cannot return.
it.each([
  ['absent id_token', undefined, { sub: 'fixture-subject' }, 'OIDC ID Token is required.'],
  ['null id_token', null, { sub: 'fixture-subject' }, 'OIDC ID Token is required.'],
  ['numeric id_token', 123, { sub: 'fixture-subject' }, 'OIDC ID Token is required.'],
  ['absent claims', 'stub-id-token', undefined, 'OIDC subject is required.'],
  ['null claims', 'stub-id-token', null, 'OIDC subject is required.'],
  ['absent sub', 'stub-id-token', {}, 'OIDC subject is required.'],
  ['null sub', 'stub-id-token', { sub: null }, 'OIDC subject is required.'],
  ['numeric sub', 'stub-id-token', { sub: 123 }, 'OIDC subject is required.'],
])('defensive exchange guard rejects %s from a stubbed library return', async (_name, id_token, claims, message) => {
  vi.resetModules()
  vi.doMock('openid-client', async importOriginal => ({
    ...await importOriginal<typeof import('openid-client')>(),
    discovery: vi.fn(async () => ({})),
    authorizationCodeGrant: vi.fn(async () => ({ id_token, claims: () => claims })),
  }))
  try {
    const { createOidcProtocolClient } = await import('./oidc.mjs')
    const protocol = await createOidcProtocolClient({ issuer: 'https://issuer.invalid', clientId: 'stub-client', clientSecret: 'stub-secret' })
    await expect(protocol.exchange(new URL('https://console.invalid/callback'), { expectedNonce: 'active-nonce' })).rejects.toThrow(message as string)
  } finally {
    vi.doUnmock('openid-client')
    vi.resetModules()
  }
})

it('discloses no secrets on child stderr (no benign lines expected)', () => {
  expect(childStderr).toBe('')
})
