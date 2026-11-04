import { createAttempt, attachAttempt } from '../diagnostics.mjs'
import { classifySourceFailure, sourceTransportError, sourceDeadlineError, sourceHttpError } from './sourceFailure.mjs'

const QUERY_VERSION = 'observed.openkubes.io/v0alpha2'
const QUERY_KIND = 'ConsoleObservedState'
const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1_000
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_FUTURE_SKEW_MS = 60 * 1_000

const READINESS = new Set(['Ready', 'Pending', 'Failed', 'Unknown'])
const ROLES = new Set(['Management plane', 'Infrastructure plane', 'Workload cluster'])
const COMPATIBILITY = new Set(['Supported', 'Read only'])
const CLASSIFICATION = new Set(['Immutable', 'Current'])
const EVIDENCE_TYPES = new Set(['Observation', 'Transition', 'Authorization'])
const EVIDENCE_OUTCOMES = new Set(['Ready', 'Pending', 'Failed', 'Unknown', 'Approved', 'Denied'])

const redactSummary = () => ({
  summary: 'Evidence summary withheld by the Console redaction boundary.',
  redacted: true,
})

// Match normalized text, but preserve the original scalar unless withholding it.
// Credential value shapes apply to every field, including identifiers and ownership.
const CREDENTIAL_SHAPES = new RegExp([
  /-----\s*BEGIN\b[\s\S]*?-----/, // PEM armor
  /PuTTY-User-Key-File-/,
  /authorization(?:[\W_]|%[0-9a-f]{2}|\\[trn])+(?:bearer|basic|negotiate|ntlm|digest)(?!-)(?:[\W_]|%[0-9a-f]{2}|\\[trn])+\S{8,}/,
  /bearer\s+(?=[a-z0-9._~+/-]*[0-9._~+/=])[a-z0-9._~+/-]{16,}=*/,
  /(?<![a-z0-9+.-])[a-z0-9+.-]+:(?:\\?\/){2}[^\s/@?#]+@/, // URL userinfo
].map((pattern) => pattern.source).join('|'), 'i')
// Base64 of `-----BEGIN` at each byte alignment, and the OpenSSH key header; case-sensitive.
const ENCODED_KEY_MARKERS = /LS0tLS1CRUdJT|tLS0tQkVHSU4|LS0tLUJFR0lO|b3BlbnNzaC1rZXktdjE/
// One candidate per base64url run (the lookbehind keeps the scan linear); a JWT has an `eyJ` header.
const DOTTED_TOKEN = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]+(?:=*\.[A-Za-z0-9_-]+){1,2}=*\.?/g
const hasJwt = (text) => [...text.matchAll(DOTTED_TOKEN)].some(([token]) => {
  const header = token.indexOf('eyJ')
  return header !== -1 && token.indexOf('.', header) !== -1
})
// Keywords and assignment forms apply to display fields only.
const DISPLAY_ONLY_PATTERN = new RegExp([
  /(?:password|passphrase|token|secret|private[_\s-]*key|api[_\s-]*key|kubeconfig|client[_\s-]*(?:key|certificate)[_\s-]*data|auth[_\s-]*provider|passwd|pwd|credential|access[_\s-]*key|cookie|auth(?=["'\s]*[:=]))/,
  /authorization["'\s]*[:=]/,
  /authorization[\s\S]{0,40}(?:bearer|basic|negotiate|ntlm|digest)/,
  /bearer\W*\S+/,
  /(?:pass|key|sig|session(?:id)?)["'\s]*[:=]/,
].map((pattern) => pattern.source).join('|'), 'i')
const REDACTED_TEXT = 'Value withheld by the Console redaction boundary.'
const matchingText = (value) => /^[\x20-\x7e]*$/.test(value)
  ? value : value.normalize('NFKC').replace(/\p{Default_Ignorable_Code_Point}/gu, '')
const hasCredentialShape = (text) => CREDENTIAL_SHAPES.test(text)
  || ENCODED_KEY_MARKERS.test(text)
  || (text.includes('.') && hasJwt(text))
const hasCredentialValue = (value) => hasCredentialShape(matchingText(value))
const redactText = (value) => {
  const text = matchingText(value)
  return hasCredentialShape(text) || DISPLAY_ONLY_PATTERN.test(text)
    ? REDACTED_TEXT : value
}

export class ObservedStateContractError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ObservedStateContractError'
  }
}

const record = (value, path) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object.`)
  return value
}

const list = (value, path) => {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array.`)
  return value
}

const string = (value, path) => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) throw new Error(`${path} must be a non-empty bounded string.`)
  return value
}

// Field grammars run before the credential deny-list. Never repair producer identities.
const ID = /^[a-z0-9](?:[a-z0-9.-]{0,510}[a-z0-9])?$/
const DNS_LABEL = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/
const DNS_NAME = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$/
const dnsName = (value) => value.length <= 253 && DNS_NAME.exec(value)?.[0] === value
  && value.split('.').every((label) => DNS_LABEL.test(label))
const words = (value) => value.length <= 64 && /^[A-Za-z]+(?: [A-Za-z]+){0,5}$/.test(value)
const version = (value) => {
  if (value === 'unknown') return true
  const match = /^(v?[0-9]{1,10}\.[0-9]{1,10}(?:\.[0-9]{1,10})?)(?:-([A-Za-z0-9-]{1,16}(?:\.[A-Za-z0-9-]{1,16}){0,3}))?(?:\+([A-Za-z0-9-]{1,16}(?:\.[A-Za-z0-9-]{1,16}){0,3}))?$/.exec(value)
  return value.length <= 64 && !!match && (match[2]?.length ?? 0) <= 32 && (match[3]?.length ?? 0) <= 32
}
const placementName = (value) => {
  const parts = value.split('/')
  return parts.length === 2 && DNS_LABEL.test(parts[0]) && dnsName(parts[1])
}
const oneOf = (...values) => (value) => values.includes(value)
const clusterContract = oneOf('unknown', 'platform.openkubes.ai/v1alpha1', 'kubernetes.io/core+apps/v1')
const evidenceContract = oneOf('Unavailable', 'KubeVirtClusterClaim/v1alpha1', 'Kubernetes core/apps v1', 'Deployment/apps/v1')
const sources = [
  'OpenKubes hosting-cluster source boundary', 'Bounded Kubernetes API projection',
  'Authenticated hosting-cluster Kubernetes API', 'OpenKubes observed-state producer',
  'OpenKubes management-plane Kubernetes API', 'Operator-provided read-only observation bundle',
]
const lifecycleLabel = oneOf('Source boundary', 'Compositions', 'Kubernetes API', 'Nodes', 'Console workload', 'OpenKubes Compositions', 'Declared', 'Infrastructure', 'Control plane', 'Capabilities', 'External observation', 'Management capabilities')
const detailLiterals = [
  'The hosting-cluster source does not observe the OpenKubes management plane.',
  'Composition state is outside this bounded Phase B1 source.',
  'The bounded read-only Kubernetes API queries completed.',
  'Composition and multi-cluster state are intentionally outside Phase B1.',
  'The bounded read-only management-cluster observation completed.',
  'Operator-provided read-only cluster observation.',
  'Management capabilities are not verified by this observation.',
  'No normative Management Plane Contract is available from this source.',
  'Infrastructure readiness is outside this source boundary.',
  'API reachability is not converted into normative readiness.',
  'Capability observations are not available from this source.',
  'The namespaced OpenKubes cluster Claim exists.',
  'The OpenKubes cluster Claim reports Ready=True.',
  'The OpenKubes cluster Claim reports Ready=False.',
  'The OpenKubes cluster Claim has no recognized Ready Condition.',
  'This source exposes no normative control-plane Condition.',
]
const canonicalCount = (value) => /^(?:0|[1-9][0-9]{0,15})$/.test(value) && Number.isSafeInteger(Number(value))
const lifecycleDetail = (value) => {
  if (detailLiterals.includes(value)) return value
  let match = /^Ready: ([0-9]+); not ready: ([0-9]+); unknown: ([0-9]+)\.$/.exec(value)
  if (match && match.slice(1).every(canonicalCount)) return `Ready: ${Number(match[1])}; not ready: ${Number(match[2])}; unknown: ${Number(match[3])}.`
  match = /^Available replicas: ([0-9]+|unknown) of ([0-9]+|unknown)\.$/.exec(value)
  if (match && match.slice(1).every((part) => part === 'unknown' || canonicalCount(part))) {
    const render = (part) => part === 'unknown' ? part : String(Number(part))
    return `Available replicas: ${render(match[1])} of ${render(match[2])}.`
  }
  return null
}
const evidenceTitle = (value, cluster, source, placements) => (
  (cluster?.role === 'Management plane' && (
    (source === sources[0] && value === 'Management plane outside hosting source')
    || (source === sources[3] && value === 'Management plane observation boundary')
  ))
  || (dnsName(cluster?.name ?? '') && [
    [sources[1], 'hosting-cluster state'],
    [sources[4], 'cluster Claim readiness'],
    [sources[5], 'external cluster observation'],
  ].some(([expectedSource, suffix]) => source === expectedSource && value === `${cluster.name} ${suffix}`))
  || (source === sources[2] && placements.some((placement) => placementName(placement.name) && value === `Deployment ${placement.name}`))
)
const Q = '(?:unknown|[0-9]{1,128})'
const clusterRevision = (value, source) => {
  if (source === sources[5]) return value === 'external-observation'
  if (source === sources[0]) return value === 'not-observed-by-hosting-source'
  if (source === sources[3]) return new RegExp(`^claimListResourceVersion:${Q}$`).test(value)
  if (source === sources[4]) return new RegExp(`^resourceVersion:${Q}$`).test(value)
  if (source === sources[1]) return new RegExp(`^nodes:${Q};deployment:${Q}$`).test(value)
  return false
}
const evidenceRevision = (value, source) => {
  if (source !== sources[2]) return clusterRevision(value, source)
  const match = new RegExp(`^resourceVersion:${Q};replicas:([0-9]+|None)/([0-9]+|None)$`).exec(value)
  return !!match && match.slice(1).every((part) => part === 'None' || canonicalCount(part))
}
const sourceRevision = (value) => {
  if (new RegExp(`^kubevirtclusterclaims:${Q}$`).test(value)) return true
  const match = new RegExp(`^kubernetes:([^;]+);nodes:${Q};deployment:${Q}$`).exec(value)
  return !!match && version(match[1])
}
const timestamp = (value) => {
  if (typeof value !== 'string') return false
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]{1,9})?(?:Z|[+-]([0-9]{2}):([0-9]{2}))$/.exec(value)
  if (!match || match[0] !== value) return false
  const [, year, month, day, hour, minute, second, offsetHour = '0', offsetMinute = '0'] = match
  const y = Number(year)
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][Number(month) - 1]
  return Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= days
    && Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59
    && Number(offsetHour) <= 23 && Number(offsetMinute) <= 59 && Number.isFinite(Date.parse(value))
}
const displayString = (value, path, grammar) => {
  const item = string(value, path)
  return grammar(item) ? redactText(item) : REDACTED_TEXT
}
const identifierString = (value, path) => {
  const item = string(value, path)
  if (!ID.test(item)) throw new Error(`${path} must match the ID grammar.`)
  if (hasCredentialValue(item)) throw new Error(`${path} must not contain a credential value.`)
  return item
}
const clusterName = (value, path) => {
  const item = string(value, path)
  if (!dnsName(item)) throw new Error(`${path} must be a DNS subdomain.`)
  if (hasCredentialValue(item)) throw new Error(`${path} must not contain a credential value.`)
  return redactText(item)
}

const enumeration = (value, allowed, path) => {
  const item = string(value, path)
  if (!allowed.has(item)) throw new Error(`${path} is not supported.`)
  return item
}

const count = (value, path) => {
  if (value === null) return null
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${path} must be a non-negative integer.`)
  return value
}

const containsControlCharacter = (value) => (
  typeof value === 'string'
  && [...value].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint <= 31 || codePoint === 127
  })
)

const ownershipString = (value, path) => {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 256
    || value !== value.trim()
    || containsControlCharacter(value)
    // Ownership is authorization data: reject rather than collapse distinct identities.
    || hasCredentialValue(value)
  ) throw new Error(`${path} must be a valid non-empty bounded string.`)
  return value
}

const normalizeOwnership = (value, path, environmentId) => {
  const item = record(value, path)
  const ownership = {
    environmentId: ownershipString(item.environmentId, `${path}.environmentId`),
    tenantId: ownershipString(item.tenantId, `${path}.tenantId`),
  }
  if (ownership.environmentId !== environmentId) throw new Error(`${path}.environmentId must match $.data.environment.id.`)
  return ownership
}

const sameOwnership = (left, right) => (
  left.environmentId === right.environmentId && left.tenantId === right.tenantId
)

const assertUniqueIds = (items, label) => {
  const ids = new Set()
  for (const item of items) {
    if (ids.has(item.id)) throw new Error(`Observed state contains a duplicate ${label} ID.`)
    ids.add(item.id)
  }
}

const metricSet = (value, path) => {
  const item = record(value, path)
  return {
    total: count(item.total, `${path}.total`),
    ready: count(item.ready, `${path}.ready`),
    pending: count(item.pending, `${path}.pending`),
    failed: count(item.failed, `${path}.failed`),
    unknown: count(item.unknown, `${path}.unknown`),
  }
}

const normalizeCapability = (value, path, environmentId) => {
  const item = record(value, path)
  return {
    id: identifierString(item.id, `${path}.id`),
    name: displayString(item.name, `${path}.name`, words),
    readiness: enumeration(item.readiness, READINESS, `${path}.readiness`),
    evidenceId: identifierString(item.evidenceId, `${path}.evidenceId`),
    ownership: normalizeOwnership(item.ownership, `${path}.ownership`, environmentId),
  }
}

const normalizeCluster = (value, path, environmentId, rawEvidence) => {
  const item = record(value, path)
  return {
    id: identifierString(item.id, `${path}.id`),
    name: clusterName(item.name, `${path}.name`),
    role: enumeration(item.role, ROLES, `${path}.role`),
    provider: displayString(item.provider, `${path}.provider`, words),
    profile: displayString(item.profile, `${path}.profile`, words),
    kubernetesVersion: displayString(item.kubernetesVersion, `${path}.kubernetesVersion`, version),
    region: displayString(item.region, `${path}.region`, (value) => DNS_LABEL.test(value)),
    readiness: enumeration(item.readiness, READINESS, `${path}.readiness`),
    compatibility: enumeration(item.compatibility, COMPATIBILITY, `${path}.compatibility`),
    contractVersion: displayString(item.contractVersion, `${path}.contractVersion`, clusterContract),
    revision: displayString(item.revision, `${path}.revision`, (value) => clusterRevision(value, rawEvidence.find((evidence) => evidence.id === item.evidenceId)?.source)),
    evidenceId: identifierString(item.evidenceId, `${path}.evidenceId`),
    ownership: normalizeOwnership(item.ownership, `${path}.ownership`, environmentId),
    capabilities: list(item.capabilities, `${path}.capabilities`).map((capability, index) => normalizeCapability(capability, `${path}.capabilities[${index}]`, environmentId)),
    lifecycle: list(item.lifecycle, `${path}.lifecycle`).map((stage, index) => {
      const stagePath = `${path}.lifecycle[${index}]`
      const stageRecord = record(stage, stagePath)
      return {
        label: displayString(stageRecord.label, `${stagePath}.label`, lifecycleLabel),
        state: enumeration(stageRecord.state, READINESS, `${stagePath}.state`),
        detail: displayString(stageRecord.detail, `${stagePath}.detail`, (value) => lifecycleDetail(value) !== null) === REDACTED_TEXT ? REDACTED_TEXT : lifecycleDetail(stageRecord.detail),
      }
    }),
  }
}

const normalizePlacement = (value, path, environmentId) => {
  const item = record(value, path)
  return {
    id: identifierString(item.id, `${path}.id`),
    name: displayString(item.name, `${path}.name`, placementName),
    targetCluster: displayString(item.targetCluster, `${path}.targetCluster`, dnsName),
    targetClusterId: identifierString(item.targetClusterId, `${path}.targetClusterId`),
    readiness: enumeration(item.readiness, READINESS, `${path}.readiness`),
    evidenceId: identifierString(item.evidenceId, `${path}.evidenceId`),
    ownership: normalizeOwnership(item.ownership, `${path}.ownership`, environmentId),
  }
}

const normalizeEvidence = (value, path, environmentId, rawClusters, rawPlacements) => {
  const item = record(value, path)
  string(item.summary, `${path}.summary`)
  const summary = redactSummary()
  // The global size limit still rejects; other timestamp failures affect only this item.
  if (typeof item.observedAt === 'string' && item.observedAt.length > 512) string(item.observedAt, `${path}.observedAt`)
  return {
    id: identifierString(item.id, `${path}.id`),
    title: displayString(item.title, `${path}.title`, (value) => evidenceTitle(value, rawClusters.find((cluster) => cluster.id === item.clusterId), item.source, rawPlacements.filter((placement) => placement.evidenceId === item.id && placement.targetClusterId === item.clusterId))),
    type: enumeration(item.type, EVIDENCE_TYPES, `${path}.type`),
    outcome: enumeration(item.outcome, EVIDENCE_OUTCOMES, `${path}.outcome`),
    clusterId: identifierString(item.clusterId, `${path}.clusterId`),
    contract: displayString(item.contract, `${path}.contract`, evidenceContract),
    revision: displayString(item.revision, `${path}.revision`, (value) => evidenceRevision(value, item.source)),
    observedAt: typeof item.observedAt === 'string' ? item.observedAt : null,
    source: displayString(item.source, `${path}.source`, oneOf(...sources)),
    summary: summary.summary,
    classification: enumeration(item.classification, CLASSIFICATION, `${path}.classification`),
    redacted: summary.redacted,
    ownership: normalizeOwnership(item.ownership, `${path}.ownership`, environmentId),
  }
}

const normalizeMetricBucket = (value, path, environmentId) => {
  const item = record(value, path)
  const findings = record(item.openFindings, `${path}.openFindings`)
  return {
    ownership: normalizeOwnership(item.ownership, `${path}.ownership`, environmentId),
    capabilities: metricSet(item.capabilities, `${path}.capabilities`),
    workloadClaims: metricSet(item.workloadClaims, `${path}.workloadClaims`),
    openFindings: {
      total: count(findings.total, `${path}.openFindings.total`),
      critical: count(findings.critical, `${path}.openFindings.critical`),
    },
  }
}

// Cleanup must not replace the status, contract or size failure already observed.
const cancelBody = async (body) => {
  try { await body?.cancel() } catch { /* Ignore cleanup errors. */ }
}

const readBoundedBody = async (response) => {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks = []
  let received = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > MAX_RESPONSE_BYTES) {
      await cancelBody(reader)
      throw new Error('OpenKubes observed-state response exceeds the size limit.')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')
}

export const normalizeOpenKubesObservedState = (payload, { now = () => new Date(), staleAfterMs = DEFAULT_STALE_AFTER_MS } = {}) => {
  const envelope = record(payload, '$')
  if (envelope.apiVersion !== QUERY_VERSION || envelope.kind !== QUERY_KIND) throw new ObservedStateContractError('Observed-state query contract is incompatible.')
  const metadata = record(envelope.metadata, '$.metadata')
  const data = record(envelope.data, '$.data')
  const observedAt = string(metadata.observedAt, '$.metadata.observedAt')
  const observedTime = Date.parse(observedAt)
  if (!timestamp(observedAt)) throw new Error('$.metadata.observedAt must be an ISO timestamp.')
  const environment = record(data.environment, '$.data.environment')
  const environmentId = identifierString(environment.id, '$.data.environment.id')
  const metrics = list(data.metrics, '$.data.metrics').map((bucket, index) => normalizeMetricBucket(bucket, `$.data.metrics[${index}]`, environmentId))
  const clusters = list(data.clusters, '$.data.clusters').map((cluster, index) => normalizeCluster(cluster, `$.data.clusters[${index}]`, environmentId, list(data.evidence, '$.data.evidence')))
  const placements = list(data.placements, '$.data.placements').map((placement, index) => normalizePlacement(placement, `$.data.placements[${index}]`, environmentId))
  const evidence = list(data.evidence, '$.data.evidence').map((item, index) => normalizeEvidence(item, `$.data.evidence[${index}]`, environmentId, data.clusters, data.placements))

  if (clusters.filter((cluster) => cluster.role === 'Management plane').length !== 1) throw new Error('Observed state must contain exactly one management plane.')
  assertUniqueIds(clusters, 'cluster')
  assertUniqueIds(evidence, 'Evidence')
  assertUniqueIds(placements, 'placement')
  for (const cluster of clusters) {
    assertUniqueIds(cluster.capabilities, `capability within cluster ${cluster.id}`)
    if (cluster.capabilities.some((capability) => !sameOwnership(capability.ownership, cluster.ownership))) {
      throw new Error('A capability ownership must match its parent cluster ownership.')
    }
  }

  const clustersById = new Map(clusters.map((cluster) => [cluster.id, cluster]))
  const evidenceById = new Map(evidence.map((item) => [item.id, item]))
  for (const item of evidence) {
    const cluster = clustersById.get(item.clusterId)
    if (!cluster) throw new Error('Observed state contains an unresolved Evidence cluster reference.')
    if (!sameOwnership(item.ownership, cluster.ownership)) throw new Error('Evidence ownership must match its cluster ownership.')
  }
  for (const placement of placements) {
    const cluster = clustersById.get(placement.targetClusterId)
    if (!cluster) throw new Error('Observed state contains an unresolved placement target cluster reference.')
    if (!sameOwnership(placement.ownership, cluster.ownership)) throw new Error('Placement ownership must match its target cluster ownership.')
  }
  const evidenceReferences = [
    ...clusters.map((cluster) => ({ evidenceId: cluster.evidenceId, ownership: cluster.ownership })),
    ...clusters.flatMap((cluster) => cluster.capabilities.map((capability) => ({ evidenceId: capability.evidenceId, ownership: capability.ownership }))),
    ...placements.map((placement) => ({ evidenceId: placement.evidenceId, ownership: placement.ownership })),
  ]
  for (const reference of evidenceReferences) {
    const item = evidenceById.get(reference.evidenceId)
    if (!item) throw new Error('Observed state contains an unresolved Evidence reference.')
    if (!sameOwnership(reference.ownership, item.ownership)) throw new Error('Observed state contains a cross-owner Evidence reference.')
  }

  const nowMs = now().getTime()
  const ageMs = nowMs - observedTime
  if (ageMs < -MAX_FUTURE_SKEW_MS) throw new Error('Observed-state timestamp is too far in the future.')
  const stale = ageMs > staleAfterMs
  const validEvidence = evidence.filter((item) => timestamp(item.observedAt))
  for (const item of validEvidence) {
    const itemAgeMs = nowMs - Date.parse(item.observedAt)
    item.freshness = stale || itemAgeMs < -MAX_FUTURE_SKEW_MS
      || (item.classification === 'Current' && itemAgeMs > staleAfterMs) ? 'Stale' : 'Current'
  }
  const affectedTenants = new Set(evidence.filter((item) => !timestamp(item.observedAt) || item.freshness === 'Stale').map((item) => item.ownership.tenantId))
  for (const bucket of metrics) {
    if (stale || affectedTenants.has(bucket.ownership.tenantId)) {
      for (const category of ['capabilities', 'workloadClaims']) {
        for (const field of ['ready', 'pending', 'failed', 'unknown']) bucket[category][field] = null
      }
      bucket.openFindings.total = null
      bucket.openFindings.critical = null
    }
  }
  const currentEvidenceIds = new Set(validEvidence.filter((item) => item.freshness === 'Current').map((item) => item.id))
  const downgradeReadiness = (item) => {
    if (!currentEvidenceIds.has(item.evidenceId)) item.readiness = 'Unknown'
  }
  for (const cluster of clusters) {
    downgradeReadiness(cluster)
    if (!currentEvidenceIds.has(cluster.evidenceId)) {
      for (const stage of cluster.lifecycle) stage.state = 'Unknown'
    }
    cluster.capabilities.forEach(downgradeReadiness)
  }
  placements.forEach(downgradeReadiness)
  if (Object.prototype.hasOwnProperty.call(metadata, 'partial') && typeof metadata.partial !== 'boolean') {
    throw new ObservedStateContractError('$.metadata.partial must be a boolean when present.')
  }
  const partial = metadata.partial === true
  return {
    observedAt,
    sourceRevision: displayString(metadata.sourceRevision, '$.metadata.sourceRevision', sourceRevision),
    environment: {
      id: environmentId,
      displayName: displayString(environment.displayName, '$.data.environment.displayName', words),
    },
    metrics,
    clusters,
    placements,
    // Validate the complete identity/ownership graph above, then make only invalid
    // Evidence unavailable. Existing references resolve to 404, never fabricated time.
    evidence: validEvidence,
    sourceHealth: {
      freshness: stale ? 'Stale' : 'Current',
      warnings: [
        ...(stale ? [{ code: 'SOURCE_STALE', message: 'The latest OpenKubes observation is outside the configured freshness window.' }] : []),
        ...(partial ? [{ code: 'PARTIAL_DATA', message: 'The OpenKubes query source reported a partial observation.' }] : []),
        ...(evidence.some((item) => item.redacted) ? [{ code: 'REDACTED', message: 'Observed-state values were withheld by grammar checks or the Console redaction boundary.' }] : []),
      ],
    },
  }
}

export class OpenKubesObservedStateAdapter {
  constructor({ url, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, staleAfterMs = DEFAULT_STALE_AFTER_MS, now = () => new Date() }) {
    this.url = new URL(url)
    if (this.url.username || this.url.password) throw new Error('OpenKubes observed-state URL must not contain credentials.')
    if (this.url.protocol !== 'https:' && !(this.url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(this.url.hostname))) {
      throw new Error('OpenKubes observed-state URL must use HTTPS, except for loopback integration environments.')
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('OpenKubes observed-state timeout must be a positive integer.')
    if (!Number.isInteger(staleAfterMs) || staleAfterMs < 1) throw new Error('OpenKubes stale threshold must be a positive integer.')
    this.fetchImpl = fetchImpl
    this.timeoutMs = timeoutMs
    this.staleAfterMs = staleAfterMs
    this.now = now
  }

  async readSnapshot() {
    const attempt = createAttempt()
    const controller = new AbortController()
    const deadline = Symbol('adapter deadline')
    let responseReceived = false
    let response
    const timer = setTimeout(() => controller.abort(deadline), this.timeoutMs)
    try {
      response = await this.fetchImpl(this.url, {
        sourceAttempt: attempt,
        method: 'GET',
        headers: { Accept: `application/json; profile="${QUERY_VERSION}"` },
        redirect: 'error',
        signal: controller.signal,
      })
      responseReceived = true
      if (!response.ok) {
        attempt.phase('AWAIT_HEADERS')
        await cancelBody(response.body)
        throw sourceHttpError(response.status)
      }
      attempt.phase('VALIDATION')
      const contentType = response.headers.get('content-type') ?? ''
      const mediaType = contentType.split(';', 1)[0].trim().toLowerCase()
      const responseProfile = contentType.match(/(?:^|;)\s*profile\s*=\s*"([^"]+)"/i)?.[1]
      if (mediaType !== 'application/json' || responseProfile !== QUERY_VERSION) {
        await cancelBody(response.body)
        throw new ObservedStateContractError('Observed-state query response profile is incompatible.')
      }
      const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '0', 10)
      if (declaredLength > MAX_RESPONSE_BYTES) {
        await cancelBody(response.body)
        throw new Error('OpenKubes observed-state response exceeds the size limit.')
      }
      attempt.phase('BODY')
      const body = await readBoundedBody(response)
      attempt.complete(null, 'BODY_COMPLETE', 'VALIDATION')
      try {
        const snapshot = normalizeOpenKubesObservedState(JSON.parse(body), { now: this.now, staleAfterMs: this.staleAfterMs })
        attempt.complete(null, 'CONTRACT_VALIDATED', 'OTHER')
        return snapshot
      } catch (error) {
        if (error instanceof ObservedStateContractError) throw error
        throw new ObservedStateContractError('Observed-state response failed structural or semantic contract validation.')
      }
    } catch (error) {
      if (error instanceof ObservedStateContractError) throw attachAttempt(error, attempt)
      const diagnostic = classifySourceFailure(error)
      // A completed TLS phase means the client completed a TLS handshake with an endpoint the configured CA trusts.
      const tlsEstablished = Object.hasOwn(attempt.finish().phaseMs, 'tls')
      if (controller.signal.reason === deadline && diagnostic.class !== 'TRUST_REJECTED' && diagnostic.httpStatus === 'NONE') {
        throw attachAttempt(sourceDeadlineError(responseReceived, diagnostic.nodeCode === 'ETIMEDOUT', tlsEstablished), attempt)
      }
      if (responseReceived && diagnostic.nodeCode === 'ETIMEDOUT') throw attachAttempt(sourceDeadlineError(true, true), attempt)
      throw attachAttempt(sourceTransportError(error, responseReceived, tlsEstablished), attempt)
    } finally {
      attempt.finish()
      clearTimeout(timer)
      // Fetch exposes no body for 204/205/304; stop any Node stream still draining.
      if (response?.body === null) controller.abort()
    }
  }
}

export const OPENKUBES_QUERY_VERSION = QUERY_VERSION
