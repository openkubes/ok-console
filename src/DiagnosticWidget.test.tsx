import { fireEvent, render, screen, cleanup } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import DiagnosticWidget from './DiagnosticWidget'
import { platformFixture } from './data/fixtures'

afterEach(cleanup)

it.each(['Current', 'Stale'] as const)('H5 diagnostic uses %s Evidence freshness under a fresh envelope', freshness => {
  const data = structuredClone(platformFixture)
  data.freshness = 'Current'
  const cluster = data.clusters.find(item => item.name === 'ok-shared')!
  const evidence = data.evidence.find(item => item.id === cluster.evidenceId)!
  evidence.freshness = freshness
  render(<DiagnosticWidget data={data} openEvidence={() => {}}/>)
  fireEvent.click(screen.getByRole('button', { name: /Ask OK AI/ }))
  fireEvent.click(screen.getByRole('button', { name: 'ok-shared status' }))
  const expected = freshness === 'Stale' ? `Last observed: ${evidence.outcome}` : evidence.outcome
  expect(screen.getByText(new RegExp(`Evidence: ${evidence.title} \\(${expected}\\)`))).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Platform status' }))
  expect(screen.getByText(new RegExp(`Observation freshness is ${freshness.toLowerCase()}`))).toBeInTheDocument()
  if (freshness === 'Stale') expect(screen.queryByText(/Observation freshness is current/)).not.toBeInTheDocument()
})
