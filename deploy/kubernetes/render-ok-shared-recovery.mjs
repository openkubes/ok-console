#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const outputArgument = process.argv[2]
if (!outputArgument) {
  console.error('Usage: node deploy/kubernetes/render-ok-shared-recovery.mjs <new-output-directory>')
  process.exit(2)
}

const outputDirectory = resolve(outputArgument)
const expectedDigestsPath = 'deploy/kubernetes/overlays/expected-digests.json'
const overlays = { bootstrap: 'ok-shared-bootstrap-recovery', postRecovery: 'ok-shared-breakglass' }
const repository = 'ghcr.io/openkubes/ok-console'
const digestPattern = /^sha256:[a-f0-9]{64}$/
// python3 + PyYAML (also required by the read-only verifier) parse YAML and reject duplicate JSON keys,
// which JSON.parse would silently collapse to the last value.
const parser = `
import json, sys, yaml
mode, text = sys.argv[1], sys.stdin.read()
def strict(pairs):
    keys = [k for k, _ in pairs]
    if len(keys) != len(set(keys)):
        raise ValueError("duplicate key")
    return dict(pairs)
try:
    value = json.loads(text, object_pairs_hook=strict) if mode == "json" else [d for d in yaml.safe_load_all(text) if d is not None]
except Exception:
    sys.exit(3)
json.dump(value, sys.stdout)
`
const parse = (mode, text, failure) => {
  const result = spawnSync('python3', ['-c', parser, mode], { input: text, encoding: 'utf8' })
  if (result.error || result.status === 1) throw new Error('python3 with PyYAML is required.')
  if (result.status !== 0) throw new Error(failure)
  return JSON.parse(result.stdout)
}
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const sameKeys = (value, keys) => isRecord(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())

// One reviewed file pins the image per recovery overlay (index digest plus platform-child digests).
const loadExpectedDigests = async () => {
  let text
  try {
    text = await readFile(expectedDigestsPath, 'utf8')
  } catch {
    throw new Error(`${expectedDigestsPath} is missing.`)
  }
  const parsed = parse('json', text, `${expectedDigestsPath} is not valid JSON or repeats a key.`)
  const names = Object.values(overlays)
  if (!sameKeys(parsed, names)) throw new Error(`${expectedDigestsPath} must name exactly ${names.join(' and ')}.`)
  for (const name of names) {
    const entry = parsed[name]
    if (!sameKeys(entry, ['image', 'platforms'])) throw new Error(`${name}: entry must have exactly image and platforms.`)
    const [imageRepository, indexDigest, extra] = typeof entry.image === 'string' ? entry.image.split('@') : []
    if (imageRepository !== repository || !digestPattern.test(indexDigest ?? '') || extra !== undefined) {
      throw new Error(`${name}: image must be ${repository}@sha256:<64 hex>.`)
    }
    const platforms = isRecord(entry.platforms) ? Object.entries(entry.platforms) : []
    if (!platforms.some(([platform]) => platform === 'linux/amd64')
      || !platforms.every(([platform, child]) => /^linux\/(?:amd64|arm64)$/.test(platform) && digestPattern.test(child) && child !== indexDigest)
      || new Set(platforms.map(([, child]) => child)).size !== platforms.length) {
      throw new Error(`${name}: platforms must map linux/amd64 (and optionally linux/arm64) to distinct child digests.`)
    }
  }
  return parsed
}
const expectedDigests = await loadExpectedDigests()
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
  const [kustomization] = parse('yaml', await readFile(`${overlay}/kustomization.yaml`, 'utf8'), `${overlay}/kustomization.yaml is not valid YAML.`)
  const pins = (Array.isArray(kustomization?.images) ? kustomization.images : []).filter((entry) => entry?.name === repository)
  if (pins.length !== 1 || (pins[0].newName ?? repository) !== repository || pins[0].newTag !== undefined
    || `${repository}@${pins[0].digest}` !== image) {
    throw new Error(`${overlay}/kustomization.yaml does not pin the image in ${expectedDigestsPath}.`)
  }
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
  const app = objects.filter((o) => o?.kind === 'Deployment' && o.metadata?.name === 'ok-console')
    .flatMap((o) => (o.spec?.template?.spec?.containers ?? []).map((c) => c?.image).filter(isConsole))
  if (app.length !== 1 || app[0] !== image || consoleImages.some((reference) => reference !== image)) {
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
