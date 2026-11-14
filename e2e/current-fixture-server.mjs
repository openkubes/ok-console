// Test-only clock and recording seam; production entry points use the real clock.
import process from 'node:process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createConsoleServer } from '../bff/server.mjs'
import { createObservedStateSource } from '../bff/source.mjs'

const fixture = JSON.parse(await readFile(new URL('../bff/fixtures/observed-state.json', import.meta.url), 'utf8'))
// The recording deliberately includes stale edge Evidence and an immutable
// management receipt. Make this test world wholly current before injection.
for (const evidence of fixture.evidence) {
  evidence.observedAt = fixture.observedAt
  evidence.outcome = 'Ready'
  evidence.classification = 'Current'
}
for (const cluster of fixture.clusters) {
  cluster.readiness = 'Ready'
  for (const capability of cluster.capabilities) capability.readiness = 'Ready'
  for (const stage of cluster.lifecycle ?? []) stage.state = 'Ready'
}
for (const placement of fixture.placements) placement.readiness = 'Ready'
const directory = await mkdtemp(join(tmpdir(), 'ok-console-current-fixture-'))
try {
  const fixturePath = join(directory, 'observed-state.json')
  await writeFile(fixturePath, JSON.stringify(fixture), { flag: 'wx' })
  const { server, sessionRuntime, host, port } = await createConsoleServer({
    env: {
      OK_CONSOLE_DEV_PROTOTYPE_ENABLED: 'true',
      OK_CONSOLE_BFF_ENABLE_FAILURE_INJECTION: 'true',
      OK_CONSOLE_BFF_HOST: '127.0.0.1',
      OK_CONSOLE_BFF_PORT: '8789',
    },
    sourceFactory: env => createObservedStateSource(env, {
      fixtureUrl: pathToFileURL(fixturePath), now: () => new Date(fixture.observedAt),
    }),
  })
  server.listen(port, host)
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      server.closeAllConnections()
      server.close(() => {
        void sessionRuntime.close().finally(() => rm(directory, { recursive: true, force: true }))
      })
    })
  }
} catch (error) {
  await rm(directory, { recursive: true, force: true })
  throw error
}
