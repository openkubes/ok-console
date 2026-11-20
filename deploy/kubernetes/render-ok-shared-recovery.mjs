#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { BREAKGLASS_DIGEST, CONSOLE_IMAGE, UNRELEASED_DIGEST, checkRecoveryProvenance, consoleImageReferences } from './recovery-image.mjs'

const usage = 'Usage: node deploy/kubernetes/render-ok-shared-recovery.mjs [--provenance <image-provenance.json>] <new-output-directory>'
const args = process.argv.slice(2)
let provenancePath = 'deploy/kubernetes/overlays/ok-shared-bootstrap-recovery/image-provenance.json'
if (args[0] === '--provenance') {
  provenancePath = args[1]
  args.splice(0, 2)
}
if (args.length !== 1 || !provenancePath || args[0].startsWith('-')) {
  console.error(usage)
  process.exit(2)
}

const outputDirectory = resolve(args[0])
let provenance
try {
  provenance = JSON.parse(await readFile(provenancePath, 'utf8'))
} catch {
  console.error(`Cannot read the recovery image provenance at ${provenancePath}.`)
  process.exit(2)
}
const checked = checkRecoveryProvenance(provenance)
if (checked.state !== 'released') {
  console.error(checked.state === 'unreleased'
    ? 'No bootstrap-built recovery image has been released: image-provenance.json still holds the unreleased sentinel. Publish a dev-v* build under a release authorization, verify it with deploy/kubernetes/verify-recovery-image.sh, and record its digest first.'
    : `The recovery image provenance is invalid: ${checked.errors.join('; ')}.`)
  process.exit(2)
}
const bootstrapDigest = provenance.digest
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

const prepare = (overlay, replacements, digest) => {
  let manifest = render(overlay)
  const references = consoleImageReferences(manifest)
  if (references.length !== 1) throw new Error(`Rendered ${overlay} must reference the Console image exactly once; found ${references.length}.`)
  if (digest !== BREAKGLASS_DIGEST && references[0] === `${CONSOLE_IMAGE}@${UNRELEASED_DIGEST}`) {
    manifest = replaceExactlyOnce(manifest, UNRELEASED_DIGEST, digest)
  }
  for (const [placeholder, value] of Object.entries(replacements)) {
    manifest = replaceExactlyOnce(manifest, placeholder, value)
  }
  if (/REPLACE_[A-Z_]+/.test(manifest)) {
    throw new Error(`Rendered ${overlay} contains an unresolved recovery placeholder.`)
  }
  if (consoleImageReferences(manifest).join() !== `${CONSOLE_IMAGE}@${digest}`) {
    throw new Error(`Rendered ${overlay} does not reference the expected Console digest ${digest}.`)
  }
  return manifest
}

const bootstrapManifest = prepare('deploy/kubernetes/overlays/ok-shared-bootstrap-recovery', {
  REPLACE_BOOTSTRAP_RECOVERY_EPOCH: values.bootstrapEpoch,
  REPLACE_BOOTSTRAP_AUTHORIZATION_REVISION: values.bootstrapAuthorizationRevision,
}, bootstrapDigest)
const postRecoveryManifest = prepare('deploy/kubernetes/overlays/ok-shared-breakglass', {
  REPLACE_POST_RECOVERY_EPOCH: values.postRecoveryEpoch,
  REPLACE_POST_RECOVERY_AUTHORIZATION_REVISION: values.postRecoveryAuthorizationRevision,
}, BREAKGLASS_DIGEST)

await mkdir(outputDirectory, { mode: 0o700 })
await writeFile(`${outputDirectory}/bootstrap.yaml`, bootstrapManifest, { mode: 0o600 })
await writeFile(`${outputDirectory}/post-recovery.yaml`, postRecoveryManifest, { mode: 0o600 })
await writeFile(`${outputDirectory}/recovery-evidence.json`, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  bootstrapImage: { digest: bootstrapDigest, revision: provenance.revision, releaseTag: provenance.releaseTag, authMode: 'bootstrap' },
  postRecoveryImage: { digest: BREAKGLASS_DIGEST, authMode: 'breakglass' },
  ...values,
  singleUse: true,
}, null, 2)}\n`, { mode: 0o600 })

console.log(JSON.stringify({ outputDirectory, ...values, bootstrapImageDigest: bootstrapDigest, postRecoveryImageDigest: BREAKGLASS_DIGEST, singleUse: true }))
