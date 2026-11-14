// @vitest-environment node
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { beforeAll, expect, it } from 'vitest'

const exec = promisify(execFile)
type Result = {
  status: number; error: string | null; cookieNames: string[]; onlyClearTransaction: boolean
  sessions: number; transactions: number; audit: { method: string; outcome: string; cause: string }[]
  leaks: string[]; tokenRequests: number; redemptions: number; signedTokens: number; jwks: number
}
type Flow = { mode: string; rejected: string[]; start: { status: number; method: string; challengeMatches: boolean; stateMatches: boolean; nonceMatches: boolean }; first: Result; replay?: Result }
let flows: Flow[]
beforeAll(async () => {
  const { stdout } = await exec(process.execPath, ['bff/test-fixtures/oidcCallbackIssuer.mjs'], { timeout: 65000 })
  flows = stdout.trim().split('\n').map(line => JSON.parse(line))
}, 70000)

const get = (mode: string) => {
  const flow = flows.find(value => value.mode === mode)!
  expect(flow).toBeDefined()
  expect(flow.start).toEqual({ status: 302, method: 'S256', challengeMatches: true, stateMatches: true, nonceMatches: true })
  return flow
}
const auditEvent = (outcome: string, cause: string) => [expect.objectContaining({ method: 'OIDC', outcome, cause })]
const granted = (result: Result) => {
  expect(result).toMatchObject({ status: 303, error: null, sessions: 1, transactions: 0, signedTokens: 1, tokenRequests: 1, redemptions: 1, leaks: [] })
  expect(result.cookieNames).toEqual(['__Host-ok_console_oidc', '__Host-ok_console_session', '__Host-ok_console_csrf'])
  expect(result.audit).toEqual(auditEvent('Granted', 'VERIFIED'))
}

it('positive control validates a signed ID token through the real client and issues a session', () => {
  granted(get('positive').first)
})

it.each(['wrong-iss', 'wrong-aud', 'multi-aud-no-azp', 'multi-aud-foreign-azp', 'nonce', 'state', 'pkce', 'redirect', 'expired'])('rejects %s through the real protocol client without session or secret disclosure', mode => {
  const { first, rejected } = get(mode)
  expect(first).toMatchObject({ status: 401, error: 'OIDC_CALLBACK_REJECTED', onlyClearTransaction: true, sessions: 0, transactions: 0, leaks: [] })
  expect(first.cookieNames).toEqual(['__Host-ok_console_oidc'])
  expect(first.audit).toEqual(auditEvent('Denied', 'CALLBACK_REJECTED'))
  expect(first.tokenRequests).toBe(mode === 'state' ? 0 : 1)
  expect(first.signedTokens).toBe(['state', 'pkce', 'redirect'].includes(mode) ? 0 : 1)
  expect(rejected).toEqual(mode === 'pkce' ? ['pkce'] : mode === 'redirect' ? ['redirect_uri'] : [])
})

it('replay rejects the consumed transaction before a second code redemption', () => {
  const { first, replay } = get('replay')
  granted(first)
  expect(replay).toMatchObject({ status: 401, error: 'OIDC_TRANSACTION_INVALID', onlyClearTransaction: true, sessions: 1, transactions: 0, tokenRequests: 1, redemptions: 1, leaks: [] })
  expect(replay!.audit).toEqual(auditEvent('Denied', 'TRANSACTION_INVALID'))
})

it('records single-audience foreign azp behavior for the PR scope', () => {
  const { first } = get('single-aud-foreign-azp')
  expect(first).toMatchObject({ tokenRequests: 1, redemptions: 1, signedTokens: 1, transactions: 0, leaks: [] })
  expect([303, 401]).toContain(first.status)
  console.info(`OIDC_SINGLE_AUDIENCE_FOREIGN_AZP accepted=${first.status === 303} status=${first.status}`)
})
