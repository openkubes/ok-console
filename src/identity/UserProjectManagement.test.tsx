import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import UserProjectManagement from './UserProjectManagement'
import type { AccessInspectionRow } from './accessInspection'
import { readAccessInspectionFixture } from './accessInspectionFixture'

const states = (container: HTMLElement) => [...container.querySelectorAll('[data-access-state]')].map(badge => badge.textContent)
const accessWording = /\b(has|have|can|may)\s+access\b|access\s+(is\s+)?(granted|allowed)|\bgrant(ed)?\s+access\b|\ballowed\s+to\b/i
const evidence = { kind: 'target-cluster', observedAt: '2026-11-19T10:02:11Z', freshness: 'Current' as const, binding: { roleRef: 'fixture-viewer' } }

afterEach(() => vi.restoreAllMocks())

describe('Read-only access inspection', () => {
  it('discloses fixture boundaries and renders subjects, Project references and target identities', () => {
    const { container } = render(<UserProjectManagement/>)
    const banner = screen.getByLabelText('Data boundaries')
    expect(banner).toHaveTextContent('Fixture data · no target-cluster evidence')
    expect(banner).toHaveTextContent('“Verified” means target-cluster evidence was observed')
    for (const row of readAccessInspectionFixture()) {
      const target = within(screen.getByRole('row', { name: new RegExp(`${row.subject.kind}: ${row.subject.displayName}.*${row.target.namespaceUid}`) }))
      expect(target.getByText(`Subject: ${row.subject.subject}`)).toBeInTheDocument()
      expect(target.getByText(`Issuer: ${row.subject.issuer}`)).toBeInTheDocument()
      expect(target.getByText(`tenantId: ${row.project.tenantId}`)).toBeInTheDocument()
      expect(target.getByText(`projectId: ${row.project.projectId}`)).toBeInTheDocument()
      expect(target.getByText(`${row.target.clusterId} / ${row.target.namespace}`)).toBeInTheDocument()
      expect(target.getByText('Source: Fixture')).toBeInTheDocument()
      expect(target.getByText(/^Reachability \(illustrative\): /)).toBeInTheDocument()
      expect(target.getByText('No target-cluster evidence')).toBeInTheDocument()
    }
    expect(states(container)).toEqual(['Proposed', 'Not verified', 'Not verified', 'Not verified'])
    expect(document.body).not.toHaveTextContent(accessWording)
  })

  it('has no forms, inputs, buttons or links, and sends no request or storage write on render or interaction', () => {
    const request = vi.spyOn(globalThis, 'fetch')
    const store = vi.spyOn(Storage.prototype, 'setItem')
    const xhr = vi.spyOn(XMLHttpRequest.prototype, 'open')
    const beacon = vi.fn(); Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true })
    const popup = vi.spyOn(window, 'open').mockImplementation(() => null)
    localStorage.clear(); sessionStorage.clear()
    const cookiesBefore = document.cookie
    const { container } = render(<UserProjectManagement/>)
    for (const role of ['form', 'textbox', 'combobox', 'button', 'link', 'checkbox', 'menuitem']) expect(screen.queryByRole(role)).not.toBeInTheDocument()
    expect(container.querySelector('form, input, select, textarea, a, button, img, iframe, object, embed, link, script, video, audio, source, [onclick], [contenteditable], [style*="url("]')).toBeNull()
    for (const element of container.querySelectorAll('*')) {
      for (const fire of [fireEvent.pointerDown, fireEvent.mouseDown, fireEvent.pointerUp, fireEvent.mouseUp, fireEvent.click, fireEvent.keyDown, fireEvent.focus]) fire(element)
    }
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
    expect(document.cookie).toBe(cookiesBefore)
    expect(beacon).not.toHaveBeenCalled()
    expect(popup).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
    expect(store).not.toHaveBeenCalled()
    expect(xhr).not.toHaveBeenCalled()
  })

  it('renders six distinct state texts, sources and per-target evidence from injected rows', () => {
    const base = readAccessInspectionFixture()[0]
    const rows: AccessInspectionRow[] = [
      { ...base, id: 'proposed' },
      { ...base, id: 'fixture', proposed: false, clusterReachable: true, evidence },
      { ...base, id: 'unknown', source: 'bff', proposed: false, evidence },
      { ...base, id: 'stale', source: 'bff', clusterReachable: true, evidence: { ...evidence, freshness: 'Stale' } },
      { ...base, id: 'unreachable', source: 'bff', clusterReachable: false, evidence: { ...evidence, reasons: [{ code: 'TARGET_UNREACHABLE' }] } },
      { ...base, id: 'verified', source: 'bff', clusterReachable: true, evidence },
    ]
    const { container } = render(<UserProjectManagement rows={rows}/>)
    expect(states(container)).toEqual(['Proposed', 'Not verified', 'Unknown', 'Stale', 'Unreachable', 'Verified'])
    expect(screen.getByLabelText('Data boundaries')).toHaveTextContent('Mixed sources · fixture rows are never verified')
    const fixtureWithEvidence = within(screen.getAllByRole('row')[2])
    expect(fixtureWithEvidence.getByText('Source: Fixture')).toBeInTheDocument()
    const unreachable = within(screen.getAllByRole('row')[5])
    expect(unreachable.getByText('Reason: TARGET_UNREACHABLE')).toBeInTheDocument()
    const verified = within(screen.getAllByRole('row')[6])
    expect(verified.getByText('Source: Console BFF')).toBeInTheDocument()
    for (const text of ['Kind: target-cluster', `Observed at: ${evidence.observedAt}`, 'Freshness: Current', 'Role reference: fixture-viewer']) expect(verified.getByText(text)).toBeInTheDocument()
    expect(verified.queryByText(/^Reason:/)).not.toBeInTheDocument()
    expect(fixtureWithEvidence.getByText('Illustrative evidence (fixture, not observed)')).toBeInTheDocument()
    expect(verified.queryByText(/Illustrative evidence/)).not.toBeInTheDocument()
    expect(document.body).not.toHaveTextContent(accessWording)
  })

  it.each(['BFF', 'mock', '', undefined])('labels a row with unrecognised source %j as fixture in every place', (source) => {
    const base = readAccessInspectionFixture()[0]
    const { container } = render(<UserProjectManagement rows={[{ ...base, source: source as unknown as AccessInspectionRow['source'], proposed: false, clusterReachable: true, evidence }]}/>)
    expect(states(container)).toEqual(['Not verified'])
    expect(screen.getByText('Source: Fixture')).toBeInTheDocument()
    expect(screen.getByText('Reachability (illustrative): Reachable')).toBeInTheDocument()
    expect(screen.getByText('Illustrative evidence (fixture, not observed)')).toBeInTheDocument()
    expect(screen.getByLabelText('Data boundaries')).toHaveTextContent('Fixture data · no target-cluster evidence')
  })

  it('names the boundary from the rows it shows and explains an empty table', () => {
    const base = readAccessInspectionFixture()[0]
    const { unmount } = render(<UserProjectManagement rows={[{ ...base, source: 'bff', proposed: false, clusterReachable: false }]}/>)
    expect(screen.getByLabelText('Data boundaries')).toHaveTextContent('Console BFF data · each target shows its own evidence state')
    expect(screen.getByLabelText('Data boundaries')).not.toHaveTextContent(/Fixture data|observations/)
    unmount()
    render(<UserProjectManagement rows={[]}/>)
    expect(screen.getByLabelText('Data boundaries')).toHaveTextContent('No targets to inspect')
    expect(screen.getByLabelText('Data boundaries')).not.toHaveTextContent('Fixture data')
    expect(screen.getByText('No targets to inspect.')).toBeInTheDocument()
  })
})
