#!/bin/sh
# Community Preview only. Requires Docker and Git. No cluster or backend.
set -eu
for tool in docker git mktemp; do
  if ! command -v "$tool" >/dev/null 2>&1; then echo "Missing prerequisite: $tool" >&2; exit 1; fi
done
if ! docker info >/dev/null 2>&1; then echo "Docker daemon is not available" >&2; exit 1; fi
ref="${OK_CONSOLE_REF:-community-preview-2026-10-24}"
case "$ref" in *[!a-zA-Z0-9._/-]*|'') echo "Invalid OK_CONSOLE_REF" >&2; exit 1;; esac
port="${OK_CONSOLE_PORT:-8787}"
case "$port" in *[!0-9]*|'') echo "Invalid OK_CONSOLE_PORT" >&2; exit 1;; esac
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
echo "Fetching OpenKubes Console ($ref)..."
git clone --quiet --depth 1 --branch "$ref" https://github.com/openkubes/ok-console.git "$tmp/ok-console"
echo "Building local fixture-only preview..."
docker build --file "$tmp/ok-console/Dockerfile.preview" --tag ok-console-preview:local "$tmp/ok-console"
if docker container inspect ok-console-preview >/dev/null 2>&1; then
  echo "Existing container ok-console-preview found. Stop/remove it explicitly before reinstalling." >&2
  exit 1
fi
docker run --detach --name ok-console-preview --publish "127.0.0.1:$port:8787" --security-opt no-new-privileges --cap-drop ALL ok-console-preview:local >/dev/null
echo "Open http://127.0.0.1:$port"
echo "Stop: docker stop ok-console-preview"
echo "Remove: docker rm ok-console-preview"
