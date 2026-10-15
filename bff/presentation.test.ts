// @vitest-environment node

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { validateConsoleResponse } from '../src/domain/presentationContract'
import { authorizedSnapshot } from './authorizedSnapshot.mjs'
import { overviewProjection } from './presentation.mjs'
import platformOverview from '../contracts/presentation/v0alpha1/examples/platform-overview.json'

const raw = JSON.parse(readFileSync(new URL('./fixtures/observed-state.json', import.meta.url), 'utf8'))
const snapshot = authorizedSnapshot(raw, { environmentId: raw.environment.id, tenantIds: ['platform'] })

describe('overview projection', () => {
  it('omits the management plane when the visible snapshot contains none', () => {
    const workloadOnly = {
      ...snapshot,
      clusters: snapshot.clusters.filter((cluster: { role: string }) => cluster.role !== 'Management plane'),
    }
    const managementIds = snapshot.clusters
      .filter((cluster: { role: string }) => cluster.role === 'Management plane')
      .map((cluster: { id: string }) => cluster.id)
    expect(managementIds.length).toBeGreaterThan(0)

    const data = overviewProjection(workloadOnly)

    expect(data.managementPlane).toBeNull()
    for (const id of managementIds) expect(JSON.stringify(data)).not.toContain(id)
    expect(validateConsoleResponse({
      apiVersion: 'console.openkubes.io/v0alpha1',
      kind: 'PlatformOverview',
      data,
      meta: platformOverview.meta,
    })).toEqual({ valid: true, errors: [] })
  })

  it('still projects the management plane when it is visible', () => {
    expect(overviewProjection(snapshot).managementPlane).toMatchObject({ role: 'Management plane' })
  })
})
