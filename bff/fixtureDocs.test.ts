// @vitest-environment node
import { readFile, readdir } from 'node:fs/promises'
import { expect, it } from 'vitest'

const root = new URL('../', import.meta.url)
// Scan a superset of tracked docs without invoking git: include hidden files and
// untracked authoring files too, excluding evidence and generated/dependency trees.
const generated = new Set(['.git', 'node_modules', '.pnpm-store', 'dist', 'test-results', 'playwright-report'])
const documentationPaths = async (directory = ''): Promise<string[]> => {
  const entries = await readdir(new URL(directory, root), { withFileTypes: true })
  const nested = await Promise.all(entries.map(async entry => {
    const path = `${directory}${entry.name}`
    if (entry.isDirectory()) {
      if (generated.has(entry.name) || path === 'docs/evidence') return []
      return documentationPaths(`${path}/`)
    }
    return entry.isFile() && (entry.name.endsWith('.md') || /^\.env.*\.example$/.test(entry.name)) ? [path] : []
  }))
  return nested.flat().sort()
}

const fixtureRecipes = (text: string) => text.split(/\n\s*\n/).filter(paragraph => {
  const action = /\b(?:rollback|roll\s+back|revert(?:ing)?|fall\s+back|switch\s+back)\b/i
  const recovery = /\b(?:restart\w*|outage|recover\w*|rollback|roll\s+back|revert\w*|fall\s+back)\b/i
  const assignment = /\b(?:OK_CONSOLE_)?OBSERVED_STATE_MODE\s*=\s*['"`]?fixture\b/i
  return (action.test(paragraph) && /\bfixtures?\b/i.test(paragraph))
    || (assignment.test(paragraph) && recovery.test(paragraph))
})

it('repository Markdown and env examples have no fixture recovery recipes', async () => {
  const paths = await documentationPaths()
  expect(paths).toEqual(expect.arrayContaining(['README.md', 'bff/README.md', '.env.example']))
  const violations = (await Promise.all(paths.map(async path => {
    const recipes = fixtureRecipes(await readFile(new URL(path, root), 'utf8'))
    return recipes.map(paragraph => ({ path, paragraph }))
  }))).flat()
  expect(violations).toEqual([])
})

it.each([
  'roll back to fixture mode',
  'fall back to the fixture source',
  'Reverting to fixtures during a producer outage',
  'Stop the BFF, set `OK_CONSOLE_OBSERVED_STATE_MODE=fixture`, and restart it.',
  'Rollback to\nfixture mode',
  'Switch back to\nfixtures',
  'Recover from an outage by setting\nOBSERVED_STATE_MODE=fixture',
  'OK_CONSOLE_OBSERVED_STATE_MODE="fixture"\nRestart the BFF.',
])('rejects a recovery recipe paragraph: %s', recipe => {
  expect(fixtureRecipes(recipe)).toEqual([recipe])
})

it.each([
  'Fixture mode is a static local preview.',
  'OK_CONSOLE_OBSERVED_STATE_MODE=fixture',
  'Restart the BFF.\n\nFixture mode is a static local preview.',
  'Revert the source configuration.\n\nFixture mode is a static local preview.',
])('allows ordinary fixture documentation and separate paragraphs: %s', text => {
  expect(fixtureRecipes(text)).toEqual([])
})
