export type AgentContractValidation = { valid: true, errors: [] } | { valid: false, errors: string[] }

const digest = /^sha256:[a-f0-9]{64}$/

export const validateAgentContract = (value: unknown): AgentContractValidation => {
  const errors: string[] = []
  if (!value || typeof value !== 'object') return { valid: false, errors: ['agent contract must be an object'] }
  const candidate = value as Record<string, unknown>
  if (candidate.apiVersion !== 'agents.openkubes.io/v1alpha1') errors.push('apiVersion must be agents.openkubes.io/v1alpha1')
  if (candidate.kind !== 'AgentDefinition' && candidate.kind !== 'AgentDeployment' && candidate.kind !== 'AgentDeploymentClaim') errors.push('kind must be AgentDefinition, AgentDeploymentClaim or AgentDeployment')
  const spec = candidate.spec as Record<string, unknown> | undefined
  if (!spec || typeof spec !== 'object') errors.push('spec is required')
  if (candidate.kind === 'AgentDefinition' && spec) {
    const artifact = spec.artifact as Record<string, unknown> | undefined
    if (!artifact || !digest.test(typeof artifact.digest === 'string' ? artifact.digest : '')) errors.push('definition artifact digest must be immutable sha256')
    if (typeof artifact?.signature !== 'string' || !artifact.signature) errors.push('definition signature is required')
    if (typeof artifact?.provenance !== 'string' || !artifact.provenance) errors.push('definition provenance is required')
  }
  if (candidate.kind === 'AgentDeployment' && spec) {
    const agentRef = spec.agentRef as Record<string, unknown> | undefined
    const status = candidate.status as Record<string, unknown> | undefined
    if (!digest.test(typeof agentRef?.digest === 'string' ? agentRef.digest : '')) errors.push('deployment agent digest must be immutable sha256')
    if (typeof status?.evidenceRef !== 'string' || !status.evidenceRef) errors.push('deployment evidenceRef is required')
  }
  if (candidate.kind === 'AgentDeploymentClaim' && spec) {
    const agentRef = spec.agentRef as Record<string, unknown> | undefined
    if (!digest.test(typeof agentRef?.digest === 'string' ? agentRef.digest : '')) errors.push('claim agent digest must be immutable sha256')
    if (typeof spec.clusterRef !== 'string' || !spec.clusterRef) errors.push('claim clusterRef is required')
    if (!Array.isArray(spec.tools) || spec.tools.length === 0 || spec.tools.some((tool) => typeof tool !== 'string' || !tool)) errors.push('claim tools must be non-empty strings')
    if (typeof spec.authority !== 'string' || !spec.authority) errors.push('claim authority is required')
    const expiresAt = typeof spec.expiresAt === 'string' ? Date.parse(spec.expiresAt) : Number.NaN
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) errors.push('claim expiresAt must be a future date-time')
  }
  return errors.length ? { valid: false, errors } : { valid: true, errors: [] }
}
