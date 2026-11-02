import { describe, expect, it } from 'vitest'
import { observationPresentation } from './observationPresentation'

describe('observationPresentation', () => {
  it.each([undefined, 'Unknown', 'Stale'] as const)('cannot upgrade %s from the response', freshness => {
    expect(observationPresentation({ freshness, state: 'Ready' }).current).toBe(false)
  })
  it('requires effective state and item evidence', () => {
    expect(observationPresentation({ freshness: 'Current', state: 'Unknown' }).current).toBe(false)
    expect(observationPresentation({ freshness: 'Current', state: 'Ready', hasEvidence: false }).current).toBe(false)
    expect(observationPresentation({ freshness: 'Current' }).current).toBe(false)
    expect(observationPresentation({ freshness: 'Current', state: 'Ready' }).current).toBe(true)
  })
  it('keeps immutable receipts historical', () => {
    expect(observationPresentation({ freshness: 'Current', state: 'Ready', immutable: true })).toMatchObject({ current: false, label: 'Immutable receipt' })
  })
})
