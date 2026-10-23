#!/bin/sh
# Community Preview only. Requires Docker and Git. No cluster or backend.
set -eu
name=ok-console-preview
url=http://127.0.0.1:${OK_CONSOLE_PORT:-8787}
for tool in docker git mktemp curl; do
  if ! command -v "$tool" >/dev/null 2>&1; then echo "Missing prerequisite: $tool" >&2; exit 1; fi
done
if ! docker info >/dev/null 2>&1; then echo "Docker daemon is not available" >&2; exit 1; fi
ref="${OK_CONSOLE_REF:-community-preview-2026-10-24}"
case "$ref" in *[!a-zA-Z0-9._/-]*|'') echo "Invalid OK_CONSOLE_REF" >&2; exit 1;; esac
port="${OK_CONSOLE_PORT:-8787}"
case "$port" in *[!0-9]*|'') echo "Invalid OK_CONSOLE_PORT" >&2; exit 1;; esac
if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then echo "Invalid port" >&2; exit 1; fi
healthy() { curl --silent --fail --max-time 2 --output /dev/null "$url/"; }
ready() {
  i=0
  while [ "$i" -lt 20 ]; do
    if healthy; then echo "Open $url"; return 0; fi
    sleep 1
    i=$((i + 1))
  done
  echo "Console did not become healthy. Logs:" >&2
  docker logs --tail 40 "$name" >&2 || true
  return 1
}
if docker container inspect "$name" >/dev/null 2>&1; then
  state="$(docker inspect --format '{{.State.Status}}' "$name")"
  if [ "$state" = running ]; then
    if healthy; then echo "Console is already running at $url"; exit 0; fi
    echo "Container is running but Console is not reachable at $url. Inspect Docker port mappings and logs." >&2
    docker logs --tail 40 "$name" >&2 || true
    exit 1
  fi
  echo "Existing stopped container ($state) detected. Will not delete or replace it automatically." >&2
  echo "Inspect: docker logs $name" >&2
  echo "To replace after review: docker rm $name" >&2
  exit 1
fi
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
echo "Fetching OpenKubes Console ($ref)..."
git clone --quiet --depth 1 --branch "$ref" https://github.com/openkubes/ok-console.git "$tmp/ok-console"
echo "Building local fixture-only preview..."
docker build --file "$tmp/ok-console/Dockerfile.preview" --tag ok-console-preview:local "$tmp/ok-console"
docker run --detach --name "$name" --publish "127.0.0.1:$port:8787" --security-opt no-new-privileges --cap-drop ALL ok-console-preview:local >/dev/null
ready
echo "Stop: docker stop $name"
echo "Remove: docker rm $name"
