const QUERY_VERSION = 'observed.openkubes.io/v0alpha1'
const QUERY_KIND = 'ConsoleObservedState'
const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1_000
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_FUTURE_SKEW_MS = 60 * 1_000

const READINESS = new Set(['Ready', 'Pending', 'Failed', 'Unknown'])
const ROLES = new Set(['Management plane', 'Workload cluster'])
const COMPATIBILITY = new Set(['Supported', 'Read only'])
const CLASSIFICATION = new Set(['Immutable', 'Current'])
const EVIDENCE_TYPES = new Set(['Observation', 'Transition', 'Authorization'])
const EVIDENCE_OUTCOMES = new Set(['Ready', 'Pending', 'Failed', 'Unknown', 'Approved', 'Denied'])

const redactSummary = (value) => {
  let redacted = false
  let summary = value
  const replacements = [
    { pattern: /((?:password|passphrase|token|secret|api[_ -]?key|private[_ -]?key|authorization|cookie)\s*[:=]\s*)[^\s,;]+/gi, replacement: '$1[REDACTED]' },
    { pattern: /https?:\/\/[^\s]+/gi, replacement: '[REDACTED_URL]' },
  ]
  for (const { pattern, replacement } of replacements) {
    const next = summary.replace(pattern, replacement)
    redacted ||= next !== summary
    summary = next
  }
  return { summary, redacted }
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

const enumeration = (value, allowed, path) => {
  const item = string(value, path)
  if (!allowed.has(item)) throw new Error(`${path} is not supported.`)
  return item
}

const count = (value, path) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${path} must be a non-negative integer.`)
  return value
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

const normalizeCapability = (value, path) => {
  const item = record(value, path)
  return {
    id: string(item.id, `${path}.id`),
    name: string(item.name, `${path}.name`),
    readiness: enumeration(item.readiness, READINESS, `${path}.readiness`),
    evidenceId: string(item.evidenceId, `${path}.evidenceId`),
  }
}

const normalizeCluster = (value, path) => {
  const item = record(value, path)
  return {
    id: string(item.id, `${path}.id`),
    name: string(item.name, `${path}.name`),
    role: enumeration(item.role, ROLES, `${path}.role`),
    provider: string(item.provider, `${path}.provider`),
    profile: string(item.profile, `${path}.profile`),
    kubernetesVersion: string(item.kubernetesVersion, `${path}.kubernetesVersion`),
    region: string(item.region, `${path}.region`),
    readiness: enumeration(item.readiness, READINESS, `${path}.readiness`),
    compatibility: enumeration(item.compatibility, COMPATIBILITY, `${path}.compatibility`),
    contractVersion: string(item.contractVersion, `${path}.contractVersion`),
    revision: string(item.revision, `${path}.revision`),
    evidenceId: string(item.evidenceId, `${path}.evidenceId`),
    capabilities: list(item.capabilities, `${path}.capabilities`).map((capability, index) => normalizeCapability(capability, `${path}.capabilities[${index}]`)),
    lifecycle: list(item.lifecycle, `${path}.lifecycle`).map((stage, index) => {
      const stagePath = `${path}.lifecycle[${index}]`
      const stageRecord = record(stage, stagePath)
      return {
        label: string(stageRecord.label, `${stagePath}.label`),
        state: enumeration(stageRecord.state, READINESS, `${stagePath}.state`),
        detail: string(stageRecord.detail, `${stagePath}.detail`),
      }
    }),
  }
}

const normalizePlacement = (value, path) => {
  const item = record(value, path)
  return {
    id: string(item.id, `${path}.id`),
    name: string(item.name, `${path}.name`),
    targetCluster: string(item.targetCluster, `${path}.targetCluster`),
    readiness: enumeration(item.readiness, READINESS, `${path}.readiness`),
    evidenceId: string(item.evidenceId, `${path}.evidenceId`),
  }
}

const normalizeEvidence = (value, path) => {
  const item = record(value, path)
  const summary = redactSummary(string(item.summary, `${path}.summary`))
  return {
    id: string(item.id, `${path}.id`),
    title: string(item.title, `${path}.title`),
    type: enumeration(item.type, EVIDENCE_TYPES, `${path}.type`),
    outcome: enumeration(item.outcome, EVIDENCE_OUTCOMES, `${path}.outcome`),
    clusterId: string(item.clusterId, `${path}.clusterId`),
    contract: string(item.contract, `${path}.contract`),
    revision: string(item.revision, `${path}.revision`),
    observedAt: string(item.observedAt, `${path}.observedAt`),
    source: string(item.source, `${path}.source`),
    summary: summary.summary,
    classification: enumeration(item.classification, CLASSIFICATION, `${path}.classification`),
    redacted: summary.redacted,
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
  const observedAt = string(metadata.observedAt, '$.metadata.observedAt')
  const observedTime = Date.parse(observedAt)
  if (!Number.isFinite(observedTime)) throw new Error('$.metadata.observedAt must be an ISO timestamp.')
  const environment = record(data.environment, '$.data.environment')
  const metrics = record(data.metrics, '$.data.metrics')
  const clusters = list(data.clusters, '$.data.clusters').map((cluster, index) => normalizeCluster(cluster, `$.data.clusters[${index}]`))
  const placements = list(data.placements, '$.data.placements').map((placement, index) => normalizePlacement(placement, `$.data.placements[${index}]`))
  const evidence = list(data.evidence, '$.data.evidence').map((item, index) => normalizeEvidence(item, `$.data.evidence[${index}]`))

  if (clusters.filter((cluster) => cluster.role === 'Management plane').length !== 1) throw new Error('Observed state must contain exactly one management plane.')
  const evidenceIds = new Set(evidence.map((item) => item.id))
  const referencedEvidence = [
    ...clusters.map((cluster) => cluster.evidenceId),
    ...clusters.flatMap((cluster) => cluster.capabilities.map((capability) => capability.evidenceId)),
    ...placements.map((placement) => placement.evidenceId),
  ]
  if (referencedEvidence.some((id) => !evidenceIds.has(id))) throw new Error('Observed state contains an unresolved Evidence reference.')

  const ageMs = now().getTime() - observedTime
  if (ageMs < -MAX_FUTURE_SKEW_MS) throw new Error('Observed-state timestamp is too far in the future.')
  const stale = ageMs > staleAfterMs
  const partial = metadata.partial === true
  return {
    observedAt,
    sourceRevision: string(metadata.sourceRevision, '$.metadata.sourceRevision'),
    environment: {
      id: string(environment.id, '$.data.environment.id'),
      displayName: string(environment.displayName, '$.data.environment.displayName'),
    },
    metrics: {
      capabilities: metricSet(metrics.capabilities, '$.data.metrics.capabilities'),
      workloadClaims: metricSet(metrics.workloadClaims, '$.data.metrics.workloadClaims'),
      openFindings: (() => {
        const findings = record(metrics.openFindings, '$.data.metrics.openFindings')
        return { total: count(findings.total, '$.data.metrics.openFindings.total'), critical: count(findings.critical, '$.data.metrics.openFindings.critical') }
      })(),
    },
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
      if (!contentType.toLowerCase().includes('application/json')) throw new Error('OpenKubes observed-state query did not return JSON.')
      const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '0', 10)
      if (declaredLength > MAX_RESPONSE_BYTES) throw new Error('OpenKubes observed-state response exceeds the size limit.')
      const body = await readBoundedBody(response)
      return normalizeOpenKubesObservedState(JSON.parse(body), { now: this.now, staleAfterMs: this.staleAfterMs })
    } finally {
      clearTimeout(timer)
    }
  }
}

export const OPENKUBES_QUERY_VERSION = QUERY_VERSION
