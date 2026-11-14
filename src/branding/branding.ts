import {
  DEFAULT_BRANDING,
  resolveBranding,
  validateBranding,
  type ResolvedBranding,
} from '../../bff/branding.mjs'

export { DEFAULT_BRANDING, type ResolvedBranding }

export type BrandingStatus = 'absent' | 'configured' | 'invalid'
export type BrandingLoadResult = { branding: ResolvedBranding; status: BrandingStatus; errors: string[] }

const fallback = (status: BrandingStatus, errors: string[] = []): BrandingLoadResult => ({ branding: DEFAULT_BRANDING, status, errors })

// Interprets the branding part of the installation data (bff/installation.mjs). Never throws.
//   null                      nothing configured: built-in default
//   valid branding document   configured
//   anything else             invalid: fail closed, the Console must not silently show a different brand
export function resolveBrandingValue(value: unknown, base = './branding/'): BrandingLoadResult {
  if (value === null || value === undefined) return fallback('absent')
  if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && Array.isArray((value as { errors?: unknown }).errors)) {
    return fallback('invalid', (value as { errors: unknown[] }).errors.map(String))
  }
  const result = validateBranding(value)
  if (!result.ok) return fallback('invalid', result.errors)
  return { branding: resolveBranding(result.value, base), status: 'configured', errors: [] }
}

export const brandingFailed = (status: BrandingStatus) => status === 'invalid'

// Neutral state for a failed configured brand: no product name, no logo, no favicon.
export function applyNeutralDocument(doc: Document = document) {
  doc.title = 'Console unavailable'
  doc.querySelector('link[rel="icon"]')?.setAttribute('href', 'data:,')
  doc.querySelector('meta[name="description"]')?.setAttribute('content', 'Console')
  doc.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#ffffff')
}

const setMeta = (doc: Document, name: string, content: string) => {
  doc.querySelector(`meta[name="${name}"]`)?.setAttribute('content', content)
}

// Applies a configured brand to the document: CSS tokens via CSSOM (allowed by style-src 'self'),
// favicon, theme colour and the base title. The default brand leaves index.html and styles.css as they are.
export function applyBrandingToDocument(branding: ResolvedBranding, doc: Document = document) {
  if (branding.source !== 'configured' || !branding.tokens) return
  const root = doc.documentElement
  for (const [token, value] of Object.entries(branding.tokens)) root.style.setProperty(token, value)
  root.dataset.brand = 'configured'
  doc.querySelector('link[rel="icon"]')?.setAttribute('href', branding.faviconUrl)
  doc.querySelector('link[rel="icon"]')?.setAttribute('type', branding.faviconUrl.endsWith('.svg') ? 'image/svg+xml' : 'image/png')
  setMeta(doc, 'theme-color', branding.colors.primary)
  setMeta(doc, 'description', branding.productName)
  doc.title = branding.productName
}
