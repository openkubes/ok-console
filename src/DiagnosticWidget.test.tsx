import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import DiagnosticWidget from './DiagnosticWidget'
import { platformFixture } from './data/fixtures'

it.each(['Current', 'Stale', 'Unknown'] as const)('diagnostic uses independent %s Evidence under a fresh response', freshness => {
  const data = structuredClone(platformFixture)
  const cluster = data.clusters.find(item => item.name === 'ok-shared')!
  const evidence = data.evidence.find(item => item.id === cluster.evidenceId)!
  Object.assign(data, { source: 'bff', freshness: 'Current', clusterListFreshness: 'Current', clusters: [cluster], evidence: [evidence], claims: [] })
  Object.assign(cluster, { freshness: 'Current', readiness: 'Ready' })
  Object.assign(evidence, { freshness, immutable: false, outcome: 'Ready' })
  render(<DiagnosticWidget data={data} openEvidence={() => {}}/>)
  fireEvent.click(screen.getByRole('button', { name: /Ask OK AI/ }))
  fireEvent.click(screen.getByRole('button', { name: 'ok-shared status' }))
  const answer = screen.getByText(/Evidence:/)
  expect(answer).toHaveTextContent(freshness === 'Current' ? `(${evidence.outcome}` : `last observed outcome: ${evidence.outcome}`)
  fireEvent.click(screen.getByRole('button', { name: 'Platform status' }))
  if (freshness === 'Current') expect(screen.getByText(/Observation freshness is current/)).toBeVisible()
  else expect(document.querySelector('.diagnostic-widget')).not.toHaveTextContent(/\bcurrent(ly)?\b/i)
})

it('R2 S3 platform answer includes every warning, including SOURCE_STALE after a partial warning', () => {
  const data = { ...structuredClone(platformFixture), warnings: ['Some optional source data is unavailable.', 'A producer item is older than the freshness window.'] }
  render(<DiagnosticWidget data={data} openEvidence={() => {}}/>)
  fireEvent.click(screen.getByRole('button', { name: /Ask OK AI/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Platform status' }))
  const answer = screen.getByText(/The Console displays/)
  for (const warning of data.warnings) expect(answer).toHaveTextContent(warning)
})
