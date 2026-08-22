// @vitest-environment node

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FixtureObservedStateAdapter } from './adapters/fixtureObservedState.mjs'
import { createObservedStateSource } from './source.mjs'

const root = mkdtempSync(join(tmpdir(), 'ok-console-mtls-'))
let server: Server
let port: number

const openssl = (...arguments_: string[]) => execFileSync('openssl', arguments_, { stdio: 'ignore' })

const issue = (name: string, ca: string, usage: string, san: string) => {
  openssl('genrsa', '-out', join(root, `${name}.key`), '2048')
  openssl('req', '-new', '-key', join(root, `${name}.key`), '-subj', `/CN=${name}`, '-out', join(root, `${name}.csr`))
  writeFileSync(join(root, `${name}.ext`), `extendedKeyUsage=${usage}\nsubjectAltName=${san}\n`, 'utf8')
  openssl(
    'x509', '-req', '-in', join(root, `${name}.csr`),
    '-CA', join(root, `${ca}.crt`), '-CAkey', join(root, `${ca}.key`),
    '-CAcreateserial', '-days', '1', '-sha256', '-extfile', join(root, `${name}.ext`),
    '-out', join(root, `${name}.crt`),
  )
}

const createCa = (name: string) => {
  openssl('genrsa', '-out', join(root, `${name}.key`), '2048')
  openssl(
    'req', '-x509', '-new', '-key', join(root, `${name}.key`), '-sha256', '-days', '1',
    '-subj', `/CN=${name}`, '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-out', join(root, `${name}.crt`),
  )
}

beforeAll(async () => {
  createCa('trusted-ca')
  createCa('rogue-ca')
  issue('localhost', 'trusted-ca', 'serverAuth', 'DNS:localhost')
  issue('console-bff', 'trusted-ca', 'clientAuth', 'URI:spiffe://openkubes.io/ns/openkubes-console/sa/ok-console-bff')

  const fixture = await new FixtureObservedStateAdapter().readSnapshot()
  const envelope = {
    apiVersion: 'observed.openkubes.io/v0alpha1',
    kind: 'ConsoleObservedState',
    metadata: { observedAt: fixture.observedAt, sourceRevision: fixture.sourceRevision },
    data: {
      environment: fixture.environment,
      metrics: fixture.metrics,
      clusters: fixture.clusters,
      placements: fixture.placements,
      evidence: fixture.evidence,
    },
  }
  server = createServer({
    key: readFileSync(join(root, 'localhost.key')),
    cert: readFileSync(join(root, 'localhost.crt')),
    ca: readFileSync(join(root, 'trusted-ca.crt')),
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
  }, (_request, response) => {
    const body = JSON.stringify(envelope)
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
    response.end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('mTLS test server did not expose a port.')
  port = address.port
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  rmSync(root, { recursive: true, force: true })
})

const environment = (hostname = 'localhost') => ({
  OK_CONSOLE_OBSERVED_STATE_MODE: 'openkubes',
  OK_CONSOLE_OBSERVED_STATE_URL: `https://${hostname}:${port}/api/console-observed-state/v0alpha1`,
  OK_CONSOLE_OBSERVED_STATE_CA_FILE: join(root, 'trusted-ca.crt'),
  OK_CONSOLE_OBSERVED_STATE_CLIENT_CERT_FILE: join(root, 'console-bff.crt'),
  OK_CONSOLE_OBSERVED_STATE_CLIENT_KEY_FILE: join(root, 'console-bff.key'),
})

describe('observed-state mTLS client profile', () => {
  it('presents the Console workload identity and verifies the producer', async () => {
    const snapshot = await createObservedStateSource(environment(), {
      now: () => new Date('2026-08-21T18:01:00Z'),
    }).readSnapshot()

    expect(snapshot.sourceRevision).toBe('fixture-observer:42')
    expect(snapshot.clusters[0].name).toBe('ok-mgmt')
  })

  it('requires all three bounded mounted trust files', () => {
    const missingKey = { ...environment(), OK_CONSOLE_OBSERVED_STATE_CLIENT_KEY_FILE: '' }
    expect(() => createObservedStateSource(missingKey)).toThrow('OK_CONSOLE_OBSERVED_STATE_CLIENT_KEY_FILE is required')
  })

  it('rejects an untrusted producer CA and a mismatched DNS identity', async () => {
    const untrusted = { ...environment(), OK_CONSOLE_OBSERVED_STATE_CA_FILE: join(root, 'rogue-ca.crt') }
    await expect(createObservedStateSource(untrusted).readSnapshot()).rejects.toThrow()
    await expect(createObservedStateSource(environment('127.0.0.1')).readSnapshot()).rejects.toThrow()
  })
})
