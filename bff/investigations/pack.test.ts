// @vitest-environment node

import { copyFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { InvestigationPackError, loadInvestigationPacks, validateInvestigationPack } from './pack.mjs'
import examplePack from './test-fixtures/example-crashloop.json'

// Tests deliberately turn packs into invalid shapes, so a loose record type is used for mutations.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>

const example = fileURLToPath(new URL('./test-fixtures/example-crashloop.json', import.meta.url))
const dirs: string[] = []
const packDir = (setup?: (dir: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), 'ok-packs-'))
  dirs.push(dir)
  copyFileSync(example, join(dir, 'example-crashloop.json'))
  setup?.(dir)
  return dir
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const problemsOf = (mutate: (pack: Loose) => void) => {
  const pack = structuredClone(examplePack) as Loose
  mutate(pack)
  const result = validateInvestigationPack(pack)
  expect(result.ok).toBe(false)
  return result.problems.join('\n')
}

describe('investigation pack structure', () => {
  it('accepts the example pack', () => {
    expect(validateInvestigationPack(structuredClone(examplePack))).toEqual({ ok: true, problems: [] })
  })

  it.each([
    ['a non-synthetic scenario', (pack: Loose) => { pack.scenario.synthetic = false }, /synthetic: must be true/],
    ['a live analysis', (pack: Loose) => { pack.analysis.kind = 'live' }, /analysis.kind: must be "recorded"/],
    ['an execution field on a recommendation', (pack: Loose) => { pack.analysis.recommendations[0].executionStatus = 'executed' }, /executionStatus: unknown field/],
    ['a command on a recommendation', (pack: Loose) => { pack.analysis.recommendations[0].command = 'kubectl delete pod x' }, /command: unknown field/],
    ['an unknown action class', (pack: Loose) => { pack.analysis.recommendations[0].actionClass = 'auto_remediation' }, /actionClass/],
    ['a recommendation for an unknown hypothesis', (pack: Loose) => { pack.analysis.recommendations[0].basedOn = ['h9'] }, /unknown hypothesis "h9"/],
    ['a credential-like key in evidence', (pack: Loose) => { pack.evidence[2].data.kubeconfig = 'apiVersion: v1' }, /credential-like fields/],
    ['a non-k8s evidence URI', (pack: Loose) => { pack.evidence[0].uri = 'https://cluster.example/api' }, /uri: must be a k8s:\/\/ URI/],
    ['a malformed digest', (pack: Loose) => { pack.evidence[0].digest = 'md5:abc' }, /digest/],
    ['duplicate evidence ids', (pack: Loose) => { pack.evidence[1].id = 'ev-status' }, /duplicate id "ev-status"/],
    ['unknown top-level fields', (pack: Loose) => { pack.liveCluster = { kubeContext: 'prod' } }, /liveCluster: unknown field/],
    ['a wrong schema id', (pack: Loose) => { pack.schema = 'other/v1' }, /pack.schema/],
  ])('rejects %s', (_name, mutate, message) => {
    expect(problemsOf(mutate)).toMatch(message)
  })
})

describe('investigation pack directory (startup, fail closed)', () => {
  it('is a no-op when not configured', async () => {
    expect(await loadInvestigationPacks(undefined)).toBeNull()
    expect(await loadInvestigationPacks('')).toBeNull()
  })

  it('loads packs by scenario id with a content digest', async () => {
    const packs = await loadInvestigationPacks(packDir())
    expect([...packs!.keys()]).toEqual(['example-crashloop'])
    expect(packs!.get('example-crashloop')!.packDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it.each([
    ['a relative path', () => 'packs', /absolute path/],
    ['a missing directory', () => '/nonexistent/ok-packs', /directory not found/],
    ['an empty directory', () => { const dir = mkdtempSync(join(tmpdir(), 'ok-packs-')); dirs.push(dir); return dir }, /no \*\.json pack found/],
    ['invalid JSON', () => packDir((dir) => writeFileSync(join(dir, 'broken.json'), '{"scenario": ')), /broken.json: not valid JSON/],
    ['a structurally invalid pack', () => packDir((dir) => writeFileSync(join(dir, 'other.json'), JSON.stringify({ ...examplePack, scenario: { ...examplePack.scenario, id: 'other', synthetic: false } }))), /other.json: scenario.synthetic/],
    ['a duplicate scenario id', () => packDir((dir) => copyFileSync(example, join(dir, 'copy.json'))), /duplicate scenario id "example-crashloop"/],
    ['a file resolving outside the directory', () => { const outside = packDir(); return packDir((dir) => symlinkSync(join(outside, 'example-crashloop.json'), join(dir, 'linked.json'))) }, /linked.json: resolves outside/],
    ['an oversized file', () => packDir((dir) => writeFileSync(join(dir, 'huge.json'), `{"x":"${'a'.repeat(600 * 1024)}"}`)), /huge.json: must be a regular file/],
  ])('rejects %s', async (_name, dir, message) => {
    const error = await loadInvestigationPacks(dir()).catch((caught) => caught)
    expect(error).toBeInstanceOf(InvestigationPackError)
    expect(error.message).toMatch(message)
  })
})
