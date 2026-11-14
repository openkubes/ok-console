// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'

it.each(['./README.md', '../README.md', '../.env.example'])('%s has no recipe for replacing a source outage with fixtures', async path => {
  const text = await readFile(new URL(path, import.meta.url), 'utf8')
  expect(text).not.toMatch(/rollback[^\n]{0,40}fixture|fixture[^\n]{0,40}rollback/i)
})
