/** Only real RFC 3339 instants are labelled UTC. */
export function formatObservedAt(value: string) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/.exec(value)
  if (!parts) return 'Unknown time'
  const [, year, month, day, hour, minute, second, , zone] = parts
  const local = new Date(`${year}-${month}-${day}T00:00:00Z`)
  if (local.getUTCFullYear() !== Number(year) || local.getUTCMonth() + 1 !== Number(month) || local.getUTCDate() !== Number(day)
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59
    || (zone.toUpperCase() !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))) return 'Unknown time'
  const date = new Date(value)
  return `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`
}
