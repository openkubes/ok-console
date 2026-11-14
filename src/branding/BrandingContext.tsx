import { createContext, useContext, type ReactNode } from 'react'
import { DEFAULT_BRANDING, type ResolvedBranding } from './branding'

const BrandingContext = createContext<ResolvedBranding>(DEFAULT_BRANDING)

export function BrandingProvider({ branding, children }: { branding: ResolvedBranding; children: ReactNode }) {
  return <BrandingContext.Provider value={branding}>{children}</BrandingContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export const useBranding = () => useContext(BrandingContext)

// Wording for generic product references. A configured (white-label) brand gets neutral terms; real
// technical names (distribution, identity provider, API kinds) are never rewritten.
// eslint-disable-next-line react-refresh/only-export-components
export const useBrandTerms = () => {
  const branding = useBranding()
  const whiteLabel = branding.source === 'configured'
  return {
    whiteLabel,
    platformNoun: whiteLabel ? 'Kubernetes' : 'OpenKubes',
    assistantName: whiteLabel ? 'AI' : 'OK AI',
    authorityName: whiteLabel ? branding.productShortName : 'OpenKubes',
  }
}

export function PoweredBy({ className }: { className?: string }) {
  const { poweredBy } = useBranding()
  if (!poweredBy) return null
  return <p className={`powered-by ${className ?? ''}`.trim()}>Powered by <strong>{poweredBy}</strong></p>
}
