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
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${expectedDigestsPath} is not valid JSON.`)
  }
  const names = Object.values(overlays)
  if (!sameKeys(parsed, names)) throw new Error(`${expectedDigestsPath} must name exactly ${names.join(' and ')}.`)
  for (const name of names) {
    if (text.split(`"${name}"`).length - 1 !== 1) throw new Error(`${expectedDigestsPath} names ${name} more than once.`)
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
  const pinned = [...(await readFile(`${overlay}/kustomization.yaml`, 'utf8')).matchAll(/^\s*digest:\s*(\S+)\s*$/gm)].map((match) => match[1])
  if (pinned.length !== 1 || `${repository}@${pinned[0]}` !== image) {
    throw new Error(`${overlay}/kustomization.yaml does not pin the image in ${expectedDigestsPath}.`)
  }
  let manifest = render(overlay)
  for (const [placeholder, value] of Object.entries(replacements)) {
    manifest = replaceExactlyOnce(manifest, placeholder, value)
  }
  if (/REPLACE_[A-Z_]+/.test(manifest)) {
    throw new Error(`Rendered ${overlay} contains an unresolved recovery placeholder.`)
  }
  const consoleImages = [...manifest.matchAll(/^\s*(?:-\s+)?image:\s*["']?([^"'\s]+)["']?\s*$/gm)]
    .map((match) => match[1]).filter((reference) => reference.startsWith(`${repository}@`) || reference.startsWith(`${repository}:`))
  if (consoleImages.length === 0 || consoleImages.some((reference) => reference !== image)) {
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
