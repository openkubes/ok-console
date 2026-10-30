// @vitest-environment node

import { execFileSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const yamlToJson = (manifest: string) => JSON.parse(execFileSync('python3', [
  '-c',
  'import json, sys, yaml; json.dump([item for item in yaml.safe_load_all(sys.stdin) if item is not None], sys.stdout)',
], { input: manifest, encoding: 'utf8' }))

type Container = {
  name: string
  image?: string
  env?: Array<{ name: string, value?: string, valueFrom?: unknown }>
  envFrom?: unknown[]
}

type PodSpec = {
  initContainers?: Container[]
  containers?: Container[]
  ephemeralContainers?: Container[]
}

type Workload = {
  kind?: string
  metadata?: { name?: string, labels?: Record<string, string> }
  spec?: PodSpec & {
    template?: { metadata?: { labels?: Record<string, string> }, spec?: PodSpec }
    jobTemplate?: { spec?: { template?: { metadata?: { labels?: Record<string, string> }, spec?: PodSpec } } }
  }
}

describe('OK-173 deployable overlay authorization invariants', () => {
  it('uses the ownership-aware observed-state contract in the live Console', { timeout: 15_000 }, () => {
    const rendered = execFileSync('kubectl', ['kustomize', new URL('./overlays/ok-shared-live/', import.meta.url).pathname], { encoding: 'utf8' })
    const resources = yamlToJson(rendered) as Workload[]
    const deployment = resources.find((resource) => resource.kind === 'Deployment' && resource.metadata?.name === 'ok-console')
    const console = deployment?.spec?.template?.spec?.containers?.find((container) => container.name === 'console')

    expect(console?.env).toContainEqual({
      name: 'OK_CONSOLE_OBSERVED_STATE_URL',
      value: 'https://observed-state-producer.openkubes-console.svc:8443/api/console-observed-state/v0alpha2',
    })
  })

  it('renders every overlay except local-kind and keeps the Console out of prototype mode', { timeout: 30_000 }, async () => {
    const overlaysRoot = new URL('./overlays/', import.meta.url)
    const localKind = await readdir(new URL('./overlays/local-kind/', import.meta.url))
    expect(localKind).toContain('kustomization.yaml')
    const localKindOverlay = execFileSync('kubectl', ['kustomize', new URL('./overlays/local-kind/', import.meta.url).pathname], { encoding: 'utf8' })
    const localKindResources = yamlToJson(localKindOverlay) as Workload[]
    const localKindDeployment = localKindResources.find((resource) => resource.kind === 'Deployment' && resource.metadata?.name === 'ok-console')
    expect(localKindDeployment, 'local-kind must render the Console Deployment').toBeDefined()
    const localKindEnv = localKindDeployment?.spec?.template?.spec?.containers?.[0]?.env ?? []
    expect(localKindEnv).toContainEqual({ name: 'OK_CONSOLE_DEV_PROTOTYPE_ENABLED', value: 'true' })
    expect(localKindEnv).toContainEqual({ name: 'OK_CONSOLE_DISPOSABLE_LOCAL_CLUSTER_ACKNOWLEDGED', value: 'true' })

    const entries = await readdir(overlaysRoot, { withFileTypes: true })
    const directories = entries.filter((entry) => entry.isDirectory() && entry.name !== 'local-kind')
    const deployableOverlays = await Promise.all(directories.map(async (entry) => {
      const path = join(overlaysRoot.pathname, entry.name)
      const files = await readdir(path)
      return files.includes('kustomization.yaml') ? { name: entry.name, path } : undefined
    })).then((overlays) => overlays.filter((overlay) => overlay !== undefined))

    expect(deployableOverlays.map(({ name }) => name).sort()).toEqual([
      'ok-shared-bootstrap-recovery',
      'ok-shared-breakglass',
      'ok-shared-live',
    ])

    for (const overlay of deployableOverlays) {
      const rendered = execFileSync('kubectl', ['kustomize', overlay.path], { encoding: 'utf8' })
      const resources = yamlToJson(rendered) as Workload[]
      const workloads = resources.flatMap((resource) => {
        if (!['DaemonSet', 'Deployment', 'Job', 'Pod', 'ReplicaSet', 'StatefulSet', 'CronJob'].includes(resource.kind ?? '')) return []
        const template = resource.kind === 'CronJob'
          ? resource.spec?.jobTemplate?.spec?.template
          : resource.spec?.template
        const podLabels = resource.kind === 'Pod' ? resource.metadata?.labels : template?.metadata?.labels
        const podSpec = resource.kind === 'Pod' ? resource.spec : template?.spec
        const consoleWorkload = resource.metadata?.labels?.['app.kubernetes.io/name'] === 'ok-console'
          || podLabels?.['app.kubernetes.io/name'] === 'ok-console'
          || resource.metadata?.name === 'ok-console'
        if (!consoleWorkload || !podSpec) return []
        return [{ name: resource.metadata?.name ?? resource.kind, podSpec }]
      })

      expect(workloads, `${overlay.name} must render a Console workload`).not.toHaveLength(0)
      for (const workload of workloads) {
        const containers = [
          ...(workload.podSpec.initContainers ?? []),
          ...(workload.podSpec.containers ?? []),
          ...(workload.podSpec.ephemeralContainers ?? []),
        ]
        expect(containers, `${overlay.name}/${workload.name} must contain a Console container`).not.toHaveLength(0)
        for (const container of containers) {
          const context = `${overlay.name}/${workload.name}/${container.name}`
          expect(container.envFrom ?? [], `${context} cannot import unreviewed environment`).toHaveLength(0)
          if (container.name === 'postgres-migrations') continue
          const sessionMode = (container.env ?? []).filter((item) => item.name === 'OK_CONSOLE_SESSION_STORE_MODE')
          expect(sessionMode, `${context} must select PostgreSQL sessions explicitly`).toEqual([
            { name: 'OK_CONSOLE_SESSION_STORE_MODE', value: 'postgres' },
          ])
          expect((container.env ?? []).filter((item) => item.name === 'OK_CONSOLE_DEV_PROTOTYPE_ENABLED'), `${context} cannot enable prototype mode`).toHaveLength(0)
          expect((container.env ?? []).filter((item) => item.name === 'OK_CONSOLE_DISPOSABLE_LOCAL_CLUSTER_ACKNOWLEDGED'), `${context} cannot acknowledge a disposable cluster`).toHaveLength(0)
        }
      }
    }
  })
})
