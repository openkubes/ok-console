import { describe, expect, it } from 'vitest'
import { validateAgentContract } from './agentContract'

const digest = `sha256:${'a'.repeat(64)}`

describe('Agent Contract v1alpha1', () => {
  it('accepts complete definition evidence', () => {
    expect(validateAgentContract({ apiVersion: 'agents.openkubes.io/v1alpha1', kind: 'AgentDefinition', spec: { artifact: { digest, signature: 'sigstore:entry', provenance: 'slsa:entry' } } })).toEqual({ valid: true, errors: [] })
  })

  it('fails closed for review-only catalog data', () => {
    const result = validateAgentContract({ apiVersion: 'agents.openkubes.io/v1alpha1', kind: 'AgentDefinition', spec: { artifact: { digest: 'review required' } } })
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('definition artifact digest must be immutable sha256')
  })

  it('requires deployment evidence and digest correlation', () => {
    expect(validateAgentContract({ apiVersion: 'agents.openkubes.io/v1alpha1', kind: 'AgentDeployment', spec: { agentRef: { digest } }, status: {} }).valid).toBe(false)
    expect(validateAgentContract({ apiVersion: 'agents.openkubes.io/v1alpha1', kind: 'AgentDeployment', spec: { agentRef: { digest } }, status: { evidenceRef: 'ev-agent-1' } })).toEqual({ valid: true, errors: [] })
  })

  it('validates a future, digest-bound deployment claim', () => {
    expect(validateAgentContract({ apiVersion: 'agents.openkubes.io/v1alpha1', kind: 'AgentDeploymentClaim', spec: { agentRef: { digest }, clusterRef: 'ok-shared', tools: ['documents.search'], authority: 'Read only', expiresAt: '2099-01-01T00:00:00Z' } })).toEqual({ valid: true, errors: [] })
  })

  it('rejects expired or incomplete deployment claims', () => {
    const result = validateAgentContract({ apiVersion: 'agents.openkubes.io/v1alpha1', kind: 'AgentDeploymentClaim', spec: { agentRef: { digest }, expiresAt: '2020-01-01T00:00:00Z', tools: [] } })
    expect(result.valid).toBe(false)
    expect(result.errors).toEqual(expect.arrayContaining(['claim clusterRef is required', 'claim tools must be non-empty strings', 'claim authority is required', 'claim expiresAt must be a future date-time']))
  })
})
