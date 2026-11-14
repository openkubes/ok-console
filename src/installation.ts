import { INSTALLATION_ELEMENT_ID, INSTALLATION_SCHEMA } from '../bff/installation.mjs'
import { DEFAULT_BRANDING, resolveBrandingValue, type BrandingLoadResult } from './branding/branding'
import { DEFAULT_DEPLOYMENT_POLICY, READ_ONLY_UNKNOWN, resolveDeploymentPolicyValue, type ConsoleDeploymentPolicy } from './deploymentPolicy'

export type Installation = { branding: BrandingLoadResult; policy: ConsoleDeploymentPolicy }

// Reads the installation data the BFF (or the dev server) put into index.html. Synchronous, so the Console
// renders as early as before. No data block: static hosting without the BFF, built-in behaviour. A block
// that cannot be read fails closed: branding failure screen, read-only policy.
export function readInstallation(doc: Document = document): Installation {
  const element = doc.getElementById(INSTALLATION_ELEMENT_ID)
  if (!element) return { branding: { branding: DEFAULT_BRANDING, status: 'absent', errors: [] }, policy: DEFAULT_DEPLOYMENT_POLICY }
  let data: { schema?: unknown; branding?: unknown; deploymentPolicy?: unknown }
  try {
    data = JSON.parse(element.textContent ?? '')
  } catch {
    data = {}
  }
  if (data?.schema !== INSTALLATION_SCHEMA) {
    return { branding: { branding: DEFAULT_BRANDING, status: 'invalid', errors: ['installation data unreadable'] }, policy: READ_ONLY_UNKNOWN }
  }
  return { branding: resolveBrandingValue(data.branding), policy: resolveDeploymentPolicyValue(data.deploymentPolicy) }
}
