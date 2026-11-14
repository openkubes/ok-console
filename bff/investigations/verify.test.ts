// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { sha256Digest } from './canonical.mjs'
import examplePack from './test-fixtures/example-crashloop.json'
import { verifyInvestigation } from './verify.mjs'

type Pack = typeof examplePack
const fresh = (): Pack => structuredClone(examplePack)
const leadingClaim = (result: ReturnType<typeof verifyInvestigation>, id: string) => result.hypotheses[0].claims.find((claim: { id: string }) => claim.id === id)
const checks = (result: ReturnType<typeof verifyInvestigation>) => Object.fromEntries(result.verification.checks.map((check: { checkId: string; status: string }) => [check.checkId, check.status]))

describe('fixture investigation verification', () => {
  it('positive: every claim of the leading hypothesis is supported by cited, intact evidence', () => {
    const result = verifyInvestigation(fresh())
    expect(result.hypotheses.map((hypothesis: { status: string }) => hypothesis.status)).toEqual(['consistent', 'inconsistent'])
    expect(result.hypotheses[0].claims.every((claim: { status: string }) => claim.status === 'supported')).toBe(true)
    expect(leadingClaim(result, 'c3-exit-code')).toMatchObject({ status: 'supported', reason: 'assertion_holds', observed: 2 })
    expect(result.verification).toMatchObject({ evidenceChain: { status: 'verified', method: 'fixture-digest', signatures: 'not_applicable' }, basis: 'established', assessment: 'fully_supported', leadingHypothesis: 'h1-missing-setting' })
    expect(checks(result)).toEqual({ 'CHK-01': 'passed', 'CHK-02': 'passed', 'CHK-03': 'passed', 'CHK-04': 'passed', 'CHK-05': 'passed' })
    expect(result.outcome).toBe('completed')
    expect(result.recommendations).toEqual([expect.objectContaining({ id: 'r1-provide-setting', executionStatus: 'not_executed', eligible: true })])
  })

  it('the alternative hypothesis is ruled out by evidence, not by assumption', () => {
    const result = verifyInvestigation(fresh())
    expect(result.hypotheses[1].claims[0]).toMatchObject({ id: 'c6-oom', status: 'contradicted', reason: 'assertion_refuted', observed: 'Error' })
    expect(result.verification.summary).toEqual({ claims: { supported: 5, contradicted: 1, unverifiable: 0, invalid: 0 }, hypotheses: { consistent: 1, inconsistent: 1, not_assessed: 0 } })
  })

  it('negative: a manipulated claim value is contradicted and the run is not reported as supported', () => {
    const pack = fresh()
    pack.analysis.hypotheses[0].claims[2].assertion.value = 137
    const result = verifyInvestigation(pack)
    expect(leadingClaim(result, 'c3-exit-code')).toMatchObject({ status: 'contradicted', observed: 2 })
    expect(result.hypotheses[0].status).toBe('inconsistent')
    expect(checks(result)).toMatchObject({ 'CHK-04': 'failed', 'CHK-05': 'failed' })
    expect(result.verification.assessment).toBe('check_failed')
    expect(result.outcome).toBe('inconclusive')
    expect(result.recommendations.every((recommendation: { eligible: boolean; executionStatus: string }) => !recommendation.eligible && recommendation.executionStatus === 'not_executed')).toBe(true)
  })

  it.each([
    ['a fact that does not exist in the evidence', (pack: Pack) => { pack.analysis.hypotheses[0].claims[0].factRef = 'ev-status#/containerStatuses/0/state/waiting/message' }, 'fact_not_found'],
    ['evidence that does not exist', (pack: Pack) => { pack.analysis.hypotheses[0].claims[0].factRef = 'ev-describe#/reason' }, 'evidence_missing'],
    ['evidence the hypothesis does not cite', (pack: Pack) => { pack.analysis.hypotheses[0].evidenceRefs = ['ev-logs', 'ev-spec'] }, 'evidence_not_cited'],
    ['an assertion that does not apply to the value', (pack: Pack) => { pack.analysis.hypotheses[0].claims[0].assertion = { kind: 'container.state.waiting.reason', op: 'gte', value: 1 } }, 'assertion_not_applicable'],
  ])('negative: a claim citing %s is unverifiable, never supported', (_name, mutate, reason) => {
    const pack = fresh()
    mutate(pack)
    const result = verifyInvestigation(pack)
    expect(result.hypotheses[0].claims.find((claim: { reason: string }) => claim.reason === reason)).toMatchObject({ status: 'unverifiable' })
    expect(checks(result)['CHK-04']).toBe('not_available')
    expect(result.verification.assessment).toBe('partially_supported')
  })

  it.each([
    ['a malformed fact reference', (pack: Pack) => { pack.analysis.hypotheses[0].claims[1].factRef = 'restartCount' }, 'fact_ref_malformed'],
    ['an unknown operation', (pack: Pack) => { pack.analysis.hypotheses[0].claims[1].assertion = { kind: 'container.restartCount', op: 'roughly', value: 3 } }, 'assertion_malformed'],
    ['extra assertion fields', (pack: Pack) => { (pack.analysis.hypotheses[0].claims[1].assertion as Record<string, unknown>).trusted = true }, 'assertion_malformed'],
  ])('negative: a claim with %s is invalid and fails the claim check', (_name, mutate, reason) => {
    const pack = fresh()
    mutate(pack)
    const result = verifyInvestigation(pack)
    expect(result.hypotheses[0].claims.find((claim: { reason: string }) => claim.reason === reason)).toMatchObject({ status: 'invalid' })
    expect(result.verification.assessment).toBe('check_failed')
  })

  it('negative: tampered evidence (content changed, digest kept) blocks the basis and withholds the assessment', () => {
    const pack = fresh()
    pack.evidence[0].data.containerStatuses[0].lastState.terminated.exitCode = 137
    const result = verifyInvestigation(pack)
    expect(result.evidence[0]).toMatchObject({ id: 'ev-status', integrity: 'rejected' })
    expect(result.verification).toMatchObject({ evidenceChain: { status: 'rejected' }, basis: 'blocked', assessment: 'withheld' })
    expect(checks(result)['CHK-01']).toBe('failed')
    expect(leadingClaim(result, 'c3-exit-code')).toMatchObject({ status: 'unverifiable', reason: 'evidence_integrity_failed' })
    expect(result.hypotheses.map((hypothesis: { status: string }) => hypothesis.status)).toEqual(['not_assessed', 'not_assessed'])
    expect(checks(result)['CHK-05']).toBe('not_run')
    expect(result.outcome).toBe('inconclusive')
    expect(result.recommendations.every((recommendation: { eligible: boolean }) => recommendation.eligible === false)).toBe(true)
  })

  it('negative: re-signing tampered content with a new digest is detected as a contradiction, not hidden', () => {
    const pack = fresh()
    pack.evidence[0].data.containerStatuses[0].lastState.terminated.exitCode = 137
    pack.evidence[0].digest = sha256Digest(pack.evidence[0].data)
    const result = verifyInvestigation(pack)
    expect(result.verification.basis).toBe('established')
    expect(leadingClaim(result, 'c3-exit-code')).toMatchObject({ status: 'contradicted', observed: 137 })
    expect(result.verification.assessment).toBe('check_failed')
  })

  it('negative: evidence from another cluster blocks the basis', () => {
    const pack = fresh()
    pack.evidence[1].uri = pack.evidence[1].uri.replace('k8s://example-cluster/', 'k8s://other-cluster/')
    const result = verifyInvestigation(pack)
    expect(result.evidence[1].clusterBinding).toBe('mismatch')
    expect(checks(result)['CHK-02']).toBe('failed')
    expect(result.verification).toMatchObject({ basis: 'blocked', assessment: 'withheld' })
    expect(leadingClaim(result, 'c4-log')).toMatchObject({ status: 'unverifiable', reason: 'evidence_cluster_mismatch' })
    expect(result.hypotheses.every((hypothesis: { status: string }) => hypothesis.status === 'not_assessed')).toBe(true)
  })

  it('negative: a refuted leading hypothesis is not rescued by a consistent alternative', () => {
    const pack = fresh()
    // Leading hypothesis h1: one claim contradicted. Alternative h2: made consistent with the evidence.
    pack.analysis.hypotheses[0].claims[2].assertion.value = 137
    Object.assign(pack.analysis.hypotheses[1].claims[0], { statement: 'The last run ended with reason Error.', assertion: { kind: 'container.lastState.terminated.reason', op: 'equals', value: 'Error' } })
    pack.analysis.recommendations.push({ id: 'r2-based-on-alternative', text: 'Review the alternative.', basedOn: ['h2-oom'], actionClass: 'read_only_check' })
    const result = verifyInvestigation(pack)
    expect(result.hypotheses.map((hypothesis: { id: string; status: string }) => [hypothesis.id, hypothesis.status])).toEqual([['h1-missing-setting', 'inconsistent'], ['h2-oom', 'consistent']])
    expect(result.verification).toMatchObject({ basis: 'established', assessment: 'check_failed', leadingHypothesis: 'h1-missing-setting' })
    expect(checks(result)).toMatchObject({ 'CHK-04': 'failed', 'CHK-05': 'failed' })
    expect(result.outcome).toBe('inconclusive')
    expect(result.recommendations.map((recommendation: { eligible: boolean; executionStatus: string }) => [recommendation.eligible, recommendation.executionStatus])).toEqual([[false, 'not_executed'], [false, 'not_executed']])
  })

  it('a hypothesis with only unverifiable claims is not assessed and the run is unsupported', () => {
    const pack = fresh()
    pack.analysis.hypotheses[0].evidenceRefs = []
    const result = verifyInvestigation(pack)
    expect(result.hypotheses[0].status).toBe('not_assessed')
    expect(checks(result)).toMatchObject({ 'CHK-04': 'not_available', 'CHK-05': 'not_run' })
    expect(result.verification.assessment).toBe('unsupported')
    expect(result.outcome).toBe('inconclusive')
  })

  it('evaluates every operation strictly', () => {
    const cases: [string, unknown, string][] = [
      ['ev-status#/containerStatuses/0/restartCount', { kind: 'container.restartCount', op: 'gte', value: 4 }, 'contradicted'],
      ['ev-status#/containerStatuses/0/restartCount', { kind: 'container.restartCount', op: 'lte', value: 3 }, 'supported'],
      ['ev-status#/containerStatuses/0/restartCount', { kind: 'container.restartCount', op: 'equals', value: '3' }, 'contradicted'],
      ['ev-logs#/lines', { kind: 'log.line', op: 'contains', value: 'EXAMPLE_SETTING is optional' }, 'contradicted'],
      ['ev-spec#/containers/0/env/names', { kind: 'container.env.names', op: 'excludes', value: 'PORT' }, 'contradicted'],
      ['ev-spec#/containers/0/envFrom', { kind: 'container.envFrom', op: 'exists' }, 'supported'],
      ['ev-status#/containerStatuses/0/state/waiting', { kind: 'container.state.waiting', op: 'equals', value: { reason: 'CrashLoopBackOff' } }, 'supported'],
    ]
    for (const [factRef, assertion, expected] of cases) {
      const pack = fresh()
      Object.assign(pack.analysis.hypotheses[0].claims[0], { factRef, assertion })
      expect(verifyInvestigation(pack).hypotheses[0].claims[0].status, `${factRef} ${JSON.stringify(assertion)}`).toBe(expected)
    }
  })

  it('is deterministic for the same pack and never mutates it', () => {
    const pack = fresh()
    const before = JSON.stringify(pack)
    expect(JSON.stringify(verifyInvestigation(pack))).toBe(JSON.stringify(verifyInvestigation(pack)))
    expect(JSON.stringify(pack)).toBe(before)
  })
})
