import inspectionSource from './accessInspection.ts?raw'
import fixtureSource from './accessInspectionFixture.ts?raw'
import componentSource from './UserProjectManagement.tsx?raw'
import appSource from '../App.tsx?raw'
import { describe, expect, it } from 'vitest'
import { accessTargetState, type AccessEvidenceSummary, type AccessTargetInput } from './accessInspection'
import { readAccessInspectionFixture } from './accessInspectionFixture'

const current: AccessTargetInput = { source: 'bff', clusterReachable: true, evidence: { kind: 'target-cluster', freshness: 'Current', binding: { roleRef: 'fixture-viewer' } } }

describe('accessTargetState (first match wins)', () => {
  it('a: proposed without evidence wins over fixture and unreachable', () => {
    expect(accessTargetState({ source: 'fixture', proposed: true, clusterReachable: false })).toBe('Proposed')
    expect(accessTargetState({ ...current, proposed: true })).toBe('Verified')
  })
  it('b: fixture Current target evidence is Not verified, regardless of reachability', () => {
    for (const clusterReachable of [true, false, undefined]) {
      expect(accessTargetState({ ...current, source: 'fixture', clusterReachable })).toBe('Not verified')
    }
  })
  it.each(['BFF', 'mock', '', undefined, null])('b: only the exact bff source can verify (source %j)', (source) => {
    expect(accessTargetState({ ...current, source: source as unknown as AccessTargetInput['source'] })).toBe('Not verified')
  })
  it('c: bff unreachable with Current evidence is Unreachable', () => {
    expect(accessTargetState({ ...current, clusterReachable: false })).toBe('Unreachable')
    expect(accessTargetState({ source: 'bff', clusterReachable: false })).toBe('Unreachable')
  })
  it('d: unknown reachability wins over Current evidence and absent evidence', () => {
    expect(accessTargetState({ ...current, clusterReachable: undefined })).toBe('Unknown')
    expect(accessTargetState({ source: 'bff' })).toBe('Unknown')
  })
  it('e: bff reachable without evidence is Not verified', () => {
    expect(accessTargetState({ source: 'bff', clusterReachable: true })).toBe('Not verified')
  })
  it('e kind: non-target-cluster Current evidence is Not verified', () => {
    for (const kind of ['intent', '', 'Target-Cluster']) {
      expect(accessTargetState({ ...current, evidence: { ...current.evidence!, kind } })).toBe('Not verified')
    }
  })
  it('f: bff Current reachable target evidence with a binding and no reason is Verified', () => {
    expect(accessTargetState(current)).toBe('Verified')
    expect(accessTargetState({ ...current, evidence: { ...current.evidence!, reasons: [] } })).toBe('Verified')
  })
  it('f binding: Current evidence without an observed binding is Not verified', () => {
    expect(accessTargetState({ ...current, evidence: { kind: 'target-cluster', freshness: 'Current' } })).toBe('Not verified')
    expect(accessTargetState({ ...current, evidence: { ...current.evidence!, binding: { roleRef: '' } } })).toBe('Not verified')
  })
  it.each(['TARGET_UNREACHABLE', 'OBSERVATION_STALE', 'NAMESPACE_UID_MISMATCH', 'PRESET_DRIFTED'])('f reasons: Current evidence with reason %s is Not verified', (code) => {
    expect(accessTargetState({ ...current, evidence: { ...current.evidence!, reasons: [{ code }] } })).toBe('Not verified')
  })
  it('f: bff Stale target evidence is Stale', () => {
    expect(accessTargetState({ ...current, evidence: { ...current.evidence!, freshness: 'Stale' } })).toBe('Stale')
  })
  it.each(['Unknown', undefined, 'current'] as const)('f: bff freshness %s is Unknown', (freshness) => {
    expect(accessTargetState({ ...current, evidence: { ...current.evidence!, freshness: freshness as AccessEvidenceSummary['freshness'] } })).toBe('Unknown')
  })
  it('ships only fixture rows without target evidence across two clusters and three namespaces', () => {
    const rows = readAccessInspectionFixture()
    expect(new Set(rows.map(row => row.subject.kind))).toEqual(new Set(['User', 'Group']))
    expect(new Set(rows.map(row => row.target.clusterId)).size).toBe(2)
    expect(new Set(rows.map(row => `${row.target.clusterId}/${row.target.namespace}`)).size).toBe(3)
    expect(new Set(rows.map(row => JSON.stringify(row.project))).size).toBe(1)
    for (const row of rows) {
      expect(row.source).toBe('fixture')
      expect(row.evidence).toBeUndefined()
      expect(accessTargetState(row)).not.toBe('Verified')
      expect(row).not.toHaveProperty('state')
    }
  })
  it('imports only allowed modules and has no network, storage or Kubernetes write path', () => {
    const allowed = new Set(['./accessInspection', './accessInspectionFixture', './identity.css', '../observationPresentation', '../domain/presentationContract'])
    for (const [file, source] of [['accessInspection.ts', inspectionSource], ['accessInspectionFixture.ts', fixtureSource], ['UserProjectManagement.tsx', componentSource]]) {
      const imports = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g)].map(match => match[1])
      for (const target of imports) expect(allowed, `${file} imports ${target}`).toContain(target)
      expect(source, file).not.toMatch(/\bfetch\b|XMLHttpRequest|sendBeacon|WebSocket|EventSource|localStorage|sessionStorage|indexedDB|cookie|rolebinding|subjectaccessreview|\[\s*['"`]|\bon[A-Z]\w*\s*=|<(img|iframe|object|embed|link|script|a)\b|window\.open|url\(/)
    }
  })
  it('keeps the page out of production builds (DEV-only lazy import in App.tsx)', () => {
    const references = appSource.split('\n').filter(line => /identity\/(UserProjectManagement|accessInspection)/.test(line))
    expect(references).toEqual(["const UserProjectManagement = import.meta.env.DEV ? lazy(() => import('./identity/UserProjectManagement')) : null"])
  })
})
