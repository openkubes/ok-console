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
})
