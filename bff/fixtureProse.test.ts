// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { platformFixture } from '../src/data/fixtures'

const presentStatus = /\b(?:is|are) (?:currently |still )?(?:conformant|satisfied|healthy|ready|converging)\b|\bis outside\b|\bcurrently\b|\bconform\b|\bhas not entered\b|\bno failure is inferred\b/i
function violations(value: unknown, path = '$'): string[] {
  if (typeof value === 'string') return presentStatus.test(value) ? [`${path}: ${value}`] : []
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, child]) => violations(child, `${path}.${key}`))
  return []
}
it('every string in both fixture recordings avoids present-tense status prose', async () => {
  const recording = JSON.parse(await readFile(new URL('./fixtures/observed-state.json', import.meta.url), 'utf8'))
  expect(violations(recording)).toEqual([])
  expect(violations(platformFixture)).toEqual([])
})
