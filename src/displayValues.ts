const WITHHELD = 'Value withheld by the Console redaction boundary.'

/** Exact producer sentinel only; preserve ordinary prose and all readiness values. */
export function displayValues<T>(value: T): T {
  if (typeof value === 'string') return (value === WITHHELD ? 'Withheld' : value) as T
  if (Array.isArray(value)) return value.map(item => displayValues(item)) as T
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, displayValues(item)]),
  ) as T
  return value
}
