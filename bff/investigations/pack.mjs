import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, sep } from 'node:path'
import { findForbiddenFieldPaths } from '../contract.mjs'
import { sha256Digest } from './canonical.mjs'

// Investigation pack: a synthetic, self-contained fixture investigation (scenario, evidence, recorded
// analysis). Packs are data only; this module never contacts a cluster or a model.
export const INVESTIGATION_PACK_SCHEMA = 'openkubes.console.investigation-pack/v1alpha1'
export const MAX_PACK_BYTES = 512 * 1024
export const MAX_PACKS = 20
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/
const FIXTURE_ID = /^[a-z0-9][a-z0-9-]{0,62}@[a-z0-9][a-z0-9.-]{0,30}$/
const DIGEST = /^sha256:[0-9a-f]{64}$/
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/

export class InvestigationPackError extends Error {
  constructor(problems) {
    super(`Invalid investigation pack configuration:\n- ${problems.join('\n- ')}`)
    this.name = 'InvestigationPackError'
    this.problems = problems
  }
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

const checker = (problems) => {
  const object = (value, path, required, optional = []) => {
    if (!isObject(value)) { problems.push(`${path}: must be an object`); return false }
    for (const key of Object.keys(value)) if (![...required, ...optional].includes(key)) problems.push(`${path}.${key}: unknown field`)
    for (const key of required) if (!(key in value)) problems.push(`${path}.${key}: required`)
    return true
  }
  const text = (value, path, max) => {
    if (typeof value !== 'string' || !value.trim()) problems.push(`${path}: must be a non-empty string`)
    else if (value.length > max) problems.push(`${path}: at most ${max} characters`)
    else if (CONTROL.test(value)) problems.push(`${path}: control characters are not allowed`)
  }
  const pattern = (value, path, regex, what) => {
    if (typeof value !== 'string' || !regex.test(value)) problems.push(`${path}: must be ${what}`)
  }
  const list = (value, path, min, max) => {
    if (!Array.isArray(value) || value.length < min || value.length > max) { problems.push(`${path}: must be a list of ${min} to ${max} items`); return false }
    return true
  }
  const unique = (ids, path) => {
    const seen = new Set()
    for (const id of ids) { if (seen.has(id)) problems.push(`${path}: duplicate id "${id}"`); seen.add(id) }
  }
  return { object, text, pattern, list, unique }
}

// Structural validation only. Evidence integrity, citations and claim content are judged by the verifier,
// so a tampered or unsupported pack still runs and is reported, instead of being hidden.
export const validateInvestigationPack = (pack) => {
  const problems = []
  const { object, text, pattern, list, unique } = checker(problems)
  if (!object(pack, 'pack', ['schema', 'scenario', 'target', 'evidence', 'analysis'])) return { ok: false, problems }
  if (pack.schema !== INVESTIGATION_PACK_SCHEMA) problems.push(`pack.schema: must be "${INVESTIGATION_PACK_SCHEMA}"`)

  if (object(pack.scenario, 'scenario', ['id', 'title', 'description', 'fixture', 'synthetic'])) {
    pattern(pack.scenario.id, 'scenario.id', SLUG, 'a lowercase slug')
    text(pack.scenario.title, 'scenario.title', 80)
    text(pack.scenario.description, 'scenario.description', 400)
    pattern(pack.scenario.fixture, 'scenario.fixture', FIXTURE_ID, '"<fixture>@<version>"')
    if (pack.scenario.synthetic !== true) problems.push('scenario.synthetic: must be true; only synthetic fixtures are allowed')
  }

  if (object(pack.target, 'target', ['cluster', 'namespace', 'workload'])) {
    pattern(pack.target.cluster, 'target.cluster', SLUG, 'a lowercase slug')
    pattern(pack.target.namespace, 'target.namespace', SLUG, 'a lowercase slug')
    if (object(pack.target.workload, 'target.workload', ['kind', 'name'])) {
      pattern(pack.target.workload.kind, 'target.workload.kind', /^(Deployment|StatefulSet|DaemonSet|Job)$/, 'a workload kind')
      pattern(pack.target.workload.name, 'target.workload.name', SLUG, 'a lowercase slug')
    }
  }

  if (list(pack.evidence, 'evidence', 1, 20)) {
    pack.evidence.forEach((item, index) => {
      const path = `evidence[${index}]`
      if (!object(item, path, ['id', 'type', 'source', 'uri', 'collectedAt', 'digest', 'data'])) return
      pattern(item.id, `${path}.id`, SLUG, 'a lowercase slug')
      pattern(item.type, `${path}.type`, /^[a-z][a-z0-9_-]{0,40}$/, 'an evidence type')
      pattern(item.source, `${path}.source`, /^[a-z][a-z0-9_]{0,40}$/, 'a collector name')
      pattern(item.uri, `${path}.uri`, /^k8s:\/\/[a-z0-9][a-z0-9-]{0,62}\/[\x21-\x7e]{1,300}$/, 'a k8s:// URI')
      pattern(item.collectedAt, `${path}.collectedAt`, ISO_TIME, 'an ISO-8601 UTC timestamp')
      pattern(item.digest, `${path}.digest`, DIGEST, '"sha256:<64 hex>"')
      if (!isObject(item.data)) problems.push(`${path}.data: must be an object`)
    })
    unique(pack.evidence.map((item) => item?.id), 'evidence')
  }

  if (object(pack.analysis, 'analysis', ['kind', 'producer', 'hypotheses', 'recommendations'])) {
    if (pack.analysis.kind !== 'recorded') problems.push('analysis.kind: must be "recorded"; live analysis is not supported')
    text(pack.analysis.producer, 'analysis.producer', 80)
    if (list(pack.analysis.hypotheses, 'analysis.hypotheses', 1, 5)) {
      pack.analysis.hypotheses.forEach((hypothesis, index) => {
        const path = `analysis.hypotheses[${index}]`
        if (!object(hypothesis, path, ['id', 'statement', 'evidenceRefs', 'claims'])) return
        pattern(hypothesis.id, `${path}.id`, SLUG, 'a lowercase slug')
        text(hypothesis.statement, `${path}.statement`, 400)
        if (list(hypothesis.evidenceRefs, `${path}.evidenceRefs`, 0, 20)) hypothesis.evidenceRefs.forEach((ref, i) => pattern(ref, `${path}.evidenceRefs[${i}]`, SLUG, 'an evidence id'))
        if (list(hypothesis.claims, `${path}.claims`, 1, 20)) {
          hypothesis.claims.forEach((claim, i) => {
            const claimPath = `${path}.claims[${i}]`
            if (!object(claim, claimPath, ['id', 'statement', 'factRef', 'assertion'])) return
            pattern(claim.id, `${claimPath}.id`, SLUG, 'a lowercase slug')
            text(claim.statement, `${claimPath}.statement`, 300)
            // factRef and assertion content are judged per claim (status "invalid"), not here.
          })
          unique(hypothesis.claims.map((claim) => claim?.id), `${path}.claims`)
        }
      })
      unique(pack.analysis.hypotheses.map((hypothesis) => hypothesis?.id), 'analysis.hypotheses')
    }
    if (list(pack.analysis.recommendations, 'analysis.recommendations', 0, 10)) {
      const hypothesisIds = new Set((pack.analysis.hypotheses ?? []).map((hypothesis) => hypothesis?.id))
      pack.analysis.recommendations.forEach((recommendation, index) => {
        const path = `analysis.recommendations[${index}]`
        // Deliberately no execution fields: the pack cannot declare that anything runs.
        if (!object(recommendation, path, ['id', 'text', 'basedOn', 'actionClass'])) return
        pattern(recommendation.id, `${path}.id`, SLUG, 'a lowercase slug')
        text(recommendation.text, `${path}.text`, 600)
        pattern(recommendation.actionClass, `${path}.actionClass`, /^(configuration_change|read_only_check|escalation)$/, 'configuration_change, read_only_check or escalation')
        if (list(recommendation.basedOn, `${path}.basedOn`, 1, 5)) {
          for (const ref of recommendation.basedOn) if (!hypothesisIds.has(ref)) problems.push(`${path}.basedOn: unknown hypothesis "${ref}"`)
        }
      })
      unique(pack.analysis.recommendations.map((recommendation) => recommendation?.id), 'analysis.recommendations')
    }
  }

  for (const path of findForbiddenFieldPaths(pack)) problems.push(`${path}: credential-like fields are not allowed in a pack`)
  return problems.length ? { ok: false, problems } : { ok: true, problems: [] }
}

// Loads every *.json pack from OK_CONSOLE_INVESTIGATION_PACKS_DIR once at startup (fail closed). Files must
// resolve inside the directory. Returns null when not configured (the investigation routes then answer 404).
export const loadInvestigationPacks = async (dir, io = { readdir, readFile, realpath, stat }) => {
  if (dir === undefined || dir === '') return null
  if (!isAbsolute(dir)) throw new InvestigationPackError(['OK_CONSOLE_INVESTIGATION_PACKS_DIR must be an absolute path'])
  let realDir
  try { realDir = await io.realpath(dir) } catch { throw new InvestigationPackError(['OK_CONSOLE_INVESTIGATION_PACKS_DIR: directory not found']) }
  const names = (await io.readdir(realDir)).filter((name) => name.endsWith('.json')).sort()
  if (names.length === 0) throw new InvestigationPackError(['OK_CONSOLE_INVESTIGATION_PACKS_DIR: no *.json pack found'])
  if (names.length > MAX_PACKS) throw new InvestigationPackError([`at most ${MAX_PACKS} packs are allowed`])
  const problems = []
  const packs = new Map()
  for (const name of names) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}\.json$/.test(name)) { problems.push(`${name}: file name must be a lowercase slug`); continue }
    const real = await io.realpath(join(dir, name))
    if (!real.startsWith(`${realDir}${sep}`)) { problems.push(`${name}: resolves outside the pack directory`); continue }
    const metadata = await io.stat(real)
    if (!metadata.isFile() || metadata.size < 2 || metadata.size > MAX_PACK_BYTES) { problems.push(`${name}: must be a regular file of at most ${MAX_PACK_BYTES} bytes`); continue }
    let pack
    try { pack = JSON.parse((await io.readFile(real)).toString('utf8')) } catch { problems.push(`${name}: not valid JSON`); continue }
    const result = validateInvestigationPack(pack)
    if (!result.ok) { problems.push(...result.problems.map((problem) => `${name}: ${problem}`)); continue }
    if (packs.has(pack.scenario.id)) { problems.push(`${name}: duplicate scenario id "${pack.scenario.id}"`); continue }
    packs.set(pack.scenario.id, Object.freeze({ pack: structuredClone(pack), packDigest: sha256Digest(pack), file: name }))
  }
  if (problems.length) throw new InvestigationPackError(problems)
  return packs
}
