#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

import { CONSOLE_IMAGE, expectedDigestsPath, overlays, parse, loadExpectedDigests, requireReleasedRecovery, validateOverlayPin } from './recovery-image.mjs'

const outputArgument = process.argv[2]
if (process.argv.length !== 3 || !outputArgument || outputArgument.startsWith('-')) {
  console.error('Usage: node deploy/kubernetes/render-ok-shared-recovery.mjs <new-output-directory>')
  process.exit(2)
}

const outputDirectory = resolve(outputArgument)
const expectedDigests = await loadExpectedDigests()
requireReleasedRecovery(expectedDigests)
const repository = CONSOLE_IMAGE
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const values = {
  bootstrapEpoch: `ok-shared-bootstrap-${randomUUID()}`,
  bootstrapAuthorizationRevision: `ok-shared-bootstrap-auth-${randomUUID()}`,
  postRecoveryEpoch: `ok-shared-post-recovery-${randomUUID()}`,
  postRecoveryAuthorizationRevision: `ok-shared-breakglass-${randomUUID()}`,
}

const render = (overlay) => {
  const result = spawnSync('kubectl', ['kustomize', overlay], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || `Failed to render ${overlay}.`)
  return result.stdout
}

const replaceExactlyOnce = (manifest, placeholder, value) => {
  const occurrences = manifest.split(placeholder).length - 1
  if (occurrences !== 1) throw new Error(`${placeholder} must occur exactly once; found ${occurrences}.`)
  return manifest.replace(placeholder, value)
}

const prepare = async (name, replacements) => {
  const overlay = `deploy/kubernetes/overlays/${name}`
  const { image } = expectedDigests[name]
  await validateOverlayPin(name, expectedDigests)
  let manifest = render(overlay)
  for (const [placeholder, value] of Object.entries(replacements)) {
    manifest = replaceExactlyOnce(manifest, placeholder, value)
  }
  if (/REPLACE_[A-Z_]+/.test(manifest)) {
    throw new Error(`Rendered ${overlay} contains an unresolved recovery placeholder.`)
  }
  // Inspect real Pod specs only, so an image string elsewhere (a ConfigMap value, an annotation) cannot stand in.
  const objects = parse('yaml', manifest, `Rendered ${overlay} is not valid YAML.`)
  const podSpecs = objects.map((o) => o?.kind === 'Pod' ? o.spec : o?.kind === 'CronJob' ? o.spec?.jobTemplate?.spec?.template?.spec : o?.spec?.template?.spec)
    .filter(isRecord)
  const containers = podSpecs.flatMap((spec) => [...(spec.initContainers ?? []), ...(spec.containers ?? [])])
  const isConsole = (reference) => typeof reference === 'string'
    && (reference === repository || reference.startsWith(`${repository}@`) || reference.startsWith(`${repository}:`))
  const consoleImages = containers.map((c) => c?.image).filter(isConsole)
  // The app container is identified by name, so a sidecar carrying the approved image cannot stand in for it.
  const deployments = objects.filter((o) => o?.kind === 'Deployment' && o.metadata?.name === 'ok-console')
  const app = deployments.flatMap((o) => (o.spec?.template?.spec?.containers ?? []).filter((c) => c?.name === 'console'))
  if (deployments.length !== 1 || deployments[0].metadata?.namespace !== 'openkubes-console' || app.length !== 1 || app[0].image !== image || consoleImages.some((reference) => reference !== image)) {
    throw new Error(`Rendered ${overlay} does not run exactly the image in ${expectedDigestsPath}.`)
  }
  return manifest
}

const bootstrapManifest = await prepare(overlays.bootstrap, {
  REPLACE_BOOTSTRAP_RECOVERY_EPOCH: values.bootstrapEpoch,
  REPLACE_BOOTSTRAP_AUTHORIZATION_REVISION: values.bootstrapAuthorizationRevision,
})
const postRecoveryManifest = await prepare(overlays.postRecovery, {
  REPLACE_POST_RECOVERY_EPOCH: values.postRecoveryEpoch,
  REPLACE_POST_RECOVERY_AUTHORIZATION_REVISION: values.postRecoveryAuthorizationRevision,
})

function imageDigests() {
  return Object.fromEntries(Object.entries(overlays).map(([phase, name]) => [phase, {
    overlay: name, image: expectedDigests[name].image, platforms: expectedDigests[name].platforms,
    ...(expectedDigests[name].provenance ? { provenance: expectedDigests[name].provenance } : {}),
  }]))
}

await mkdir(outputDirectory, { mode: 0o700 })
await writeFile(`${outputDirectory}/bootstrap.yaml`, bootstrapManifest, { mode: 0o600 })
await writeFile(`${outputDirectory}/post-recovery.yaml`, postRecoveryManifest, { mode: 0o600 })
await writeFile(`${outputDirectory}/recovery-evidence.json`, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  imageDigests: imageDigests(),
  ...values,
  singleUse: true,
}, null, 2)}\n`, { mode: 0o600 })

console.log(JSON.stringify({ outputDirectory, ...values, imageDigests: imageDigests(), singleUse: true }))
