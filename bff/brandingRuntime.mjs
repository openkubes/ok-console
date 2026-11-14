import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, sep } from 'node:path'
import {
  BRANDING_ASSET_TYPES,
  BRANDING_FILE,
  MAX_BRANDING_ASSET_BYTES,
  MAX_BRANDING_FILE_BYTES,
  validateBranding,
} from './branding.mjs'

// SVG logos are embedded via <img> under a CSP without inline script, so scripts would not run. These
// rules are defence in depth and an early, readable error: no active content, no entity expansion, no
// external or embedded resources. Internal fragment references (url(#id), href="#id") stay allowed.
const SVG_ROOT = /^\uFEFF?\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i
const UNSAFE_SVG = [
  [/<script|<foreignobject|<iframe|<embed|<object|<audio|<video/i, 'scripts or embedded content'],
  [/<!doctype|<!entity/i, 'DOCTYPE or entity declarations'],
  [/\son[a-z]+\s*=/i, 'event handlers'],
  [/javascript:|data:|@import/i, 'script URLs, data URLs or style imports'],
  [/(?:xlink:)?href\s*=\s*["']\s*(?!#)/i, 'external references'],
  [/url\(\s*["']?\s*(?!#)/i, 'external references'],
  [/xml:base/i, 'xml:base'],
]

const SIGNATURES = {
  png: (bytes) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  webp: (bytes) => bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP',
  ico: (bytes) => bytes.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0])),
}

export class BrandingConfigurationError extends Error {
  constructor(problems) {
    super(`Invalid branding configuration:\n- ${problems.join('\n- ')}`)
    this.name = 'BrandingConfigurationError'
    this.problems = problems
  }
}

const fail = (problem) => { throw new BrandingConfigurationError([problem]) }

// Resolves a name inside the branding directory. Symlinks are followed (Kubernetes ConfigMap and Secret
// mounts consist of them) but the real target must stay inside the real directory.
const readContained = async (realDir, dir, name, max, label, io) => {
  let real
  try { real = await io.realpath(join(dir, name)) } catch { fail(`${label}: file not found`) }
  if (!real.startsWith(`${realDir}${sep}`)) fail(`${label}: resolves outside the branding directory`)
  const metadata = await io.stat(real)
  if (!metadata.isFile()) fail(`${label}: not a regular file`)
  if (metadata.size < 1 || metadata.size > max) fail(`${label}: size must be between 1 and ${max} bytes`)
  const bytes = await io.readFile(real)
  if (bytes.length !== metadata.size) fail(`${label}: changed while reading`)
  return bytes
}

export const inspectBrandingAsset = (name, bytes) => {
  const extension = name.slice(name.lastIndexOf('.') + 1)
  if (extension !== 'svg') return SIGNATURES[extension](bytes) ? [] : [`content is not a ${extension.toUpperCase()} image`]
  const text = bytes.toString('utf8')
  if (!SVG_ROOT.test(text)) return ['content is not an SVG document']
  return UNSAFE_SVG.filter(([pattern]) => pattern.test(text)).map(([, reason]) => `SVG must not contain ${reason}`)
}

// Checks a mounted branding directory once at startup and returns an immutable snapshot of exactly the
// validated files ({ branding, assets }), or null when branding is not configured. Throws
// BrandingConfigurationError (fail closed): an operator who configured a brand must not silently get
// a different one.
export const loadBrandingDirectory = async (dir, io = { readFile, realpath, stat }) => {
  if (dir === undefined || dir === '') return null
  if (!isAbsolute(dir)) fail('OK_CONSOLE_BRANDING_DIR must be an absolute path')
  let realDir
  try { realDir = await io.realpath(dir) } catch { fail('OK_CONSOLE_BRANDING_DIR: directory not found') }
  if (!(await io.stat(realDir)).isDirectory()) fail('OK_CONSOLE_BRANDING_DIR: not a directory')

  const raw = await readContained(realDir, dir, BRANDING_FILE, MAX_BRANDING_FILE_BYTES, BRANDING_FILE, io)
  let document
  try { document = JSON.parse(raw.toString('utf8')) } catch { fail(`${BRANDING_FILE}: not valid JSON`) }
  const result = validateBranding(document)
  if (!result.ok) throw new BrandingConfigurationError(result.errors)

  const assets = new Map()
  const problems = []
  for (const [label, name] of [['logo.file', result.value.logo.file], ['favicon', result.value.favicon]]) {
    if (assets.has(name)) continue
    const where = `${label} (${name})`
    try {
      const bytes = await readContained(realDir, dir, name, MAX_BRANDING_ASSET_BYTES, where, io)
      const findings = inspectBrandingAsset(name, bytes)
      if (findings.length) problems.push(...findings.map((finding) => `${where}: ${finding}`))
      else assets.set(name, { body: bytes, contentType: BRANDING_ASSET_TYPES[name.slice(name.lastIndexOf('.') + 1)] })
    } catch (error) {
      if (error instanceof BrandingConfigurationError) problems.push(...error.problems)
      else throw error
    }
  }
  if (problems.length) throw new BrandingConfigurationError(problems)
  return Object.freeze({ branding: result.value, assets })
}
