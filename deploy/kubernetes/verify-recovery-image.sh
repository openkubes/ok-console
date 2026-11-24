#!/usr/bin/env bash
# OK-173: verify the bootstrap-built recovery image without publishing anything.
#
#   verify-recovery-image.sh local <git-revision>
#     Validates the working tree record and pins (released revision must match the argument).
#     Builds the recovery image twice, without cache, from a clean `git archive` of one commit
#     (linux/amd64 only, VITE_CONSOLE_AUTH_MODE=bootstrap, VITE_CONSOLE_DATA_MODE=bff) and asserts:
#     the auth-mode, data-mode and revision labels; an identical image configuration; and
#     identical content hashes of /app/dist, /app/bff, /app/node_modules and /app/package.json
#     (pnpm's prunedAt and lastValidatedTimestamp install timestamps are blanked first).
#     Image IDs are printed for the record; byte-identical layers are not required. Nothing is
#     pushed. The labels record how the image was built; the bootstrap SPA's behaviour at a
#     revision is proven by `pnpm test:e2e:oidc` (AC11), not by this script.
#
#   verify-recovery-image.sh registry <image@sha256:...>
#     Release-time check of a published image: the reference must equal the provenance record;
#     every platform's configuration must carry auth-mode=bootstrap, data-mode=bff and the
#     recorded revision; and the signed GitHub build-provenance attestation (publish-dev-image)
#     must bind the digest to openkubes/ok-console at that revision and refs/tags/<releaseTag>.
#     Reads registry and attestation metadata only; requires `gh`.
#
# RECOVERY_VERIFY_BUILD_AUTH_MODE overrides the build argument only (negative control: a
# breakglass build must fail the label check). Exit codes: 0 pass, 1 check failed, 2 usage.
set -Eeuo pipefail

EXPECTED_AUTH_MODE=bootstrap
EXPECTED_DATA_MODE=bff
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$script_dir/../.." && pwd)

usage() {
  echo "usage: $0 local <git-revision> | registry <image@sha256:...>" >&2
  exit 2
}
fail() { echo "FAIL: $*" >&2; exit 1; }
label() { docker image inspect --format "{{ index .Config.Labels \"$2\" }}" "$1"; }

# Globals, so the EXIT trap can still see them after verify_local returns.
tmp=
name=
cleanup() {
  if [ -n "$name" ]; then
    docker rm -f "$name-1" "$name-2" >/dev/null 2>&1 || true
    docker image rm -f "$name:1" "$name:2" >/dev/null 2>&1 || true
  fi
  if [ -n "$tmp" ]; then rm -rf "$tmp"; fi
}
trap cleanup EXIT

# Use the same strict schema, overlap check and overlay pins as the renderer.
recovery_record() {
  node --input-type=module - "$repo_root" "$script_dir/recovery-image.mjs" "$1" "$2" <<'EOF'
import { pathToFileURL } from 'node:url'
const [root, modulePath, mode, requested] = process.argv.slice(2)
const { loadExpectedDigests, overlays, recoveryState, requireReleasedRecovery, validateOverlayPin } = await import(pathToFileURL(modulePath).href)
const expected = await loadExpectedDigests(root)
for (const name of Object.values(overlays)) await validateOverlayPin(name, expected, root)
const entry = expected[overlays.bootstrap]
if (mode === 'registry') {
  requireReleasedRecovery(expected)
  if (requested !== entry.image) throw new Error('the reference does not match the provenance image and digest')
} else if (recoveryState(entry) === 'released' && requested !== entry.provenance.revision) {
  throw new Error('requested commit does not match the recovery provenance revision') // guard: verifier-local-revision
}
console.log(recoveryState(entry) === 'unreleased' ? 'bootstrap bff' : `${entry.provenance.authMode} ${entry.provenance.dataMode}`)
EOF
}

verify_local() {
  local revision
  revision=$(git -C "$repo_root" rev-parse --verify --quiet "$1^{commit}") || { echo "unknown revision: $1" >&2; exit 2; }
  local expectations
  expectations=$(recovery_record local "$revision") || fail "invalid recovery image record"
  read -r EXPECTED_AUTH_MODE EXPECTED_DATA_MODE <<<"$expectations"
  docker buildx version >/dev/null 2>&1 || { echo "docker buildx is required" >&2; exit 2; }
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/ok-console-recovery-verify.XXXXXX")
  # Unique per run, so concurrent runs for the same commit never remove each other's images.
  name="ok-console-recovery-verify-$(basename "$tmp" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9\n' '-')"
  local tag=$name
  mkdir "$tmp/context"
  git -C "$repo_root" archive "$revision" | tar -x -C "$tmp/context"
  local epoch build_mode=${RECOVERY_VERIFY_BUILD_AUTH_MODE:-$EXPECTED_AUTH_MODE}
  epoch=$(git -C "$repo_root" show -s --format=%ct "$revision")
  for n in 1 2; do
    echo "build $n/2 of $revision (auth-mode build argument: $build_mode)"
    SOURCE_DATE_EPOCH=$epoch docker buildx build --no-cache --load --platform linux/amd64 \
      --build-arg "VCS_REF=$revision" \
      --build-arg "VITE_CONSOLE_DATA_MODE=$EXPECTED_DATA_MODE" \
      --build-arg "VITE_CONSOLE_AUTH_MODE=$build_mode" \
      --build-arg "SOURCE_DATE_EPOCH=$epoch" \
      -t "$tag:$n" "$tmp/context" >"$tmp/build-$n.log" 2>&1 || { tail -40 "$tmp/build-$n.log" >&2; fail "build $n failed"; }
  done
  for n in 1 2; do
    [ "$(label "$tag:$n" io.openkubes.console.auth-mode)" = "$EXPECTED_AUTH_MODE" ] \
      || fail "build $n has io.openkubes.console.auth-mode=$(label "$tag:$n" io.openkubes.console.auth-mode), expected $EXPECTED_AUTH_MODE"
    [ "$(label "$tag:$n" io.openkubes.console.data-mode)" = "$EXPECTED_DATA_MODE" ] || fail "build $n has the wrong data-mode label"
    [ "$(label "$tag:$n" org.opencontainers.image.revision)" = "$revision" ] || fail "build $n has the wrong revision label"
  done
  local config1 config2
  config1=$(docker image inspect --format '{{json .Config}}' "$tag:1")
  config2=$(docker image inspect --format '{{json .Config}}' "$tag:2")
  [ "$config1" = "$config2" ] || fail "the two builds have different image configurations"
  for n in 1 2; do
    docker create --name "$name-$n" "$tag:$n" >/dev/null
    mkdir "$tmp/fs-$n"
    for path in /app/dist /app/bff /app/node_modules /app/package.json; do
      docker cp "$name-$n:$path" - | tar -x -C "$tmp/fs-$n"
    done
    # pnpm records install-time timestamps in two bookkeeping files; blank only those fields.
    [ ! -f "$tmp/fs-$n/node_modules/.modules.yaml" ] || sed -i -E 's/^prunedAt: .*/prunedAt: normalised/' "$tmp/fs-$n/node_modules/.modules.yaml"
    [ ! -f "$tmp/fs-$n/node_modules/.pnpm-workspace-state-v1.json" ] \
      || sed -i -E 's/"lastValidatedTimestamp": *[0-9]+/"lastValidatedTimestamp":0/' "$tmp/fs-$n/node_modules/.pnpm-workspace-state-v1.json"
    (cd "$tmp/fs-$n" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0r sha256sum) >"$tmp/content-$n.sha256"
    # Symlink targets, file types and modes too: pnpm resolves dependencies through symlinks.
    (cd "$tmp/fs-$n" && find . -printf '%y %m %p -> %l\n' | LC_ALL=C sort) >"$tmp/tree-$n.txt"
  done
  for required in ./dist/index.html ./bff/server.mjs ./package.json; do
    grep -q "  $required\$" "$tmp/content-1.sha256" || fail "build 1 lacks $required"
  done
  cmp -s "$tmp/content-1.sha256" "$tmp/content-2.sha256" \
    || { { diff "$tmp/content-1.sha256" "$tmp/content-2.sha256" | head -20 >&2; } || true; fail "/app content differs between the two builds"; }
  cmp -s "$tmp/tree-1.txt" "$tmp/tree-2.txt" \
    || { { diff "$tmp/tree-1.txt" "$tmp/tree-2.txt" | head -20 >&2; } || true; fail "/app file types, modes or symlink targets differ between the two builds"; }
  local id1 id2
  id1=$(docker image inspect --format '{{.Id}}' "$tag:1")
  id2=$(docker image inspect --format '{{.Id}}' "$tag:2")
  echo "revision=$revision"
  echo "labels: auth-mode=$EXPECTED_AUTH_MODE data-mode=$EXPECTED_DATA_MODE revision=$revision (both builds)"
  echo "image configuration: identical"
  echo "tree: $(wc -l <"$tmp/tree-1.txt") entries, identical types, modes and symlink targets"
  echo "content: $(wc -l <"$tmp/content-1.sha256") files under /app/{dist,bff,node_modules,package.json}, identical sha256 after blanking pnpm install timestamps ($(sha256sum "$tmp/content-1.sha256" | cut -c1-64))"
  echo "image ids: $id1 $id2 ($([ "$id1" = "$id2" ] && echo identical || echo differ, not gated))"
  echo "PASS (linux/amd64)"
}

verify_registry() {
  local reference=$1 metadata attestation index
  [[ $reference =~ ^[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$ ]] || { echo "the image must be referenced by digest" >&2; exit 2; }
  recovery_record registry "$reference" >/dev/null
  command -v gh >/dev/null 2>&1 || { echo "gh is required for the attestation check" >&2; exit 2; }
  index=$(docker buildx imagetools inspect --raw "$reference") || fail "cannot read registry index for $reference"
  metadata=$(docker buildx imagetools inspect "$reference" --format '{{json .Image}}') || fail "cannot read registry metadata for $reference"
  attestation=$(gh attestation verify "oci://$reference" --repo openkubes/ok-console \
    --signer-workflow openkubes/ok-console/.github/workflows/publish-dev-image.yaml --format json) \
    || fail "no valid publish-dev-image build-provenance attestation for $reference"
  RECOVERY_INDEX=$index RECOVERY_REFERENCE=$reference RECOVERY_METADATA=$metadata RECOVERY_ATTESTATION=$attestation node --input-type=module - "$repo_root" "$script_dir/recovery-image.mjs" <<'EOF'
import { pathToFileURL } from 'node:url'
const [root, modulePath] = process.argv.slice(2)
const { loadExpectedDigests, overlays, requireReleasedRecovery } = await import(pathToFileURL(modulePath).href)
const expected = await loadExpectedDigests(root)
requireReleasedRecovery(expected)
const entry = expected[overlays.bootstrap]
const provenance = entry.provenance
const failures = []
if (process.env.RECOVERY_REFERENCE !== entry.image) failures.push('the reference does not match the provenance image and digest')
const index = JSON.parse(process.env.RECOVERY_INDEX)
if (!['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json'].includes(index?.mediaType) || !Array.isArray(index.manifests)) throw new Error('index must be a manifest list') // guard: registry-index
const actual = {}
for (const descriptor of index.manifests) {
  // Only an annotated unknown/unknown descriptor is excluded from the exact map.
  if (descriptor.annotations?.['vnd.docker.reference.type'] === 'attestation-manifest' && descriptor.platform?.os === 'unknown' && descriptor.platform?.architecture === 'unknown') continue // guard: registry-attestation
  const platform = `${descriptor.platform?.os}/${descriptor.platform?.architecture}${descriptor.platform?.variant ? '/' + descriptor.platform.variant : ''}`
  if (Object.hasOwn(actual, platform)) throw new Error('duplicate runnable index platform') // guard: registry-duplicate
  actual[platform] = descriptor.digest
}
const sorted = (value) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
if (sorted(actual) !== sorted(entry.platforms)) throw new Error('index platform map does not equal recorded platforms') // guard: registry-map
const metadata = JSON.parse(process.env.RECOVERY_METADATA)
const images = metadata?.config ? { single: metadata } : metadata ?? {}
if (Object.keys(images).length === 0) failures.push('no image configuration found')
if (JSON.stringify(Object.keys(images).sort()) !== JSON.stringify(Object.keys(entry.platforms).sort())) throw new Error('configuration platforms do not equal recorded platforms') // guard: registry-configs
for (const [platform, image] of Object.entries(images)) {
  const labels = image?.config?.Labels ?? {}
  if (labels['io.openkubes.console.auth-mode'] !== 'bootstrap') failures.push(`${platform}: auth-mode label is ${labels['io.openkubes.console.auth-mode']}`)
  if (labels['io.openkubes.console.data-mode'] !== 'bff') failures.push(`${platform}: data-mode label is ${labels['io.openkubes.console.data-mode']}`)
  if (labels['org.opencontainers.image.revision'] !== provenance.revision) failures.push(`${platform}: revision label does not match the provenance`)
}
const attested = (JSON.parse(process.env.RECOVERY_ATTESTATION || '[]') ?? []).map((entry) => entry?.verificationResult?.statement?.predicate?.buildDefinition)
const bound = attested.some((build) => build?.externalParameters?.workflow?.repository === 'https://github.com/openkubes/ok-console'
  && build?.externalParameters?.workflow?.ref === `refs/tags/${provenance.releaseTag}`
  && (build?.resolvedDependencies ?? []).some((dependency) => dependency?.digest?.gitCommit === provenance.revision))
if (!bound) failures.push(`no attestation binds the digest to openkubes/ok-console ${provenance.revision} at refs/tags/${provenance.releaseTag}`)
if (failures.length) { for (const failure of failures) console.error(`FAIL: ${failure}`); process.exit(1) }
console.log(`PASS: ${Object.keys(images).join(', ')} carry auth-mode=bootstrap, data-mode=bff, revision=${provenance.revision}; attested by publish-dev-image at refs/tags/${provenance.releaseTag}`)
EOF
}

[ $# -ge 1 ] || usage
case $1 in
  local) [ $# -eq 2 ] || usage; verify_local "$2" ;;
  registry) [ $# -eq 2 ] || usage; verify_registry "$2" ;;
  *) usage ;;
esac
