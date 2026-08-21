import { readFile } from 'node:fs/promises'

const defaultFixtureUrl = new URL('../fixtures/observed-state.json', import.meta.url)

export class FixtureObservedStateAdapter {
  constructor(fixtureUrl = defaultFixtureUrl) {
    this.fixtureUrl = fixtureUrl
  }

  async readSnapshot() {
    const contents = await readFile(this.fixtureUrl, 'utf8')
    return JSON.parse(contents)
  }
}
