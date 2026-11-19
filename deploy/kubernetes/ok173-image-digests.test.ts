// @vitest-environment node

import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// OK-173 AC9 (repository side): every rendered deployable overlay references images only by
// immutable digest. local-kind is the one exception: it loads a locally built, tag-addressed image
// into a disposable kind cluster and is never applied to a shared environment.
const LOCAL_ONLY = new Set(['local-kind'])
const overlaysDir = new URL('./overlays/', import.meta.url)
const DIGEST_REFERENCE = /^[a-z0-9][a-z0-9._/:-]*@sha256:[a-f0-9]{64}$/

export const mutableImageReferences = (rendered: string) => [...rendered.matchAll(/^\s*(?:-\s+)?image:\s*["']?([^"'\s]+)["']?\s*$/gm)]
  .map((match) => match[1])
  .filter((reference) => !DIGEST_REFERENCE.test(reference))

const render = (overlay: string) => execFileSync('kubectl', ['kustomize', new URL(`${overlay}/`, overlaysDir).pathname], { encoding: 'utf8' })

describe('OK-173 immutable image references', () => {
  const overlays = readdirSync(overlaysDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !LOCAL_ONLY.has(entry.name))
    .map((entry) => entry.name)

  it('finds the deployable overlays it is meant to guard', () => {
    expect(overlays).toEqual(expect.arrayContaining(['ok-shared-live', 'ok-shared-breakglass', 'ok-shared-bootstrap-recovery']))
  })

  it.each(overlays)('renders %s with digest-pinned images only', (overlay) => {
    const rendered = render(overlay)
    expect(rendered).toMatch(/^\s*(?:-\s+)?image:/m)
    expect(mutableImageReferences(rendered)).toEqual([])
  })

  it('rejects tags, truncated digests and digest-less names', () => {
    const rendered = [
      'image: ghcr.io/openkubes/ok-console:v1.2.3',
      '- image: ghcr.io/openkubes/ok-console@sha256:705edc32',
      'image: "postgres"',
      'image: ghcr.io/openkubes/ok-console@sha256:705edc32be35c935d25414c790cc648649ab3aa3ace24f42423510e3a9e8ccbc',
    ].join('\n')
    expect(mutableImageReferences(rendered)).toEqual(['ghcr.io/openkubes/ok-console:v1.2.3', 'ghcr.io/openkubes/ok-console@sha256:705edc32', 'postgres'])
  })
})
