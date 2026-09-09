export const PRESENTATION_CONTRACT_VERSION = 'console.openkubes.io/v0alpha1' as const

export const PRESENTATION_KINDS = [
  'SessionContext',
  'PlatformOverview',
  'ClusterList',
  'ClusterDetail',
  'EvidenceReference',
] as const

export const CONSOLE_ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'SOURCE_UNAVAILABLE',
  'SOURCE_STALE',
  'CONTRACT_INCOMPATIBLE',
  'INTERNAL_ERROR',
] as const

export type PresentationKind = (typeof PRESENTATION_KINDS)[number]
export type ConsoleErrorCode = (typeof CONSOLE_ERROR_CODES)[number]
export type Readiness = 'Ready' | 'Pending' | 'Failed' | 'Unknown'
export type Compatibility = 'Supported' | 'Read only' | 'Incompatible'
export type Freshness = 'Current' | 'Stale' | 'Unknown'

export interface ContractWarning {
  code: 'PARTIAL_DATA' | 'SOURCE_STALE' | 'REDACTED'
  message: string
}

export interface ResponseMeta {
  contractVersion: typeof PRESENTATION_CONTRACT_VERSION
  correlationId: string
  observedAt: string
  freshness: Freshness
  sourceRevision?: string
  warnings?: ContractWarning[]
}

export interface PresentationResponse<K extends PresentationKind, T> {
  apiVersion: typeof PRESENTATION_CONTRACT_VERSION
  kind: K
  data: T
  meta: ResponseMeta
}

export interface ErrorMeta {
  contractVersion: typeof PRESENTATION_CONTRACT_VERSION
  correlationId: string
}

export interface ConsoleErrorResponse {
  apiVersion: typeof PRESENTATION_CONTRACT_VERSION
  kind: 'Error'
  error: {
    code: ConsoleErrorCode
    message: string
    retryable: boolean
    retryAfterSeconds?: number
    details?: Array<{ field?: string; reason: string }>
  }
  meta: ErrorMeta
}

export interface SessionContextData {
  subject: {
    id: string
    displayName: string
    identitySource: 'Local' | 'OIDC'
    assurance: 'Prototype' | 'Federated' | 'Break glass'
  }
  environment: {
    id: string
    displayName: string
  }
  permissions: string[]
  expiresAt: string
}

export interface StatusCount {
  total: number
  ready: number
  pending: number
  failed: number
  unknown: number
}

export interface ClusterSummaryData {
  id: string
  name: string
  role: 'Management plane' | 'Workload cluster'
  provider: string
  profile: string
  kubernetesVersion: string
  region: string
  readiness: Readiness
  compatibility: Compatibility
  contractVersion: string
  revision: string
  evidenceId: string
  capabilityCount: number
}

export interface PlatformOverviewData {
  clusters: StatusCount
  capabilities: StatusCount
  workloadClaims: StatusCount
  openFindings: {
    total: number
    critical: number
  }
  managementPlane: ClusterSummaryData
  recentPlacements: Array<{
    id: string
    name: string
    targetCluster: string
    readiness: Readiness
    evidenceId: string
  }>
}

export interface ClusterDetailData extends ClusterSummaryData {
  capabilities: Array<{
    id: string
    name: string
    readiness: Readiness
    evidenceId: string
  }>
  lifecycle: Array<{
    label: string
    state: Readiness
    detail: string
  }>
}

export interface EvidenceReferenceData {
  id: string
  title: string
  type: 'Observation' | 'Transition' | 'Authorization'
  outcome: Readiness | 'Approved' | 'Denied'
  clusterId: string
  contract: string
  revision: string
  observedAt: string
  source: string
  summary: string
  classification: 'Immutable' | 'Current'
  redacted: boolean
  drillDownRef?: string
}

export type SessionContextResponse = PresentationResponse<'SessionContext', SessionContextData>
export type PlatformOverviewResponse = PresentationResponse<'PlatformOverview', PlatformOverviewData>
export type ClusterListResponse = PresentationResponse<'ClusterList', { items: ClusterSummaryData[] }>
export type ClusterDetailResponse = PresentationResponse<'ClusterDetail', ClusterDetailData>
export type EvidenceReferenceResponse = PresentationResponse<'EvidenceReference', EvidenceReferenceData>

export type ConsoleSuccessResponse =
  | SessionContextResponse
  | PlatformOverviewResponse
  | ClusterListResponse
  | ClusterDetailResponse
  | EvidenceReferenceResponse

export type ConsoleResponse = ConsoleSuccessResponse | ConsoleErrorResponse

export interface ContractValidationResult {
  valid: boolean
  errors: string[]
}

type UnknownRecord = Record<string, unknown>

const forbiddenKeys = new Set([
  'access_token',
  'accesstoken',
  'bearer_token',
  'bearertoken',
  'client_secret',
  'clientsecret',
  'kubeconfig',
  'password',
  'private_key',
  'privatekey',
  'refresh_token',
  'refreshtoken',
  'secret',
  'token',
])

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

const isTimestamp = (value: unknown): value is string =>
  isNonEmptyString(value) && !Number.isNaN(Date.parse(value))

const hasOnlyStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isNonEmptyString)

const hasForbiddenField = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(hasForbiddenField)
  if (!isRecord(value)) return false

  return Object.entries(value).some(([key, nested]) => {
    const normalized = key.toLowerCase().replaceAll('-', '_')
    return forbiddenKeys.has(normalized) || hasForbiddenField(nested)
  })
}

const requireString = (record: UnknownRecord, field: string, errors: string[]) => {
  if (!isNonEmptyString(record[field])) errors.push(`${field} must be a non-empty string`)
}

const requireTimestamp = (record: UnknownRecord, field: string, errors: string[]) => {
  if (!isTimestamp(record[field])) errors.push(`${field} must be an ISO-8601 timestamp`)
}

const validateMeta = (value: unknown, errors: string[]) => {
  if (!isRecord(value)) {
    errors.push('meta must be an object')
    return
  }

  if (value.contractVersion !== PRESENTATION_CONTRACT_VERSION) {
    errors.push(`meta.contractVersion must equal ${PRESENTATION_CONTRACT_VERSION}`)
  }
  requireString(value, 'correlationId', errors)
  requireTimestamp(value, 'observedAt', errors)
  if (!['Current', 'Stale', 'Unknown'].includes(String(value.freshness))) {
    errors.push('freshness must be Current, Stale, or Unknown')
  }
}

const validateClusterSummary = (value: unknown, errors: string[], path = 'data') => {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`)
    return
  }

  for (const field of ['id', 'name', 'provider', 'profile', 'kubernetesVersion', 'region', 'contractVersion', 'revision', 'evidenceId']) {
    if (!isNonEmptyString(value[field])) errors.push(`${path}.${field} must be a non-empty string`)
  }
  if (!['Management plane', 'Workload cluster'].includes(String(value.role))) {
    errors.push(`${path}.role is not supported`)
  }
  if (!['Ready', 'Pending', 'Failed', 'Unknown'].includes(String(value.readiness))) {
    errors.push(`${path}.readiness is not supported`)
  }
  if (!['Supported', 'Read only', 'Incompatible'].includes(String(value.compatibility))) {
    errors.push(`${path}.compatibility is not supported`)
  }
  if (!Number.isInteger(value.capabilityCount) || Number(value.capabilityCount) < 0) {
    errors.push(`${path}.capabilityCount must be a non-negative integer`)
  }
}

const validateStatusCount = (value: unknown, errors: string[], path: string) => {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`)
    return
  }
  for (const field of ['total', 'ready', 'pending', 'failed', 'unknown']) {
    if (!Number.isInteger(value[field]) || Number(value[field]) < 0) {
      errors.push(`${path}.${field} must be a non-negative integer`)
    }
  }
}

const validateData = (kind: PresentationKind, value: unknown, errors: string[]) => {
  if (!isRecord(value)) {
    errors.push('data must be an object')
    return
  }

  switch (kind) {
    case 'SessionContext': {
      if (!isRecord(value.subject)) {
        errors.push('data.subject must be an object')
      } else {
        requireString(value.subject, 'id', errors)
        requireString(value.subject, 'displayName', errors)
        if (!['Local', 'OIDC'].includes(String(value.subject.identitySource))) {
          errors.push('data.subject.identitySource is not supported')
        }
        if (!['Prototype', 'Federated', 'Break glass'].includes(String(value.subject.assurance))) {
          errors.push('data.subject.assurance is not supported')
        }
      }
      if (!isRecord(value.environment)) {
        errors.push('data.environment must be an object')
      } else {
        requireString(value.environment, 'id', errors)
        requireString(value.environment, 'displayName', errors)
      }
      if (!hasOnlyStrings(value.permissions)) errors.push('data.permissions must be a string array')
      requireTimestamp(value, 'expiresAt', errors)
      break
    }
    case 'PlatformOverview': {
      validateStatusCount(value.clusters, errors, 'data.clusters')
      validateStatusCount(value.capabilities, errors, 'data.capabilities')
      validateStatusCount(value.workloadClaims, errors, 'data.workloadClaims')
      if (!isRecord(value.openFindings)) {
        errors.push('data.openFindings must be an object')
      } else if (!Number.isInteger(value.openFindings.total) || !Number.isInteger(value.openFindings.critical)) {
        errors.push('data.openFindings values must be integers')
      }
      validateClusterSummary(value.managementPlane, errors, 'data.managementPlane')
      if (!Array.isArray(value.recentPlacements)) {
        errors.push('data.recentPlacements must be an array')
      } else {
        value.recentPlacements.forEach((placement, index) => {
          if (!isRecord(placement)) {
            errors.push(`data.recentPlacements[${index}] must be an object`)
            return
          }
          for (const field of ['id', 'name', 'targetCluster', 'evidenceId']) {
            if (!isNonEmptyString(placement[field])) {
              errors.push(`data.recentPlacements[${index}].${field} must be a non-empty string`)
            }
          }
        })
      }
      break
    }
    case 'ClusterList': {
      if (!Array.isArray(value.items)) {
        errors.push('data.items must be an array')
      } else {
        value.items.forEach((item, index) => validateClusterSummary(item, errors, `data.items[${index}]`))
      }
      break
    }
    case 'ClusterDetail': {
      validateClusterSummary(value, errors)
      if (!Array.isArray(value.capabilities)) {
        errors.push('data.capabilities must be an array')
      } else {
        value.capabilities.forEach((capability, index) => {
          if (!isRecord(capability)) {
            errors.push(`data.capabilities[${index}] must be an object`)
            return
          }
          for (const field of ['id', 'name', 'evidenceId']) {
            if (!isNonEmptyString(capability[field])) {
              errors.push(`data.capabilities[${index}].${field} must be a non-empty string`)
            }
          }
        })
      }
      if (!Array.isArray(value.lifecycle)) {
        errors.push('data.lifecycle must be an array')
      } else {
        value.lifecycle.forEach((stage, index) => {
          if (!isRecord(stage)) {
            errors.push(`data.lifecycle[${index}] must be an object`)
            return
          }
          for (const field of ['label', 'detail']) {
            if (!isNonEmptyString(stage[field])) {
              errors.push(`data.lifecycle[${index}].${field} must be a non-empty string`)
            }
          }
        })
      }
      break
    }
    case 'EvidenceReference': {
      for (const field of ['id', 'title', 'type', 'outcome', 'clusterId', 'contract', 'revision', 'source', 'summary']) {
        requireString(value, field, errors)
      }
      requireTimestamp(value, 'observedAt', errors)
      if (!['Observation', 'Transition', 'Authorization'].includes(String(value.type))) {
        errors.push('data.type must be Observation, Transition, or Authorization')
      }
      if (!['Ready', 'Pending', 'Failed', 'Unknown', 'Approved', 'Denied'].includes(String(value.outcome))) {
        errors.push('data.outcome is not supported')
      }
      if (!['Immutable', 'Current'].includes(String(value.classification))) {
        errors.push('data.classification must be Immutable or Current')
      }
      if (typeof value.redacted !== 'boolean') errors.push('data.redacted must be a boolean')
      break
    }
  }
}

const validateError = (value: unknown, errors: string[]) => {
  if (!isRecord(value)) {
    errors.push('error must be an object')
    return
  }
  if (!CONSOLE_ERROR_CODES.includes(value.code as ConsoleErrorCode)) errors.push('error.code is not supported')
  requireString(value, 'message', errors)
  if (typeof value.retryable !== 'boolean') errors.push('error.retryable must be a boolean')
}

export const validateConsoleResponse = (value: unknown): ContractValidationResult => {
  const errors: string[] = []
  if (!isRecord(value)) return { valid: false, errors: ['response must be an object'] }

  if (value.apiVersion !== PRESENTATION_CONTRACT_VERSION) {
    errors.push(`apiVersion must equal ${PRESENTATION_CONTRACT_VERSION}`)
  }

  if (hasForbiddenField(value)) errors.push('response contains a forbidden credential field')

  if (value.kind === 'Error') {
    validateError(value.error, errors)
    if (!isRecord(value.meta)) {
      errors.push('meta must be an object')
    } else {
      if (value.meta.contractVersion !== PRESENTATION_CONTRACT_VERSION) {
        errors.push(`meta.contractVersion must equal ${PRESENTATION_CONTRACT_VERSION}`)
      }
      requireString(value.meta, 'correlationId', errors)
    }
    return { valid: errors.length === 0, errors }
  }

  if (!PRESENTATION_KINDS.includes(value.kind as PresentationKind)) {
    errors.push('kind is not supported')
    return { valid: false, errors }
  }

  validateMeta(value.meta, errors)
  validateData(value.kind as PresentationKind, value.data, errors)
  return { valid: errors.length === 0, errors }
}
