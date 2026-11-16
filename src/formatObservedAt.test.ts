import { expect, it } from 'vitest'
import { formatObservedAt } from './formatObservedAt'

it.each(['0', 'garbage 2026', '2026-01-01T10:00:00Z\n', ' 2026-01-01T10:00:00Z', '2026-01-01T10:00:00Z ', '2026-02-30T10:00:00Z', '2026-02-29T10:00:00Z', '2026-04-31T10:00:00Z', '2026-13-01T10:00:00Z', '2026-00-01T10:00:00Z', '2026-01-00T10:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T00:60:00Z', '2026-01-01T00:00:60Z', '2026-01-01T00:00:00+24:00', '2026-01-01T00:00:00+01:60', '2026-01-01', '2026-01-01T10:00:00', '', 'invalid'])('rejects non-instant %s', value => {
  expect(formatObservedAt(value)).toBe('Unknown time')
})
it.each([
  ['2026-01-01T10:00:00Z', '2026-01-01 10:00:00 UTC'],
  ['2026-01-01T00:30:00.123+01:00', '2025-12-31 23:30:00 UTC'],
  ['2024-02-29T23:30:00-02:00', '2024-03-01 01:30:00 UTC'],
  ['2026-01-01t10:00:00z', '2026-01-01 10:00:00 UTC'],
])('formats real RFC 3339 instant %s', (value, expected) => expect(formatObservedAt(value)).toBe(expected))
