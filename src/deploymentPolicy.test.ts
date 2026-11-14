import { describe, expect, it } from 'vitest'
import { DEFAULT_DEPLOYMENT_POLICY, resolveDeploymentPolicyValue } from './deploymentPolicy'

const schema = 'openkubes.console.deployment-policy/v1'

describe('Console view of the deployment policy', () => {
  it('reads the default and the fixture-read-only policy', () => {
    expect(resolveDeploymentPolicyValue({ schema, policy: 'default', clusterLifecycle: true })).toBe(DEFAULT_DEPLOYMENT_POLICY)
    expect(resolveDeploymentPolicyValue({ schema, policy: 'fixture-read-only', clusterLifecycle: false })).toEqual({ policy: 'fixture-read-only', clusterLifecycleAvailable: false })
  })

  it.each([
    ['missing', undefined],
    ['reported problems (dev server)', { errors: ['OK_CONSOLE_DEPLOYMENT_POLICY must be unset or "fixture-read-only"'] }],
    ['an unknown schema', { schema: 'other', policy: 'default', clusterLifecycle: true }],
    ['an unknown policy', { schema, policy: 'fixture-read-write', clusterLifecycle: true }],
    ['a contradictory document', { schema, policy: 'fixture-read-only', clusterLifecycle: true }],
    ['a list', []],
  ])('turns %s into read-only, never into more permissions', (_name, value) => {
    expect(resolveDeploymentPolicyValue(value)).toEqual({ policy: 'unknown', clusterLifecycleAvailable: false })
  })
})
