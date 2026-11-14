// @vitest-environment node

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import Ajv2020 from 'ajv/dist/2020'
import addFormats from 'ajv-formats'
import { describe, expect, it } from 'vitest'
import packSchema from '../../contracts/investigation/v1alpha1/investigation-pack.schema.json'
import resultSchema from '../../contracts/investigation/v1alpha1/investigation-result.schema.json'
import { sha256Digest } from './canonical.mjs'
import { validateInvestigationPack } from './pack.mjs'
import { createInvestigationService } from './service.mjs'
import examplePack from './test-fixtures/example-crashloop.json'

const ajv = new Ajv2020({ allErrors: true, strict: false })
addFormats(ajv)
const validPack = ajv.compile(packSchema)
const validResult = ajv.compile(resultSchema)

type Result = NonNullable<ReturnType<ReturnType<typeof createInvestigationService>['start']>>

// Invariants that must hold for every result, valid or manipulated: no contradictory success statement,
// eligibility only for human review, nothing executed, fixture time never presented as a live observation.
const expectCoherent = (result: Result, label: string) => {
  const leading = result.hypotheses[0]
  if (result.outcome === 'completed') {
    expect(result.verification.basis, label).toBe('established')
    expect(['fully_supported', 'partially_supported'], label).toContain(result.verification.assessment)
    expect(leading.status, label).toBe('consistent')
  }
  if (['check_failed', 'unsupported', 'withheld'].includes(result.verification.assessment) || leading.status !== 'consistent') {
    expect(result.outcome, label).toBe('inconclusive')
  }
  for (const recommendation of result.recommendations) {
    expect(recommendation.executionStatus, label).toBe('not_executed')
    if (recommendation.eligible) expect(result.outcome, label).toBe('completed')
  }
  expect(result.source, label).toMatchObject({ freshness: 'Unknown', liveClusterAccess: false })
  expect(result.source.observedAt, label).toBe(result.evidence.map((item: { collectedAt: string }) => item.collectedAt).sort().at(-1))
}

const run = (pack: unknown) => {
  const packs = new Map([[(pack as typeof examplePack).scenario.id, { pack, packDigest: sha256Digest(pack) }]])
  const result = createInvestigationService({ packs: packs as never, now: () => new Date('2026-11-14T14:35:00Z') }).start({ scenarioId: (pack as typeof examplePack).scenario.id, correlationId: 'corr-contract' })!
  expectCoherent(result, (pack as typeof examplePack).scenario.id)
  return result
}

// Packs maintained outside this repository (for example a product's scenario packs) can be checked with
// OK_CONSOLE_TEST_INVESTIGATION_PACKS_DIR=/abs/dir; without it only the neutral example pack is used.
const externalDir = process.env.OK_CONSOLE_TEST_INVESTIGATION_PACKS_DIR
const packs: [string, typeof examplePack][] = [
  ['example-crashloop', examplePack],
  ...(externalDir ? readdirSync(externalDir).filter((name) => name.endsWith('.json')).map((name) => [name, JSON.parse(readFileSync(join(externalDir, name), 'utf8'))] as [string, typeof examplePack]) : []),
]

describe.each(packs)('investigation contract: %s', (_name, pack) => {
  it('pack conforms to the pack schema and the structural validator', () => {
    expect(validPack(pack), JSON.stringify(validPack.errors)).toBe(true)
    expect(validateInvestigationPack(structuredClone(pack))).toEqual({ ok: true, problems: [] })
  })

  it('positive: result conforms to the result schema, is fully supported and never executes anything', () => {
    const result = run(structuredClone(pack))!
    expect(validResult(result), JSON.stringify(validResult.errors)).toBe(true)
    expect(result.verification).toMatchObject({ basis: 'established', assessment: 'fully_supported' })
    expect(result.hypotheses[0].status).toBe('consistent')
    expect(result.hypotheses[0].claims.every((claim: { status: string }) => claim.status === 'supported')).toBe(true)
    expect(result.recommendations.length).toBeGreaterThan(0)
    expect(result.recommendations.every((recommendation: { executionStatus: string }) => recommendation.executionStatus === 'not_executed')).toBe(true)
    expect(result).toMatchObject({ source: { kind: 'fixture', liveClusterAccess: false }, analysis: { kind: 'recorded', liveModel: false }, outcome: 'completed' })
  })

  it('keeps fixture time, evaluation time and freshness apart', () => {
    const result = run(structuredClone(pack))!
    expect(result.startedAt).toBe('2026-11-14T14:35:00.000Z')
    expect(result.source.observedAt).not.toBe(result.startedAt)
    expect(Date.parse(result.source.observedAt)).toBeLessThan(Date.parse(result.startedAt))
    expect(result.source.freshness).toBe('Unknown')
  })

  it('eligible means human review only and never comes with an execution path', () => {
    const result = run(structuredClone(pack))!
    expect(result.recommendations.some((recommendation: { eligible: boolean }) => recommendation.eligible)).toBe(true)
    for (const recommendation of result.recommendations) expect(Object.keys(recommendation).sort()).toEqual(['actionClass', 'basedOn', 'eligible', 'executionStatus', 'id', 'text'])
    const eligibleSchema = (resultSchema as { properties: { recommendations: { items: { properties: Record<string, { description?: string; const?: string }> } } } }).properties.recommendations.items.properties
    expect(eligibleSchema.eligible.description).toMatch(/suitable for human review/)
    expect(eligibleSchema.eligible.description).toMatch(/never an execution authorization/)
    expect(eligibleSchema.executionStatus.const).toBe('not_executed')
  })

  it('reproducible: the same pack gives the same result digest on every start', () => {
    const first = run(structuredClone(pack))!
    const second = run(structuredClone(pack))!
    expect(first.investigationId).not.toBe(second.investigationId)
    expect(first.reproducibility.resultDigest).toBe(second.reproducibility.resultDigest)
  })

  it('negative: every single manipulated claim value of the leading hypothesis is caught', () => {
    for (const [index, claim] of pack.analysis.hypotheses[0].claims.entries()) {
      const mutated = structuredClone(pack)
      const assertion = mutated.analysis.hypotheses[0].claims[index].assertion as { op: string; value?: unknown }
      assertion.value = typeof assertion.value === 'number' ? assertion.value + 100 : Array.isArray(assertion.value) ? ['MANIPULATED'] : `${String(assertion.value)}-MANIPULATED`
      if (assertion.op === 'excludes') assertion.op = 'contains'
      const result = run(mutated)!
      expect(validResult(result)).toBe(true)
      expect(result.hypotheses[0].claims[index].status, claim.id).not.toBe('supported')
      expect(result.verification.assessment, claim.id).not.toBe('fully_supported')
    }
  })

  it('negative: a refuted leading hypothesis with a consistent alternative is never reported as completed', () => {
    if (pack.analysis.hypotheses.length < 2) return
    const mutated = structuredClone(pack)
    const leadingClaim = mutated.analysis.hypotheses[0].claims[0] as { assertion: { op: string; value?: unknown } }
    leadingClaim.assertion = { ...leadingClaim.assertion, op: 'equals', value: 'MANIPULATED' }
    // Make the alternative consistent: every claim only asserts that its cited fact exists.
    mutated.analysis.hypotheses[1].claims = mutated.analysis.hypotheses[1].claims.map((claim) => ({ ...claim, assertion: { kind: claim.assertion.kind, op: 'exists' } })) as typeof mutated.analysis.hypotheses[1]['claims']
    const result = run(mutated)!
    expect(result.hypotheses[0].status).toBe('inconsistent')
    expect(result.hypotheses[1].status).toBe('consistent')
    expect(result.verification.assessment).toBe('check_failed')
    expect(result.outcome).toBe('inconclusive')
    expect(result.recommendations.every((recommendation: { eligible: boolean }) => !recommendation.eligible)).toBe(true)
  })

  it('negative: every single tampered evidence item withholds the assessment', () => {
    for (const [index, item] of pack.evidence.entries()) {
      const mutated = structuredClone(pack)
      ;(mutated.evidence[index].data as Record<string, unknown>).tampered = true
      const result = run(mutated)!
      expect(result.verification, item.id).toMatchObject({ basis: 'blocked', assessment: 'withheld' })
      expect(result.hypotheses.every((hypothesis: { status: string }) => hypothesis.status === 'not_assessed'), item.id).toBe(true)
      expect(result.recommendations.every((recommendation: { eligible: boolean }) => !recommendation.eligible), item.id).toBe(true)
      expect(result.outcome).toBe('inconclusive')
    }
  })

  it('negative: removing any cited evidence item leaves no claim on it supported', () => {
    for (const item of pack.evidence) {
      const mutated = structuredClone(pack)
      mutated.evidence = mutated.evidence.filter((candidate) => candidate.id !== item.id)
      if (mutated.evidence.length === 0) continue
      const result = run(mutated)!
      const affected = result.hypotheses.flatMap((hypothesis: { claims: { factRef: string; status: string }[] }) => hypothesis.claims).filter((claim: { factRef: string }) => claim.factRef?.startsWith(`${item.id}#`))
      expect(affected.every((claim: { status: string }) => claim.status === 'unverifiable'), item.id).toBe(true)
    }
  })
})
