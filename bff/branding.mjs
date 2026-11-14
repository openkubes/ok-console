// Per-installation branding (white-label foundation).
//
// One codebase, one branding file per deployment. This module is pure (no Node or DOM APIs) so the
// BFF and the Console share a single validator: the BFF refuses to start with an invalid branding
// directory, and the Console falls back to the built-in default if a file is missing or invalid.
// Deliberately not a theme engine: two colours in, a fixed set of derived CSS tokens out.

export const BRANDING_SCHEMA = 'openkubes.console.branding/v1'
export const BRANDING_FILE = 'branding.json'
export const MAX_BRANDING_FILE_BYTES = 16 * 1024
export const MAX_BRANDING_ASSET_BYTES = 256 * 1024
export const BRANDING_ASSET_TYPES = Object.freeze({
  svg: 'image/svg+xml',
  png: 'image/png',
  webp: 'image/webp',
  ico: 'image/x-icon',
})
// A bare file name inside the mounted branding directory: no paths, no URLs, no traversal.
export const BRANDING_ASSET_NAME = /^[a-z0-9][a-z0-9-]{0,62}\.(svg|png|webp|ico)$/
export const MIN_CONTRAST_ON_PRIMARY = 4.5
export const MIN_CONTRAST_ACCENT_ON_DEEP = 4.5

const LIMITS = Object.freeze({
  productName: 40,
  productShortName: 24,
  productTagline: 32,
  alt: 80,
  kicker: 48,
  headlineLine: 32,
  headlineLines: 4,
  text: 240,
  poweredBy: 40,
})

const HEX = /^#[0-9a-fA-F]{6}$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

// Built-in fallback: the unchanged OpenKubes Console identity. `tokens: null` leaves styles.css as is.
export const DEFAULT_BRANDING = Object.freeze({
  source: 'default',
  productName: 'OpenKubes Console',
  productShortName: 'OpenKubes',
  productTagline: 'Platform Console',
  logoUrl: './openkubes-icon.png',
  logoAlt: 'OpenKubes',
  faviconUrl: './openkubes-icon.png',
  colors: Object.freeze({ primary: '#064fc8', accent: '#f28b12' }),
  tokens: null,
  login: Object.freeze({
    kicker: 'Sovereign platform operations',
    headline: Object.freeze(['Contracts.', 'Clusters.', 'Evidence.']),
    text: 'One trusted entry point for platform intent, observed state, and reviewable operations — from local laptop to edge, bare metal, and cloud.',
  }),
  poweredBy: null,
})

const channel = (value) => {
  const c = value / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

const rgb = (hex) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))

export const relativeLuminance = (hex) => {
  const [r, g, b] = rgb(hex).map(channel)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export const contrastRatio = (a, b) => {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

// Linear sRGB-space mix is not needed for a palette this small; channel-wise mixing is predictable.
export const mix = (hex, target, amount) => {
  const from = rgb(hex)
  const to = rgb(target)
  return `#${from.map((v, i) => Math.round(v + (to[i] - v) * amount).toString(16).padStart(2, '0')).join('')}`
}

export const deriveTokens = ({ primary, accent }) => ({
  '--blue': primary,
  '--blue-dark': mix(primary, '#000000', 0.25),
  '--blue-soft': mix(primary, '#ffffff', 0.9),
  '--brand-deep': mix(primary, '#000000', 0.7),
  '--brand-panel': mix(primary, '#000000', 0.45),
  '--brand-bright': primary,
  '--brand-on-deep': mix(primary, '#ffffff', 0.75),
  '--brand-on-deep-faint': mix(primary, '#ffffff', 0.45),
  '--brand-kicker': accent,
  '--brand-emphasis': accent,
  '--accent': accent,
})

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

const unknownKeys = (value, allowed, path, errors) => {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push(`${path}${key}: unknown field`)
}

const text = (value, path, max, errors, required = true) => {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string') { errors.push(`${path}: must be a string`); return undefined }
  const trimmed = value.trim()
  if (!trimmed) errors.push(`${path}: must not be empty`)
  else if (trimmed.length > max) errors.push(`${path}: at most ${max} characters`)
  else if (CONTROL.test(trimmed)) errors.push(`${path}: control characters are not allowed`)
  return trimmed
}

const asset = (value, path, errors) => {
  if (typeof value !== 'string' || !BRANDING_ASSET_NAME.test(value)) {
    errors.push(`${path}: must be a file name in the branding directory (lowercase, .svg/.png/.webp/.ico, no path)`)
    return undefined
  }
  return value
}

const color = (value, path, errors) => {
  if (typeof value !== 'string' || !HEX.test(value)) { errors.push(`${path}: must be a #rrggbb colour`); return undefined }
  return value.toLowerCase()
}

// Validates an untrusted branding document. Returns { ok, value, errors }; never throws.
export const validateBranding = (input) => {
  const errors = []
  if (!isObject(input)) return { ok: false, errors: ['branding: must be a JSON object'] }
  unknownKeys(input, ['schema', 'productName', 'productShortName', 'productTagline', 'logo', 'favicon', 'colors', 'login', 'poweredBy'], '', errors)
  if (input.schema !== BRANDING_SCHEMA) errors.push(`schema: must be "${BRANDING_SCHEMA}"`)

  const value = {
    schema: BRANDING_SCHEMA,
    productName: text(input.productName, 'productName', LIMITS.productName, errors),
    productShortName: text(input.productShortName, 'productShortName', LIMITS.productShortName, errors, false),
    productTagline: text(input.productTagline, 'productTagline', LIMITS.productTagline, errors, false),
  }

  if (!isObject(input.logo)) errors.push('logo: must be an object with file and alt')
  else {
    unknownKeys(input.logo, ['file', 'alt'], 'logo.', errors)
    value.logo = { file: asset(input.logo.file, 'logo.file', errors), alt: text(input.logo.alt, 'logo.alt', LIMITS.alt, errors) }
  }
  value.favicon = asset(input.favicon, 'favicon', errors)

  if (!isObject(input.colors)) errors.push('colors: must be an object with primary and accent')
  else {
    unknownKeys(input.colors, ['primary', 'accent'], 'colors.', errors)
    value.colors = { primary: color(input.colors.primary, 'colors.primary', errors), accent: color(input.colors.accent, 'colors.accent', errors) }
    const { primary, accent } = value.colors
    if (primary && contrastRatio(primary, '#ffffff') < MIN_CONTRAST_ON_PRIMARY) {
      errors.push(`colors.primary: white text on it needs a contrast of at least ${MIN_CONTRAST_ON_PRIMARY}:1 (is ${contrastRatio(primary, '#ffffff').toFixed(2)}:1)`)
    }
    if (primary && accent) {
      const deep = mix(primary, '#000000', 0.7)
      if (contrastRatio(accent, deep) < MIN_CONTRAST_ACCENT_ON_DEEP) {
        errors.push(`colors.accent: needs a contrast of at least ${MIN_CONTRAST_ACCENT_ON_DEEP}:1 on the dark login panel ${deep} (is ${contrastRatio(accent, deep).toFixed(2)}:1)`)
      }
    }
  }

  if (input.login !== undefined) {
    if (!isObject(input.login)) errors.push('login: must be an object')
    else {
      unknownKeys(input.login, ['kicker', 'headline', 'text'], 'login.', errors)
      value.login = {
        kicker: text(input.login.kicker, 'login.kicker', LIMITS.kicker, errors, false),
        text: text(input.login.text, 'login.text', LIMITS.text, errors, false),
      }
      if (input.login.headline !== undefined) {
        if (!Array.isArray(input.login.headline) || input.login.headline.length < 1 || input.login.headline.length > LIMITS.headlineLines) {
          errors.push(`login.headline: must be a list of 1 to ${LIMITS.headlineLines} lines`)
        } else {
          value.login.headline = input.login.headline.map((line, index) => text(line, `login.headline[${index}]`, LIMITS.headlineLine, errors))
        }
      }
    }
  }

  if (input.poweredBy !== undefined) {
    if (!isObject(input.poweredBy)) errors.push('poweredBy: must be an object with name')
    else {
      unknownKeys(input.poweredBy, ['name'], 'poweredBy.', errors)
      value.poweredBy = { name: text(input.poweredBy.name, 'poweredBy.name', LIMITS.poweredBy, errors) }
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, value, errors: [] }
}

// Turns a validated document into what the Console renders. Asset URLs stay same-origin.
export const resolveBranding = (config, assetBase = './branding/') => ({
  source: 'configured',
  productName: config.productName,
  productShortName: config.productShortName ?? config.productName,
  productTagline: config.productTagline ?? DEFAULT_BRANDING.productTagline,
  logoUrl: `${assetBase}${config.logo.file}`,
  logoAlt: config.logo.alt,
  faviconUrl: `${assetBase}${config.favicon}`,
  colors: { ...config.colors },
  tokens: deriveTokens(config.colors),
  login: {
    kicker: config.login?.kicker ?? DEFAULT_BRANDING.login.kicker,
    headline: config.login?.headline ?? [...DEFAULT_BRANDING.login.headline],
    text: config.login?.text ?? DEFAULT_BRANDING.login.text,
  },
  poweredBy: config.poweredBy?.name ?? null,
})

const escapeHtml = (value) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

// Puts a configured brand into index.html before it reaches the browser, so title, favicon and theme
// colour never show the built-in identity while the Console loads.
export const brandIndexHtml = (html, config, assetBase = './branding/') => {
  const favicon = `${assetBase}${config.favicon}`
  const type = config.favicon.endsWith('.svg') ? 'image/svg+xml' : BRANDING_ASSET_TYPES[config.favicon.slice(config.favicon.lastIndexOf('.') + 1)]
  return html
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(config.productName)}</title>`)
    .replace(/<meta name="theme-color" content="[^"]*"\s*\/?>/, `<meta name="theme-color" content="${config.colors.primary}" />`)
    .replace(/<meta name="description" content="[^"]*"\s*\/?>/, `<meta name="description" content="${escapeHtml(config.productName)}" />`)
    .replace(/<link rel="icon"[^>]*>/, `<link rel="icon" type="${type}" href="${escapeHtml(favicon)}" />`)
}
