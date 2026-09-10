#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const outputArgument = process.argv[2]
if (!outputArgument) {
  console.error('Usage: node deploy/kubernetes/render-ok-shared-recovery.mjs <new-output-directory>')
  process.exit(2)
}

const outputDirectory = resolve(outputArgument)
const digest = 'sha256:705edc32be35c935d25414c790cc648649ab3aa3ace24f42423510e3a9e8ccbc'
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

const prepare = (overlay, replacements) => {
  let manifest = render(overlay)
  for (const [placeholder, value] of Object.entries(replacements)) {
    manifest = replaceExactlyOnce(manifest, placeholder, value)
  }
  if (/REPLACE_[A-Z_]+/.test(manifest)) {
    throw new Error(`Rendered ${overlay} contains an unresolved recovery placeholder.`)
  }
  if (!manifest.includes(`image: ghcr.io/openkubes/ok-console@${digest}`)) {
    throw new Error(`Rendered ${overlay} does not contain the reviewed rc.3 digest.`)
  }
  return manifest
}

const bootstrapManifest = prepare('deploy/kubernetes/overlays/ok-shared-bootstrap-recovery', {
  REPLACE_BOOTSTRAP_RECOVERY_EPOCH: values.bootstrapEpoch,
  REPLACE_BOOTSTRAP_AUTHORIZATION_REVISION: values.bootstrapAuthorizationRevision,
})
const postRecoveryManifest = prepare('deploy/kubernetes/overlays/ok-shared-breakglass', {
  REPLACE_POST_RECOVERY_EPOCH: values.postRecoveryEpoch,
  REPLACE_POST_RECOVERY_AUTHORIZATION_REVISION: values.postRecoveryAuthorizationRevision,
})

await mkdir(outputDirectory, { mode: 0o700 })
await writeFile(`${outputDirectory}/bootstrap.yaml`, bootstrapManifest, { mode: 0o600 })
await writeFile(`${outputDirectory}/post-recovery.yaml`, postRecoveryManifest, { mode: 0o600 })
await writeFile(`${outputDirectory}/recovery-evidence.json`, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  imageDigest: digest,
  ...values,
  singleUse: true,
}, null, 2)}\n`, { mode: 0o600 })

console.log(JSON.stringify({ outputDirectory, ...values, imageDigest: digest, singleUse: true }))
