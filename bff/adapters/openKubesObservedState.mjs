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

const displayString = (value, path) => redactText(string(value, path))

const identifierString = (value, path) => {
  const item = string(value, path)
  if (hasCredentialValue(item)) throw new Error(`${path} must not contain a credential value.`)
  return item
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
    name: displayString(item.name, `${path}.name`),
    readiness: enumeration(item.readiness, READINESS, `${path}.readiness`),
    evidenceId: identifierString(item.evidenceId, `${path}.evidenceId`),
    ownership: normalizeOwnership(item.ownership, `${path}.ownership`, environmentId),
  }
}

const normalizeCluster = (value, path, environmentId) => {
  const item = record(value, path)
  return {
    id: identifierString(item.id, `${path}.id`),
    name: displayString(item.name, `${path}.name`),
    role: enumeration(item.role, ROLES, `${path}.role`),
    provider: displayString(item.provider, `${path}.provider`),
    profile: displayString(item.profile, `${path}.profile`),
    kubernetesVersion: displayString(item.kubernetesVersion, `${path}.kubernetesVersion`),
    region: displayString(item.region, `${path}.region`),
    readiness: enumeration(item.readiness, READINESS, `${path}.readiness`),
    compatibility: enumeration(item.compatibility, COMPATIBILITY, `${path}.compatibility`),
    contractVersion: displayString(item.contractVersion, `${path}.contractVersion`),
    revision: displayString(item.revision, `${path}.revision`),
    evidenceId: identifierString(item.evidenceId, `${path}.evidenceId`),
    ownership: normalizeOwnership(item.ownership, `${path}.ownership`, environmentId),
    capabilities: list(item.capabilities, `${path}.capabilities`).map((capability, index) => normalizeCapability(capability, `${path}.capabilities[${index}]`, environmentId)),
    lifecycle: list(item.lifecycle, `${path}.lifecycle`).map((stage, index) => {
      const stagePath = `${path}.lifecycle[${index}]`
      const stageRecord = record(stage, stagePath)
      return {
        label: displayString(stageRecord.label, `${stagePath}.label`),
        state: enumeration(stageRecord.state, READINESS, `${stagePath}.state`),
        detail: displayString(stageRecord.detail, `${stagePath}.detail`),
      }
    }),
  }
}

const normalizePlacement = (value, path, environmentId) => {
  const item = record(value, path)
  return {
    id: identifierString(item.id, `${path}.id`),
    name: displayString(item.name, `${path}.name`),
    targetCluster: displayString(item.targetCluster, `${path}.targetCluster`),
    targetClusterId: identifierString(item.targetClusterId, `${path}.targetClusterId`),
    readiness: enumeration(item.readiness, READINESS, `${path}.readiness`),
    evidenceId: identifierString(item.evidenceId, `${path}.evidenceId`),
    ownership: normalizeOwnership(item.ownership, `${path}.ownership`, environmentId),
  }
}

const normalizeEvidence = (value, path, environmentId) => {
  const item = record(value, path)
  displayString(item.summary, `${path}.summary`)
  const summary = redactSummary()
  return {
    id: identifierString(item.id, `${path}.id`),
    title: displayString(item.title, `${path}.title`),
    type: enumeration(item.type, EVIDENCE_TYPES, `${path}.type`),
    outcome: enumeration(item.outcome, EVIDENCE_OUTCOMES, `${path}.outcome`),
    clusterId: identifierString(item.clusterId, `${path}.clusterId`),
    contract: displayString(item.contract, `${path}.contract`),
    revision: displayString(item.revision, `${path}.revision`),
    observedAt: displayString(item.observedAt, `${path}.observedAt`),
    source: displayString(item.source, `${path}.source`),
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
      await reader.cancel()
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
  const observedAt = displayString(metadata.observedAt, '$.metadata.observedAt')
  const observedTime = Date.parse(observedAt)
  if (!Number.isFinite(observedTime)) throw new Error('$.metadata.observedAt must be an ISO timestamp.')
  const environment = record(data.environment, '$.data.environment')
  const environmentId = ownershipString(environment.id, '$.data.environment.id')
  const metrics = list(data.metrics, '$.data.metrics').map((bucket, index) => normalizeMetricBucket(bucket, `$.data.metrics[${index}]`, environmentId))
  const clusters = list(data.clusters, '$.data.clusters').map((cluster, index) => normalizeCluster(cluster, `$.data.clusters[${index}]`, environmentId))
  const placements = list(data.placements, '$.data.placements').map((placement, index) => normalizePlacement(placement, `$.data.placements[${index}]`, environmentId))
  const evidence = list(data.evidence, '$.data.evidence').map((item, index) => normalizeEvidence(item, `$.data.evidence[${index}]`, environmentId))

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

  const ageMs = now().getTime() - observedTime
  if (ageMs < -MAX_FUTURE_SKEW_MS) throw new Error('Observed-state timestamp is too far in the future.')
  const stale = ageMs > staleAfterMs
  if (Object.prototype.hasOwnProperty.call(metadata, 'partial') && typeof metadata.partial !== 'boolean') {
    throw new ObservedStateContractError('$.metadata.partial must be a boolean when present.')
  }
  const partial = metadata.partial === true
  return {
    observedAt,
    sourceRevision: displayString(metadata.sourceRevision, '$.metadata.sourceRevision'),
    environment: {
      id: environmentId,
      displayName: displayString(environment.displayName, '$.data.environment.displayName'),
    },
    metrics,
    clusters,
    placements,
    evidence,
    sourceHealth: {
      freshness: stale ? 'Stale' : 'Current',
      warnings: [
        ...(stale ? [{ code: 'SOURCE_STALE', message: 'The latest OpenKubes observation is outside the configured freshness window.' }] : []),
        ...(partial ? [{ code: 'PARTIAL_DATA', message: 'The OpenKubes query source reported a partial observation.' }] : []),
        ...(evidence.some((item) => item.redacted) ? [{ code: 'REDACTED', message: 'Sensitive Evidence summary content was redacted at the Console source boundary.' }] : []),
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
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchImpl(this.url, {
        method: 'GET',
        headers: { Accept: `application/json; profile="${QUERY_VERSION}"` },
        redirect: 'error',
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`OpenKubes observed-state query returned HTTP ${response.status}.`)
      const contentType = response.headers.get('content-type') ?? ''
      const mediaType = contentType.split(';', 1)[0].trim().toLowerCase()
      const responseProfile = contentType.match(/(?:^|;)\s*profile\s*=\s*"([^"]+)"/i)?.[1]
      if (mediaType !== 'application/json' || responseProfile !== QUERY_VERSION) {
        throw new ObservedStateContractError('Observed-state query response profile is incompatible.')
      }
      const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '0', 10)
      if (declaredLength > MAX_RESPONSE_BYTES) throw new Error('OpenKubes observed-state response exceeds the size limit.')
      const body = await readBoundedBody(response)
      try {
        return normalizeOpenKubesObservedState(JSON.parse(body), { now: this.now, staleAfterMs: this.staleAfterMs })
      } catch (error) {
        if (error instanceof ObservedStateContractError) throw error
        throw new ObservedStateContractError('Observed-state response failed structural or semantic contract validation.')
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

export const OPENKUBES_QUERY_VERSION = QUERY_VERSION
