#!/usr/bin/env bash
# OK-173: verify the bootstrap-built recovery image without publishing anything.
#
#   verify-recovery-image.sh local <git-revision>
#     Builds the recovery image twice, without cache, from a clean `git archive` of one commit
#     (linux/amd64, VITE_CONSOLE_AUTH_MODE=bootstrap, VITE_CONSOLE_DATA_MODE=bff) and asserts:
#     the auth-mode, data-mode and revision labels; an identical image configuration; and
#     identical content hashes of /app/dist and /app/bff. Image IDs are printed for the record;
#     byte-identical layers are not required. Nothing is pushed.
#
#   verify-recovery-image.sh registry <image@sha256:...> [image-provenance.json]
#     Release-time check of a published image: the reference must equal the provenance record,
#     and every platform's configuration must carry auth-mode=bootstrap, data-mode=bff and the
#     recorded revision. Reads registry metadata only.
#
# RECOVERY_VERIFY_BUILD_AUTH_MODE overrides the build argument only (negative control: a
# breakglass build must fail the label check). Exit codes: 0 pass, 1 check failed, 2 usage.
set -euo pipefail

EXPECTED_AUTH_MODE=bootstrap
EXPECTED_DATA_MODE=bff
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$script_dir/../.." && pwd)
default_provenance="$script_dir/overlays/ok-shared-bootstrap-recovery/image-provenance.json"

usage() {
  echo "usage: $0 local <git-revision> | registry <image@sha256:...> [image-provenance.json]" >&2
  exit 2
}
fail() { echo "FAIL: $*" >&2; exit 1; }
label() { docker image inspect --format "{{ index .Config.Labels \"$2\" }}" "$1"; }

verify_local() {
  local revision tmp tag
  revision=$(git -C "$repo_root" rev-parse --verify --quiet "$1^{commit}") || { echo "unknown revision: $1" >&2; exit 2; }
  docker buildx version >/dev/null 2>&1 || { echo "docker buildx is required" >&2; exit 2; }
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/ok-console-recovery-verify.XXXXXX")
  tag="ok-console-recovery-verify:${revision:0:12}"
  cleanup() {
    docker rm -f "${tag//[:]/-}-1" "${tag//[:]/-}-2" >/dev/null 2>&1 || true
    docker image rm -f "$tag-1" "$tag-2" >/dev/null 2>&1 || true
    rm -rf "$tmp"
  }
  trap cleanup EXIT
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
      -t "$tag-$n" "$tmp/context" >"$tmp/build-$n.log" 2>&1 || { tail -40 "$tmp/build-$n.log" >&2; fail "build $n failed"; }
  done
  for n in 1 2; do
    [ "$(label "$tag-$n" io.openkubes.console.auth-mode)" = "$EXPECTED_AUTH_MODE" ] \
      || fail "build $n has io.openkubes.console.auth-mode=$(label "$tag-$n" io.openkubes.console.auth-mode), expected $EXPECTED_AUTH_MODE"
    [ "$(label "$tag-$n" io.openkubes.console.data-mode)" = "$EXPECTED_DATA_MODE" ] || fail "build $n has the wrong data-mode label"
    [ "$(label "$tag-$n" org.opencontainers.image.revision)" = "$revision" ] || fail "build $n has the wrong revision label"
  done
  local config1 config2
  config1=$(docker image inspect --format '{{json .Config}}' "$tag-1")
  config2=$(docker image inspect --format '{{json .Config}}' "$tag-2")
  [ "$config1" = "$config2" ] || fail "the two builds have different image configurations"
  for n in 1 2; do
    docker create --name "${tag//[:]/-}-$n" "$tag-$n" >/dev/null
    mkdir "$tmp/fs-$n"
    for path in /app/dist /app/bff; do
      docker cp "${tag//[:]/-}-$n:$path" - | tar -x -C "$tmp/fs-$n"
    done
    (cd "$tmp/fs-$n" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) >"$tmp/content-$n.sha256"
  done
  [ -s "$tmp/content-1.sha256" ] || fail "no application content was extracted"
  cmp -s "$tmp/content-1.sha256" "$tmp/content-2.sha256" \
    || { diff "$tmp/content-1.sha256" "$tmp/content-2.sha256" | head -20 >&2; fail "/app/dist or /app/bff differs between the two builds"; }
  local id1 id2
  id1=$(docker image inspect --format '{{.Id}}' "$tag-1")
  id2=$(docker image inspect --format '{{.Id}}' "$tag-2")
  echo "revision=$revision"
  echo "labels: auth-mode=$EXPECTED_AUTH_MODE data-mode=$EXPECTED_DATA_MODE revision=$revision (both builds)"
  echo "image configuration: identical"
  echo "content: $(wc -l <"$tmp/content-1.sha256") files under /app/dist and /app/bff, identical sha256 ($(sha256sum "$tmp/content-1.sha256" | cut -c1-64))"
  echo "image ids: $id1 $id2 ($([ "$id1" = "$id2" ] && echo identical || echo differ, not gated))"
  echo "PASS"
}

verify_registry() {
  local reference=$1 provenance=${2:-$default_provenance} metadata
  [[ $reference =~ ^[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$ ]] || { echo "the image must be referenced by digest" >&2; exit 2; }
  [ -f "$provenance" ] || { echo "missing provenance file: $provenance" >&2; exit 2; }
  metadata=$(docker buildx imagetools inspect "$reference" --format '{{json .Image}}') || fail "cannot read registry metadata for $reference"
  RECOVERY_REFERENCE=$reference RECOVERY_METADATA=$metadata node --input-type=module - "$provenance" "$script_dir/recovery-image.mjs" <<'EOF'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
const [provenancePath, modulePath] = process.argv.slice(2)
const { checkRecoveryProvenance } = await import(pathToFileURL(modulePath).href)
const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'))
const checked = checkRecoveryProvenance(provenance)
const failures = checked.state === 'released' ? [] : [`provenance is ${checked.state}: ${checked.errors.join('; ') || 'no released digest recorded'}`]
if (process.env.RECOVERY_REFERENCE !== `${provenance.image}@${provenance.digest}`) failures.push('the reference does not match the provenance image and digest')
const metadata = JSON.parse(process.env.RECOVERY_METADATA)
const images = metadata?.config ? { single: metadata } : metadata ?? {}
if (Object.keys(images).length === 0) failures.push('no image configuration found')
for (const [platform, image] of Object.entries(images)) {
  const labels = image?.config?.Labels ?? {}
  if (labels['io.openkubes.console.auth-mode'] !== 'bootstrap') failures.push(`${platform}: auth-mode label is ${labels['io.openkubes.console.auth-mode']}`)
  if (labels['io.openkubes.console.data-mode'] !== 'bff') failures.push(`${platform}: data-mode label is ${labels['io.openkubes.console.data-mode']}`)
  if (labels['org.opencontainers.image.revision'] !== provenance.revision) failures.push(`${platform}: revision label does not match the provenance`)
}
if (failures.length) { for (const failure of failures) console.error(`FAIL: ${failure}`); process.exit(1) }
console.log(`PASS: ${Object.keys(images).join(', ')} carry auth-mode=bootstrap, data-mode=bff, revision=${provenance.revision}`)
EOF
}

[ $# -ge 1 ] || usage
case $1 in
  local) [ $# -eq 2 ] || usage; verify_local "$2" ;;
  registry) [ $# -ge 2 ] && [ $# -le 3 ] || usage; verify_registry "$2" "${3:-}" ;;
  *) usage ;;
esac
