import { readFile } from 'node:fs/promises'
import {
  normalizeOpenKubesObservedState,
  ObservedStateContractError,
  OPENKUBES_QUERY_VERSION,
} from './openKubesObservedState.mjs'

const defaultFixtureUrl = new URL('../fixtures/observed-state.json', import.meta.url)

export class FixtureObservedStateAdapter {
  constructor(fixtureUrl = defaultFixtureUrl) {
    this.fixtureUrl = fixtureUrl
  }

  async readSnapshot() {
    const contents = await readFile(this.fixtureUrl, 'utf8')
    try {
      const fixture = JSON.parse(contents)
      return normalizeOpenKubesObservedState({
        apiVersion: OPENKUBES_QUERY_VERSION,
        kind: 'ConsoleObservedState',
        metadata: {
          observedAt: fixture.observedAt,
          sourceRevision: fixture.sourceRevision,
        },
        data: {
          environment: fixture.environment,
          metrics: fixture.metrics,
          clusters: fixture.clusters,
          placements: fixture.placements,
          evidence: fixture.evidence,
        },
      }, { now: () => new Date(fixture.observedAt) })
    } catch (error) {
      if (error instanceof ObservedStateContractError) throw error
      throw new ObservedStateContractError('Observed-state fixture failed structural or semantic contract validation.')
    }
  }
}
