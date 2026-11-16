import { displayValues } from './displayValues'
import type { EvidenceRef } from './domain/contracts'

const WITHHELD_TITLE = 'Value withheld by the Console redaction boundary.'
const WITHHELD_SUMMARY = 'Evidence summary withheld by the Console redaction boundary.'

export function evidenceTitle(item: EvidenceRef) {
  if (item.title !== WITHHELD_TITLE) return item.title
  return `${displayValues(item.cluster)} · ${item.type} evidence · ${item.id}`
}

export function evidenceSummary(item: EvidenceRef) {
  return item.summary === WITHHELD_SUMMARY ? 'Summary not shown for safety.' : item.summary
}
