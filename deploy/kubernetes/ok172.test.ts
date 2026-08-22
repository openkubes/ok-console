// @vitest-environment node

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execute = promisify(execFile)
const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8')
const overlay = './overlays/ok-shared-live'

describe('OK-172 ok-shared live slice invariants', () => {
  it('renders only immutable accepted candidates without credential objects or placeholders', async () => {
    const { stdout } = await execute('kubectl', ['kustomize', new URL(overlay, import.meta.url).pathname])
    expect(stdout).toContain('ghcr.io/openkubes/ok-console@sha256:10cfb281bc5d0d14aaea34ca072ea4b92d69183df617c1a2d19c1d3a5d6aac6b')
    expect(stdout).toContain('ghcr.io/openkubes/observed-state-producer@sha256:2af5f7fe9612a4fe006fbb931f47356d0e797339542d9012752a9208e8cd359c')
    expect(stdout).not.toMatch(/REPLACE_|\.invalid|sha256:0{64}|image: .+:latest/)
    expect(stdout).not.toMatch(/^kind: Secret$/m)
    expect(stdout).toContain('value: hosting-cluster')
    expect(stdout).toContain('value: bootstrap')
    expect(stdout).toContain('value: openkubes')
  })

  it('grants the producer only its bounded hosting-cluster reads', async () => {
    const rbac = await read(`${overlay}/producer-rbac.yaml`)
    expect(rbac).toContain('resources: ["nodes"]')
    expect(rbac).toContain('verbs: ["get", "list"]')
    expect(rbac).toContain('nonResourceURLs: ["/version"]')
    expect(rbac).toContain('resourceNames: ["ok-console"]')
    expect(rbac).not.toMatch(/secrets|pods|exec|logs|create|update|patch|delete|impersonate/)
    expect(rbac).not.toMatch(/crossplane|kubevirt|cluster\.x-k8s/i)
  })

  it('uses separate server/client identities and the exact SPIFFE client URI', async () => {
    const certificates = await read(`${overlay}/certificates.yaml`)
    const producer = await read(`${overlay}/producer-deployment.yaml`)
    expect(certificates).toContain('observed-state-producer.openkubes-console.svc')
    expect(certificates).toContain('spiffe://openkubes.io/ns/openkubes-console/sa/ok-console')
    expect(certificates).toContain('- client auth')
    expect(certificates).toContain('- server auth')
    expect(producer).toContain('value: spiffe://openkubes.io/ns/openkubes-console/sa/ok-console')
    expect(producer).toContain('path: client-ca.crt')
    expect(producer).toContain('defaultMode: 288')
  })

  it('pins PostgreSQL and initializes the session, OIDC and bootstrap relations', async () => {
    const cluster = await read(`${overlay}/postgres-cluster.yaml`)
    const migrations = await read(`${overlay}/postgres-migrations.yaml`)
    expect(cluster).toContain('ghcr.io/cloudnative-pg/postgresql:16.10-system-trixie@sha256:26e146bc71ebfc2a3937f729a15161a7fb6cd7c8a0b0007ad60cb53d2371b3fc')
    expect(cluster).toContain('storageClass: local-path')
    expect(cluster).toContain('001_console_sessions.sql')
    expect(cluster).toContain('002_oidc_transactions.sql')
    expect(cluster).toContain('003_local_access_throttle.sql')
    expect(cluster).toContain('004_local_access_audit.sql')
    expect(migrations).toContain('CREATE TABLE IF NOT EXISTS ok_console.sessions')
    expect(migrations).toContain('CREATE TABLE IF NOT EXISTS ok_console.oidc_transactions')
    expect(migrations).toContain('CREATE TABLE IF NOT EXISTS ok_console.local_access_throttle')
    expect(migrations).toContain('CREATE TABLE IF NOT EXISTS ok_console.local_access_audit')
    expect(migrations).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ok_console.sessions TO ok_console')
    expect(migrations).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ok_console.local_access_throttle TO ok_console')
    expect(migrations).toContain('GRANT INSERT ON TABLE ok_console.local_access_audit TO ok_console')
    expect(migrations).not.toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ok_console.local_access_audit')
  })

  it('permits only reviewed ingress, DNS, database, producer and API-server flows', async () => {
    const policies = await read(`${overlay}/network-policies.yaml`)
    expect(policies).toContain('name: ok-console-preview-ingress')
    expect(policies).toContain('app.kubernetes.io/instance: traefik-ingress')
    expect(policies).toContain('k8s-app: kube-dns')
    expect(policies).toContain('cnpg.io/cluster: ok-console-db')
    expect(policies).toContain('kubernetes.io/metadata.name: cnpg-system')
    expect(policies).toContain('app.kubernetes.io/name: cloudnative-pg')
    expect(policies).toContain('port: 8000')
    expect(policies).toContain('kind: CiliumNetworkPolicy')
    expect(policies).toContain('- kube-apiserver')
    expect(policies).not.toMatch(/0\.0\.0\.0\/0|::\/0/)
  })

  it('keeps credential generation gated, TTY-only and out of command arguments', async () => {
    const provisioner = await read('./provision-ok-shared-bootstrap.mjs')
    expect(provisioner).toContain("OK_CONSOLE_APPLY_BOOTSTRAP !== 'true'")
    expect(provisioner).toContain('requires an interactive TTY')
    expect(provisioner).toContain('scrypt(password, salt, 32, kdf)')
    expect(provisioner).toContain("'--field-manager=ok-172-bootstrap', '-f', '-'")
    expect(provisioner).not.toContain('--from-literal')
    expect(provisioner).not.toMatch(/console\.log\((password|envelopeKey|pepper|verifier)\)/)
  })

  it('defaults to render-only and verifies context, ownership, dry-run and deny-side RBAC', async () => {
    const verifier = await read('./verify-ok-shared-live.sh')
    expect(verifier).toContain('ok-shared-admin@ok-shared')
    expect(verifier).toContain('openkubes.io/managed-by=ok-170')
    expect(verifier).toContain('OK_CONSOLE_APPLY_LIVE:-false')
    expect(verifier).toContain('--dry-run=server')
    expect(verifier).toContain('--force-conflicts')
    expect(verifier).toContain('auth can-i get secrets')
    expect(verifier).toContain('auth can-i create deployments')
    expect(verifier).toContain('expected contract-level 403')
    expect(verifier).not.toMatch(/kubectl delete|BEGIN PRIVATE KEY/)
  })
})
