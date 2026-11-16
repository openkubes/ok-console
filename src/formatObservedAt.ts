/** Observation timestamps use UTC on every surface, including historical output. */
export function formatObservedAt(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown time'
  return `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`
}
