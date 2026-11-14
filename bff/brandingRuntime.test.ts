// @vitest-environment node

import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { BrandingConfigurationError, inspectBrandingAsset, loadBrandingDirectory } from './brandingRuntime.mjs'

const fixture = fileURLToPath(new URL('../src/branding/test-fixtures/example/', import.meta.url))
const dirs: string[] = []
const brandDir = (mutate?: (dir: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), 'ok-branding-'))
  dirs.push(dir)
  copyFileSync(join(fixture, 'branding.json'), join(dir, 'branding.json'))
  copyFileSync(join(fixture, 'example-mark.svg'), join(dir, 'example-mark.svg'))
  mutate?.(dir)
  return dir
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const failure = async (dir: string) => {
  const error = await loadBrandingDirectory(dir).catch((caught) => caught)
  expect(error).toBeInstanceOf(BrandingConfigurationError)
  return (error as BrandingConfigurationError).message
}

describe('branding directory startup check (fail closed)', () => {
  it('is a no-op when branding is not configured', async () => {
    expect(await loadBrandingDirectory(undefined)).toBeNull()
    expect(await loadBrandingDirectory('')).toBeNull()
  })

  it('accepts a valid directory and returns an in-memory snapshot of exactly the validated files', async () => {
    const dir = brandDir((d) => writeFileSync(join(d, 'unreferenced.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>'))
    const result = await loadBrandingDirectory(dir)
    expect(result?.branding.productName).toBe('Example Ops Console')
    expect([...result!.assets.keys()]).toEqual(['example-mark.svg'])
    expect(result!.assets.get('example-mark.svg')?.contentType).toBe('image/svg+xml')
  })

  it('accepts a Kubernetes ConfigMap-style mount whose files are symlinks inside the directory', async () => {
    const dir = brandDir((d) => {
      mkdirSync(join(d, '..2026_11_14_10_00_00.1'))
      for (const name of ['branding.json', 'example-mark.svg']) renameSync(join(d, name), join(d, '..2026_11_14_10_00_00.1', name))
      symlinkSync('..2026_11_14_10_00_00.1', join(d, '..data'))
      for (const name of ['branding.json', 'example-mark.svg']) symlinkSync(join('..data', name), join(d, name))
    })
    expect((await loadBrandingDirectory(dir))?.branding.productName).toBe('Example Ops Console')
  })

  it('rejects files that resolve outside the branding directory', async () => {
    const outside = brandDir()
    const dir = brandDir((d) => { rmSync(join(d, 'example-mark.svg')); symlinkSync(join(outside, 'example-mark.svg'), join(d, 'example-mark.svg')) })
    expect(await failure(dir)).toMatch(/example-mark.svg\): resolves outside the branding directory/)
    const json = brandDir((d) => { rmSync(join(d, 'branding.json')); symlinkSync(join(outside, 'branding.json'), join(d, 'branding.json')) })
    expect(await failure(json)).toMatch(/branding.json: resolves outside/)
  })

  it('rejects a missing directory', async () => {
    expect(await failure('/nonexistent/ok-branding')).toMatch(/directory not found/)
  })

  it('rejects a relative path', async () => {
    expect(await failure('branding/example')).toMatch(/absolute path/)
  })

  it('rejects an invalid document with every problem listed', async () => {
    const dir = brandDir((d) => writeFileSync(join(d, 'branding.json'), JSON.stringify({ schema: 'x', productName: '', colors: {} })))
    const message = await failure(dir)
    expect(message).toMatch(/schema:/)
    expect(message).toMatch(/productName: must not be empty/)
    expect(message).toMatch(/colors.primary/)
  })

  it('rejects malformed JSON, missing assets, directories and oversized assets', async () => {
    expect(await failure(brandDir((d) => writeFileSync(join(d, 'branding.json'), '{')))).toMatch(/not valid JSON/)
    expect(await failure(brandDir((d) => rmSync(join(d, 'example-mark.svg'))))).toMatch(/example-mark.svg\): file not found/)
    expect(await failure(brandDir((d) => { rmSync(join(d, 'example-mark.svg')); mkdirSync(join(d, 'example-mark.svg')) }))).toMatch(/not a regular file/)
    expect(await failure(brandDir((d) => writeFileSync(join(d, 'example-mark.svg'), Buffer.alloc(300 * 1024, 32))))).toMatch(/size must be between/)
  })

  it.each([
    ['a script', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', /scripts or embedded content/],
    ['an event handler', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', /event handlers/],
    ['an external reference', '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://tracker.example/p.png"/></svg>', /external references/],
    ['an external CSS url', '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(https://x.example/a)"/></svg>', /external references/],
    ['a data URL', '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,AAAA"/></svg>', /data URLs/],
    ['foreign HTML', '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div/></foreignObject></svg>', /scripts or embedded content/],
    ['an entity declaration', '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaa">]><svg xmlns="http://www.w3.org/2000/svg">&a;</svg>', /content is not an SVG document/],
    ['an HTML document', '<!doctype html><html><body><svg/></body></html>', /content is not an SVG document/],
  ])('rejects an SVG logo with %s', async (_name, svg, reason) => {
    expect(await failure(brandDir((d) => writeFileSync(join(d, 'example-mark.svg'), svg)))).toMatch(reason)
  })

  it('accepts internal fragment references and checks raster signatures', () => {
    expect(inspectBrandingAsset('mark.svg', Buffer.from('<?xml version="1.0"?>\n<!-- logo --><svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"/></defs><rect fill="url(#g)"/><use href="#g"/></svg>'))).toEqual([])
    expect(inspectBrandingAsset('mark.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toEqual([])
    expect(inspectBrandingAsset('mark.png', Buffer.from('<html>not a png</html>'))).toEqual(['content is not a PNG image'])
    expect(inspectBrandingAsset('mark.webp', Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toEqual([])
    expect(inspectBrandingAsset('mark.ico', Buffer.from([0, 0, 1, 0, 1]))).toEqual([])
    expect(inspectBrandingAsset('mark.ico', Buffer.from('GIF89a'))).toEqual(['content is not a ICO image'])
  })
})
