import type { EvidenceRef } from './domain/contracts'

const WITHHELD_TITLE = 'Value withheld by the Console redaction boundary.'
const WITHHELD_SUMMARY = 'Evidence summary withheld by the Console redaction boundary.'

export function evidenceTitle(item: EvidenceRef) {
  if (item.title !== WITHHELD_TITLE) return item.title
  const revision = item.revision.length > 24 ? `${item.revision.slice(0, 12)}…${item.revision.slice(-8)}` : item.revision
  return `${item.cluster} · ${item.type} evidence · ${revision}`
}

export function evidenceSummary(item: EvidenceRef) {
  return item.summary === WITHHELD_SUMMARY ? 'Summary not shown for safety.' : item.summary
}
