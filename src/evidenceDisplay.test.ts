import { expect, it } from 'vitest'
import { evidenceSummary, evidenceTitle } from './evidenceDisplay'
import { platformFixture } from './data/fixtures'
import { operatorWarnings } from './operatorWarnings'
import { formatObservedAt } from './formatObservedAt'

it('U3 only exact BFF sentinel values are replaced', () => {
  const item = { ...platformFixture.evidence[0] }
  // bff/adapters/openKubesObservedState.mjs:48 and :19.
  const title = 'Value withheld by the Console redaction boundary.'
  const summary = 'Evidence summary withheld by the Console redaction boundary.'
  expect(evidenceTitle({ ...item, title })).toContain(`${item.type} evidence ·`)
  expect(evidenceSummary({ ...item, summary })).toBe('Summary not shown for safety.')
  for (const suffix of [' Follow the recovery guide.', ' ']) {
    expect(evidenceTitle({ ...item, title: title + suffix })).toBe(title + suffix)
    expect(evidenceSummary({ ...item, summary: summary + suffix })).toBe(summary + suffix)
  }
  expect(evidenceTitle({ ...item, title, revision: 'short' })).toContain('short')
  expect(evidenceTitle({ ...item, title, revision: 'prefix-value-and-more-with-suffix' })).toContain('prefix-value…h-suffix')
})
it('U4 translates only the exact BFF REDACTED warning and preserves actionable details', () => {
  // bff/adapters/openKubesObservedState.mjs:534.
  const redacted = 'Observed-state values were withheld by grammar checks or the Console redaction boundary.'
  const actionable = 'Grammar checks failed on cluster edge-07; fix the producer value and retry at the redaction boundary.'
  expect(operatorWarnings([redacted])).toBe('Some observation values could not be safely displayed.')
  expect(operatorWarnings([actionable])).toBe(actionable)
  expect(operatorWarnings([redacted + ' Follow the recovery guide.'])).toBe(redacted + ' Follow the recovery guide.')
  expect(operatorWarnings()).toBeUndefined()
})
it('U8 invalid observation dates are safe and valid timestamps retain UTC', () => {
  expect(() => formatObservedAt('not-a-date')).not.toThrow()
  expect(formatObservedAt('not-a-date')).toBe('Unknown time')
  expect(formatObservedAt('')).toBe('Unknown time')
  expect(formatObservedAt('2026-11-14T12:34:56Z')).toBe('2026-11-14 12:34:56 UTC')
})
