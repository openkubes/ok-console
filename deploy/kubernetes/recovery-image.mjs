// Shared recovery image schema and strict JSON/YAML parser, extracted from the #171 renderer.
// Offline checks prove the record is well-formed, distinct from the recorded break-glass image and that the unreleased sentinel blocks rendering. They do not prove which build an image is. Bootstrap build identity (auth-mode=bootstrap label, GitHub build attestation from publish-dev-image, exact platform map) is established only by `verify-recovery-image.sh registry` against the staged release tree, and its output is attached to the reviewed release PR.
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

export const CONSOLE_IMAGE = 'ghcr.io/openkubes/ok-console'
export const UNRELEASED_DIGEST = `sha256:${'0'.repeat(64)}`
export const expectedDigestsPath = 'deploy/kubernetes/overlays/expected-digests.json'
export const overlays = { bootstrap: 'ok-shared-bootstrap-recovery', postRecovery: 'ok-shared-breakglass' }
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
export const parse = (mode, text, failure) => {
  const result = spawnSync('python3', ['-c', parser, mode], { input: text, encoding: 'utf8' })
  if (result.error || result.status === 1) throw new Error('python3 with PyYAML is required.')
  if (result.status !== 0) throw new Error(failure)
  return JSON.parse(result.stdout)
}
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const sameKeys = (value, keys) => isRecord(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())

export const recoveryState = (entry) => entry.image.split('@')[1] === UNRELEASED_DIGEST ? 'unreleased' : 'released'

export const validateExpectedDigests = (parsed) => {
  const names = Object.values(overlays)
  if (!sameKeys(parsed, names)) throw new Error(`${expectedDigestsPath} must name exactly ${names.join(' and ')}.`) // guard: entries
  for (const name of names) {
    const entry = parsed[name]
    const bootstrap = name === overlays.bootstrap
    const keys = bootstrap ? ['image', 'platforms', 'provenance'] : ['image', 'platforms']
    if (!sameKeys(entry, keys)) throw new Error(`${name}: entry must have exactly ${keys.join(' and ')}.`) // guard: entry-keys
    const [imageRepository, indexDigest, extra] = typeof entry.image === 'string' ? entry.image.split('@') : []
    if (imageRepository !== CONSOLE_IMAGE || !digestPattern.test(indexDigest ?? '') || extra !== undefined) {
      throw new Error(`${name}: image must be ${CONSOLE_IMAGE}@sha256:<64 hex>.`) // guard: image
    }
    const sentinel = bootstrap && indexDigest === UNRELEASED_DIGEST
    if (!bootstrap && indexDigest === UNRELEASED_DIGEST) throw new Error(`${name}: breakglass index must not be the zero sentinel.`) // guard: zero-index
    if (!isRecord(entry.platforms)) throw new Error(`${name}: platforms must map platform names to child digests (object required).`) // guard: platforms-type
    const platforms = Object.entries(entry.platforms)
    if (sentinel && platforms.length !== 0) throw new Error(`${name}: sentinel platforms must be {}.`) // guard: platforms-sentinel
    if (!sentinel) {
      if (!platforms.some(([platform]) => platform === 'linux/amd64')) throw new Error(`${name}: platforms must map linux/amd64 (required).`) // guard: platforms-required
      if (platforms.some(([platform]) => !/^linux\/(?:amd64|arm64)$/.test(platform))) throw new Error(`${name}: platforms must map only linux/amd64 or linux/arm64.`) // guard: platforms-name
      if (platforms.some(([, child]) => typeof child !== 'string' || !digestPattern.test(child))) throw new Error(`${name}: platforms must map to valid sha256 child digests.`) // guard: platforms-digest
      if (platforms.some(([, child]) => child === UNRELEASED_DIGEST)) throw new Error(`${name}: platform child must not be the zero sentinel.`) // guard: zero-child
      if (platforms.some(([, child]) => child === indexDigest)) throw new Error(`${name}: platforms must map to children different from the index.`) // guard: platforms-index
      if (new Set(platforms.map(([, child]) => child)).size !== platforms.length) throw new Error(`${name}: platforms must map to distinct child digests.`) // guard: platforms-distinct
    }
    if (bootstrap) {
      const provenance = entry.provenance
      if (!sameKeys(provenance, ['authMode', 'dataMode', 'releaseTag', 'revision'])) throw new Error(`${name}: provenance keys must be exactly authMode, dataMode, releaseTag, revision.`) // guard: provenance-keys
      if (sentinel) {
        if (Object.values(provenance).some((value) => value !== null)) throw new Error('Unreleased bootstrap provenance values must all be null.') // guard: sentinel-provenance
      } else {
        if (provenance.authMode !== 'bootstrap') throw new Error('Released bootstrap authMode must be bootstrap.') // guard: auth-mode
        if (provenance.dataMode !== 'bff') throw new Error('Released bootstrap dataMode must be bff.') // guard: data-mode
        if (typeof provenance.revision !== 'string' || !/^[a-f0-9]{40}$/.test(provenance.revision)) throw new Error('revision must be a full 40-character commit SHA.') // guard: revision
        if (typeof provenance.releaseTag !== 'string' || !/^dev-v[0-9][0-9A-Za-z.-]{0,63}$/.test(provenance.releaseTag)) throw new Error('releaseTag must be a dev-v* tag.') // guard: release-tag
      }
    }
  }
  const digests = (entry) => [entry.image.split('@')[1], ...Object.values(entry.platforms)]
  const breakglass = new Set(digests(parsed[overlays.postRecovery]))
  if (digests(parsed[overlays.bootstrap]).some((digest) => breakglass.has(digest))) throw new Error('Bootstrap and break-glass index/child digests must not overlap.') // guard: overlap
  return parsed
}

export const loadExpectedDigests = async (root = '.') => {
  let text
  try { text = await readFile(resolve(root, expectedDigestsPath), 'utf8') }
  catch { throw new Error(`${expectedDigestsPath} is missing.`) }
  const expected = validateExpectedDigests(parse('json', text, `${expectedDigestsPath} is not valid JSON or repeats a key.`))
  return expected
}

export const requireReleasedRecovery = (expected) => {
  if (recoveryState(expected[overlays.bootstrap]) === 'unreleased') throw new Error('No bootstrap-built recovery image has been released. Complete the separately authorized bootstrap recovery image release step in docs/evidence/ok-170/maintenance-procedure.md before rendering.') // guard: sentinel-gate
}

export const validateOverlayPin = async (name, expected, root = '.') => {
  const overlay = `deploy/kubernetes/overlays/${name}`
  const [kustomization] = parse('yaml', await readFile(resolve(root, overlay, 'kustomization.yaml'), 'utf8'), `${overlay}/kustomization.yaml is not valid YAML.`)
  const pins = (Array.isArray(kustomization?.images) ? kustomization.images : []).filter((entry) => entry?.name === CONSOLE_IMAGE)
  if (pins.length !== 1 || (pins[0].newName ?? CONSOLE_IMAGE) !== CONSOLE_IMAGE || pins[0].newTag !== undefined
    || `${CONSOLE_IMAGE}@${pins[0].digest}` !== expected[name].image) {
    throw new Error(`${overlay}/kustomization.yaml does not pin the image in ${expectedDigestsPath}.`) // guard: overlay-pin
  }
}
