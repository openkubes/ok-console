import { describe, expect, it } from 'vitest'
import sessionContext from '../../contracts/presentation/v0alpha1/examples/session-context.json'
import platformOverview from '../../contracts/presentation/v0alpha1/examples/platform-overview.json'
import clusterList from '../../contracts/presentation/v0alpha1/examples/cluster-list.json'
import clusterDetail from '../../contracts/presentation/v0alpha1/examples/cluster-detail.json'
import evidenceReference from '../../contracts/presentation/v0alpha1/examples/evidence-reference.json'
import sourceUnavailable from '../../contracts/presentation/v0alpha1/examples/error-source-unavailable.json'
import contractIncompatible from '../../contracts/presentation/v0alpha1/examples/error-contract-incompatible.json'
import schema from '../../contracts/presentation/v0alpha1/schema.json'
import {
  PRESENTATION_CONTRACT_VERSION,
  validateConsoleResponse,
} from './presentationContract'

const examples = [
  sessionContext,
  platformOverview,
  clusterList,
  clusterDetail,
  evidenceReference,
  sourceUnavailable,
  contractIncompatible,
]

describe('Presentation Contract v0alpha1', () => {
  it.each(examples.map((example) => [example.kind, example]))(
    'accepts the stable %s example',
    (_kind, example) => {
      expect(validateConsoleResponse(example)).toEqual({ valid: true, errors: [] })
    },
  )

  it('keeps the TypeScript and JSON Schema identifiers aligned', () => {
    const apiVersion = schema.$defs.apiVersion as { const: string }
    expect(apiVersion.const).toBe(PRESENTATION_CONTRACT_VERSION)
    expect(schema.$id).toContain('/console/v0alpha1/')
  })

  it('fails closed for an unknown contract version', () => {
    const response = structuredClone(platformOverview)
    response.apiVersion = 'console.openkubes.io/v9' as typeof response.apiVersion

    const result = validateConsoleResponse(response)
    expect(result.valid).toBe(false)
    expect(result.errors).toContain(`apiVersion must equal ${PRESENTATION_CONTRACT_VERSION}`)
  })

  it('fails closed for an unknown response kind', () => {
    const response = { ...platformOverview, kind: 'KubernetesObjectList' }
    const result = validateConsoleResponse(response)

    expect(result.valid).toBe(false)
    expect(result.errors).toContain('kind is not supported')
  })

  it('tolerates additive optional fields within the same contract version', () => {
    const response = structuredClone(platformOverview) as Record<string, unknown>
    const data = response.data as Record<string, unknown>
    const meta = response.meta as Record<string, unknown>
    data.presentationHint = { density: 'compact' }
    meta.providerExtension = 'ignored-by-v0alpha1-consumers'

    expect(validateConsoleResponse(response)).toEqual({ valid: true, errors: [] })
  })

  it('fails closed for an unknown readiness enum value', () => {
    const response = structuredClone(platformOverview)
    response.data.managementPlane.readiness = 'Degraded' as typeof response.data.managementPlane.readiness

    const result = validateConsoleResponse(response)
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('data.managementPlane.readiness is not supported')
  })

  it.each(['token', 'accessToken', 'kubeconfig', 'privateKey', 'password'])(
    'rejects the forbidden credential field %s anywhere in a response',
    (field) => {
      const response = structuredClone(sessionContext) as Record<string, unknown>
      const data = response.data as Record<string, unknown>
      data[field] = 'must-not-cross-the-boundary'

      const result = validateConsoleResponse(response)
      expect(result.valid).toBe(false)
      expect(result.errors).toContain('response contains a forbidden credential field')
    },
  )

  it('requires safe correlation data on errors', () => {
    const response = structuredClone(sourceUnavailable)
    response.meta.correlationId = ''

    const result = validateConsoleResponse(response)
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('correlationId must be a non-empty string')
  })
})
