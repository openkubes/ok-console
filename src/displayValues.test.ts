import { expect, it } from 'vitest'
import { displayValues } from './displayValues'
import { evidenceTitle } from './evidenceDisplay'
import { platformFixture } from './data/fixtures'

it('B3 maps only the exact sentinel recursively, including future displayName fields', () => {
  const value = 'Value withheld by the Console redaction boundary.'
  const source = { displayName: value, nested: [{ value }], null: null, count: 1, readiness: 'Ready', prose: `Before ${value}`, empty: '' }
  expect(displayValues(source)).toEqual({ ...source, displayName: 'Withheld', nested: [{ value: 'Withheld' }] })
  expect(source.displayName).toBe(value)
})
it('B3 redacted titles use ids even when long revisions share their first 12 and last 8 characters', () => {
  const item = { ...platformFixture.evidence[0], title: 'Value withheld by the Console redaction boundary.' }
  const first = evidenceTitle({ ...item, id: 'ev-one', revision: 'abcdefghijkl-one-middle-12345678' })
  const second = evidenceTitle({ ...item, id: 'ev-two', revision: 'abcdefghijkl-two-middle-12345678' })
  expect(first).toContain('ev-one'); expect(second).toContain('ev-two'); expect(first).not.toBe(second)
  expect(evidenceTitle({ ...item, cluster: item.title, revision: item.title })).not.toContain('Value withhe')
})
