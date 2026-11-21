// OK-173: identity of the image the bootstrap-only recovery overlay may run. The recovery
// overlay must use a bootstrap build (VITE_CONSOLE_AUTH_MODE=bootstrap); the SPA mode is fixed
// at build time, so a break-glass build keeps offering the identity provider after a rollback.

export const CONSOLE_IMAGE = 'ghcr.io/openkubes/ok-console'
export const UNRELEASED_DIGEST = `sha256:${'0'.repeat(64)}`
// Reviewed rc.3, auth-mode=breakglass (revision f653fcf). Valid for ok-shared-breakglass only.
export const BREAKGLASS_DIGEST = 'sha256:705edc32be35c935d25414c790cc648649ab3aa3ace24f42423510e3a9e8ccbc'

const DIGEST = /^sha256:[a-f0-9]{64}$/
const REVISION = /^[a-f0-9]{40}$/
// publish-dev-image builds auth-mode=bootstrap for dev-v* tags and breakglass for dev-breakglass-v*.
const BOOTSTRAP_RELEASE_TAG = /^dev-v[0-9][0-9A-Za-z.-]{0,63}$/
const KEYS = ['authMode', 'dataMode', 'digest', 'image', 'releaseTag', 'revision']

/** Returns { state: 'released' | 'unreleased' | 'invalid', errors: string[] }. */
export const checkRecoveryProvenance = (provenance) => {
  const errors = []
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
    return { state: 'invalid', errors: ['provenance must be a JSON object'] }
  }
  const keys = Object.keys(provenance).sort()
  if (keys.join() !== KEYS.join()) errors.push(`provenance keys must be exactly ${KEYS.join(', ')}`)
  if (provenance.image !== CONSOLE_IMAGE) errors.push(`image must be ${CONSOLE_IMAGE}`)
  if (provenance.authMode !== 'bootstrap') errors.push('authMode must be bootstrap')
  if (provenance.dataMode !== 'bff') errors.push('dataMode must be bff')
  const { digest, revision, releaseTag } = provenance
  if (digest === UNRELEASED_DIGEST && revision === null && releaseTag === null) {
    return { state: errors.length ? 'invalid' : 'unreleased', errors }
  }
  if (typeof digest !== 'string' || !DIGEST.test(digest) || digest === UNRELEASED_DIGEST) {
    errors.push('digest must be a released sha256 digest')
  }
  if (digest === BREAKGLASS_DIGEST) errors.push('digest is the break-glass build, not a bootstrap build')
  if (typeof revision !== 'string' || !REVISION.test(revision)) errors.push('revision must be a full 40-character commit SHA')
  if (typeof releaseTag !== 'string' || !BOOTSTRAP_RELEASE_TAG.test(releaseTag)) errors.push('releaseTag must be a dev-v* tag')
  return { state: errors.length ? 'invalid' : 'released', errors }
}

/** All ok-console image references in a rendered manifest. */
export const consoleImageReferences = (manifest) => [...manifest.matchAll(/^\s*(?:-\s+)?image:\s*["']?(\S+?)["']?\s*$/gm)]
  .map((match) => match[1])
  .filter((reference) => reference.startsWith(`${CONSOLE_IMAGE}@`) || reference.startsWith(`${CONSOLE_IMAGE}:`) || reference === CONSOLE_IMAGE)
