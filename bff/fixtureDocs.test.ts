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
    return entry.isFile() && (entry.name.endsWith('.md') || (path.startsWith('deploy/') && entry.name.endsWith('.yaml')) || /^\.env.*\.example$/.test(entry.name)) ? [path] : []
  }))
  return nested.flat().sort()
}

// Heuristic prose guard, not a Markdown parser or a production configuration policy.
// Join fenced blocks to their neighbouring paragraphs so split recipes stay visible.
const recipeUnits = (text: string) => {
  const paragraphs = text.split(/\n\s*\n/)
  const units: string[] = []
  for (let index = 0; index < paragraphs.length; index++) {
    let unit = paragraphs[index]
    if (paragraphs[index + 1]?.trimStart().startsWith('```')) {
      unit += '\n\n' + paragraphs[++index]
      if (paragraphs[index + 1]) unit += '\n\n' + paragraphs[++index]
    }
    units.push(unit)
  }
  return units
}
const fixtureRecipes = (text: string) => recipeUnits(text).filter((paragraph, index, units) => {
  const window = units.slice(Math.max(0, index - 1), index + 2).join('\n\n')
  const action = /\b(?:rollback|roll(?:ed|ing)?\s+back|revert(?:s|ed|ing)?|fall(?:ing)?\s+back|fallback|fail(?:ing)?\s+over|switch(?:ing)?\s+(?:back\s+)?to)\b/i
  const recovery = /\b(?:restart\w*|outage|recover\w*|producer is down|until[^.]*\bback)\b/i
  const assignment = /\b(?:OK_CONSOLE_)?OBSERVED_STATE_MODE\s*(?:[=:]\s*['"`]?fixture\b|to\s+['"`]?fixture\b)|name:\s*OK_CONSOLE_OBSERVED_STATE_MODE\b(?:[^\n]*\n){1,4}\s*value:\s*['"]?fixture\b|--set\s+\S*mode=fixture\b/i
  const command = /\bkubectl\s+set\s+env\b|--set\s+/i
  return (action.test(paragraph) && /(?:\b(?:to|back|over)\s+(?:the\s+)?fixture(?:s| source| mode)?\b|\bfixture\s+fallback\b)/i.test(paragraph))
    || (assignment.test(paragraph) && (recovery.test(window) || command.test(paragraph) || /name:\s*OK_CONSOLE_OBSERVED_STATE_MODE/.test(paragraph)))
})

it('repository Markdown, deployment YAML and env examples have no fixture recovery recipes', async () => {
  const paths = await documentationPaths()
  expect(paths).toEqual(expect.arrayContaining(['README.md', 'bff/README.md', '.env.example', 'deploy/kubernetes/overlays/local-kind/kustomization.yaml']))
  const violations = (await Promise.all(paths.map(async path => {
    let text = await readFile(new URL(path, root), 'utf8')
    // This exact host-only initial setting is development setup, not producer recovery.
    // Its neighbour restarts identity bootstrap; retain every other line for recipe scanning.
    if (path === '.env.ok-local.example') text = text.replace(/^OK_CONSOLE_OBSERVED_STATE_MODE=fixture$/m, '')
    // Deployment configuration stays unchanged; this guard covers YAML recipe comments.
    const prose = path.endsWith('.yaml') ? text.split('\n').map(line => /^\s*#/.test(line) ? line.replace(/^\s*# ?/, '') : '').join('\n') : text
    const recipes = fixtureRecipes(prose)
    return recipes.map(paragraph => ({ path, paragraph }))
  }))).flat()
  expect(violations).toEqual([])
})

it.each([
  'If the producer has an outage, run:\n\n```bash\nOK_CONSOLE_OBSERVED_STATE_MODE=fixture pnpm start:bff\n```\n\nThen restart the BFF.',
  'Falling back to fixtures…',
  'fixture fallback',
  'rolled back to fixtures',
  'reverts to fixture mode',
  'Fail over to fixtures',
  'switch to fixture mode',
  'when the producer is down, OK_CONSOLE_OBSERVED_STATE_MODE=fixture',
  'OK_CONSOLE_OBSERVED_STATE_MODE=fixture until the producer is back',
  'set OK_CONSOLE_OBSERVED_STATE_MODE to fixture and restart',
  'name: OK_CONSOLE_OBSERVED_STATE_MODE\nvalue: fixture',
  'kubectl set env deployment/console OK_CONSOLE_OBSERVED_STATE_MODE=fixture',
  'helm upgrade console --set observedState.mode=fixture',
  'Producer outage.\n\nOK_CONSOLE_OBSERVED_STATE_MODE=fixture\n\nRestart the BFF.',
  'roll back to fixture mode',
  'fall back to the fixture source',
  'Reverting to fixtures during a producer outage',
  'Stop the BFF, set `OK_CONSOLE_OBSERVED_STATE_MODE=fixture`, and restart it.',
  'Rollback to\nfixture mode',
  'Switch back to\nfixtures',
  'Recover from an outage by setting\nOBSERVED_STATE_MODE=fixture',
  'OK_CONSOLE_OBSERVED_STATE_MODE="fixture"\nRestart the BFF.',
])('rejects a recovery recipe paragraph: %s', recipe => {
  expect(fixtureRecipes(recipe).length).toBeGreaterThan(0)
})

it.each([
  'Fixture mode is a static local preview.',
  'OK_CONSOLE_OBSERVED_STATE_MODE=fixture',
  'Restart the BFF.\n\nFixture mode is a static local preview.',
  'Revert the source configuration.\n\nFixture mode is a static local preview.',
])('allows ordinary fixture documentation and separate paragraphs: %s', text => {
  expect(fixtureRecipes(text)).toEqual([])
})
