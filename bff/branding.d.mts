export type BrandingColors = { primary: string; accent: string }

export type BrandingDocument = {
  schema: 'openkubes.console.branding/v1'
  productName: string
  productShortName?: string
  productTagline?: string
  logo: { file: string; alt: string }
  favicon: string
  colors: BrandingColors
  login?: { kicker?: string; headline?: string[]; text?: string }
  poweredBy?: { name: string }
}

export type ResolvedBranding = {
  source: 'default' | 'configured'
  productName: string
  productShortName: string
  productTagline: string
  logoUrl: string
  logoAlt: string
  faviconUrl: string
  colors: BrandingColors
  tokens: Record<string, string> | null
  login: { kicker: string; headline: readonly string[]; text: string }
  poweredBy: string | null
}

export type BrandingValidation =
  | { ok: true; value: BrandingDocument; errors: [] }
  | { ok: false; value?: undefined; errors: string[] }

export declare const BRANDING_SCHEMA: 'openkubes.console.branding/v1'
export declare const BRANDING_FILE: 'branding.json'
export declare const MAX_BRANDING_FILE_BYTES: number
export declare const MAX_BRANDING_ASSET_BYTES: number
export declare const BRANDING_ASSET_TYPES: Readonly<Record<'svg' | 'png' | 'webp' | 'ico', string>>
export declare const BRANDING_ASSET_NAME: RegExp
export declare const MIN_CONTRAST_ON_PRIMARY: number
export declare const MIN_CONTRAST_ACCENT_ON_DEEP: number
export declare const DEFAULT_BRANDING: ResolvedBranding
export declare function relativeLuminance(hex: string): number
export declare function contrastRatio(a: string, b: string): number
export declare function mix(hex: string, target: string, amount: number): string
export declare function deriveTokens(colors: BrandingColors): Record<string, string>
export declare function validateBranding(input: unknown): BrandingValidation
export declare function resolveBranding(config: BrandingDocument, assetBase?: string): ResolvedBranding
export declare function brandIndexHtml(html: string, config: BrandingDocument, assetBase?: string): string
