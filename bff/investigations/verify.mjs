import { canonicalJson, parseFactRef, resolvePointer, sha256Digest } from './canonical.mjs'

// Deterministic verification of a recorded analysis against the evidence it cites. No model, no network.
//
// Formats reused from the platform-diagnostics evidence contract (1.2.0 draft): evidence catalog fields
// (id, type, source, uri), fact references "<evidence_id>#<json-pointer>" and claim-rule assertion kinds. Values follow
// the approved vocabulary (E5/E6): claim, hypothesis, evidence chain, basis, assessment, outcome.
// Check classes and the basis/assessment rules follow ADR-K-010 §4.3 (proposed).

export const CHECKS = Object.freeze([
  Object.freeze({ checkId: 'CHK-01', class: 'critical', name: 'Evidence integrity: every evidence digest matches its content' }),
  Object.freeze({ checkId: 'CHK-02', class: 'critical', name: 'Cluster identity binding: every evidence item belongs to the investigated cluster' }),
  Object.freeze({ checkId: 'CHK-03', class: 'critical', name: 'Read-only boundary: no recommendation is executed' }),
  Object.freeze({ checkId: 'CHK-04', class: 'required', name: 'Claim support: every claim of the leading hypothesis is supported by cited evidence' }),
  Object.freeze({ checkId: 'CHK-05', class: 'required', name: 'Hypothesis consistency: the leading hypothesis is consistent with its claims' }),
])

const OPERATIONS = new Set(['equals', 'gte', 'lte', 'contains', 'excludes', 'exists'])

const deepEqual = (a, b) => canonicalJson(a) === canonicalJson(b)

const containsValue = (observed, expected) => {
  if (typeof observed === 'string') return typeof expected === 'string' && observed.includes(expected)
  if (Array.isArray(observed)) {
    return observed.some((item) => (typeof item === 'string' && typeof expected === 'string' ? item.includes(expected) : deepEqual(item, expected)))
  }
  return false
}

// Returns true, false, or null when the assertion cannot be applied to the observed value.
const evaluate = ({ op, value }, observed) => {
  switch (op) {
    case 'exists': return observed !== undefined && observed !== null
    case 'equals': return deepEqual(observed, value)
    case 'gte': return typeof observed === 'number' && typeof value === 'number' ? observed >= value : null
    case 'lte': return typeof observed === 'number' && typeof value === 'number' ? observed <= value : null
    case 'contains': return typeof observed === 'string' || Array.isArray(observed) ? containsValue(observed, value) : null
    case 'excludes': return typeof observed === 'string' || Array.isArray(observed) ? !containsValue(observed, value) : null
    default: return null
  }
}

const clusterOf = (uri) => /^k8s:\/\/([^/]+)\//.exec(uri)?.[1] ?? null

const verifyEvidence = (pack) => pack.evidence.map((item) => {
  const computed = sha256Digest(item.data)
  return {
    id: item.id,
    type: item.type,
    source: item.source,
    uri: item.uri,
    collectedAt: item.collectedAt,
    digest: item.digest,
    integrity: computed === item.digest ? 'verified' : 'rejected',
    clusterBinding: clusterOf(item.uri) === pack.target.cluster ? 'bound' : 'mismatch',
  }
})

// Level 3 (claim): supported | contradicted | unverifiable | invalid.
const verifyClaim = (claim, hypothesis, evidenceById, verdicts) => {
  const base = { id: claim.id, statement: claim.statement, factRef: claim.factRef ?? null, assertion: claim.assertion ?? null }
  const reference = parseFactRef(claim.factRef)
  const assertion = claim.assertion
  const assertionValid = assertion && typeof assertion === 'object' && !Array.isArray(assertion)
    && typeof assertion.kind === 'string' && /^[a-z][a-zA-Z0-9.]{0,80}$/.test(assertion.kind)
    && OPERATIONS.has(assertion.op) && (assertion.op === 'exists' || 'value' in assertion)
    && Object.keys(assertion).every((key) => ['kind', 'op', 'value'].includes(key))
  if (!reference) return { ...base, status: 'invalid', reason: 'fact_ref_malformed' }
  if (!assertionValid) return { ...base, status: 'invalid', reason: 'assertion_malformed' }
  const evidence = evidenceById.get(reference.evidenceId)
  if (!evidence) return { ...base, status: 'unverifiable', reason: 'evidence_missing' }
  if (!hypothesis.evidenceRefs.includes(reference.evidenceId)) return { ...base, status: 'unverifiable', reason: 'evidence_not_cited' }
  const verdict = verdicts.get(reference.evidenceId)
  if (verdict.integrity !== 'verified') return { ...base, status: 'unverifiable', reason: 'evidence_integrity_failed' }
  if (verdict.clusterBinding !== 'bound') return { ...base, status: 'unverifiable', reason: 'evidence_cluster_mismatch' }
  const resolved = resolvePointer(evidence.data, reference.pointer)
  if (!resolved.found) return { ...base, status: 'unverifiable', reason: 'fact_not_found' }
  const outcome = evaluate(assertion, resolved.value)
  if (outcome === null) return { ...base, status: 'unverifiable', reason: 'assertion_not_applicable', observed: resolved.value }
  return outcome
    ? { ...base, status: 'supported', reason: 'assertion_holds', observed: resolved.value }
    : { ...base, status: 'contradicted', reason: 'assertion_refuted', observed: resolved.value }
}

// Level 4 (hypothesis): only contradicted claims rule a hypothesis out; unverifiable claims never support
// "consistent" on their own (VOCABULARY.md mapping rule 2).
const hypothesisStatus = (claims) => {
  if (claims.some((claim) => claim.status === 'contradicted')) return 'inconsistent'
  if (claims.some((claim) => claim.status === 'supported')) return 'consistent'
  return 'not_assessed'
}

const count = (items, key, values) => Object.fromEntries(values.map((value) => [value, items.filter((item) => item[key] === value).length]))

export const verifyInvestigation = (pack) => {
  const evidenceById = new Map(pack.evidence.map((item) => [item.id, item]))
  const evidence = verifyEvidence(pack)
  const verdicts = new Map(evidence.map((item) => [item.id, item]))

  const recommendations = pack.analysis.recommendations.map((recommendation) => ({
    id: recommendation.id,
    text: recommendation.text,
    actionClass: recommendation.actionClass,
    basedOn: [...recommendation.basedOn],
    executionStatus: 'not_executed',
  }))

  const status = (passed, failedStatus = 'failed') => (passed ? 'passed' : failedStatus)
  // Critical checks first: they decide whether any content may be relied on at all (level 2).
  const critical = {
    'CHK-01': status(evidence.every((item) => item.integrity === 'verified')),
    'CHK-02': status(evidence.every((item) => item.clusterBinding === 'bound')),
    'CHK-03': status(recommendations.every((recommendation) => recommendation.executionStatus === 'not_executed')),
  }
  const basis = Object.values(critical).every((value) => value === 'passed') ? 'established' : 'blocked'

  // Claims are always evaluated and reported. With a blocked basis no hypothesis is assessed (fail closed):
  // nothing may read as an explanation when the evidence itself cannot be relied on.
  const hypotheses = pack.analysis.hypotheses.map((hypothesis, index) => {
    const claims = hypothesis.claims.map((claim) => verifyClaim(claim, hypothesis, evidenceById, verdicts))
    return { id: hypothesis.id, rank: index + 1, statement: hypothesis.statement, evidenceRefs: [...hypothesis.evidenceRefs], status: basis === 'blocked' ? 'not_assessed' : hypothesisStatus(claims), claims }
  })
  const leading = hypotheses[0]
  const leadingClaims = leading.claims
  const claimCheck = leadingClaims.some((claim) => claim.status === 'contradicted' || claim.status === 'invalid')
    ? 'failed'
    : leadingClaims.every((claim) => claim.status === 'supported') ? 'passed' : 'not_available'
  const results = {
    ...critical,
    'CHK-04': claimCheck,
    'CHK-05': leading.status === 'consistent' ? 'passed' : leading.status === 'inconsistent' ? 'failed' : 'not_run',
  }
  const checks = CHECKS.map((check) => ({ ...check, status: results[check.checkId] }))

  // Level 1: digest-linked integrity of the fixture evidence. No issuer signatures exist for fixtures, so
  // this is not the OK-213 signed-chain verification and never counts towards live operation.
  const evidenceChain = {
    status: results['CHK-01'] === 'passed' ? 'verified' : 'rejected',
    method: 'fixture-digest',
    signatures: 'not_applicable',
  }
  // Level 5 (ADR-K-010 §4.3).
  const required = checks.filter((check) => check.class === 'required')
  const assessment = basis === 'blocked' ? 'withheld'
    : required.some((check) => check.status === 'failed') ? 'check_failed'
      : !required.some((check) => check.status === 'passed') ? 'unsupported'
        : required.some((check) => check.status === 'not_run' || check.status === 'not_available') ? 'partially_supported'
          : 'fully_supported'
  // Level 6. "completed" is only reported together with a supported run: an established basis, a supported
  // assessment and a consistent leading hypothesis. A consistent alternative does not complete a run whose
  // leading hypothesis is refuted (no re-ranking here); it stays visible as a consistent hypothesis.
  const supported = basis === 'established' && (assessment === 'fully_supported' || assessment === 'partially_supported')
  const outcome = supported && leading.status === 'consistent' ? 'completed' : 'inconclusive'

  const allClaims = hypotheses.flatMap((hypothesis) => hypothesis.claims)
  return {
    evidence,
    hypotheses,
    // eligible means only: evidence-based and suitable for human review. It is never an execution
    // authorization; executionStatus stays not_executed and nothing in this service executes anything.
    recommendations: recommendations.map((recommendation) => ({
      ...recommendation,
      eligible: outcome === 'completed' && recommendation.basedOn.every((id) => hypotheses.find((hypothesis) => hypothesis.id === id)?.status === 'consistent'),
    })),
    verification: {
      evidenceChain,
      basis,
      assessment,
      leadingHypothesis: leading.id,
      checks,
      summary: {
        claims: count(allClaims, 'status', ['supported', 'contradicted', 'unverifiable', 'invalid']),
        hypotheses: count(hypotheses, 'status', ['consistent', 'inconsistent', 'not_assessed']),
      },
    },
    outcome,
  }
}
