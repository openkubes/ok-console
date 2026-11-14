import type { BrandingDocument } from './branding.mjs'
import type { DeploymentPolicy, DeploymentPolicyDocument } from './deploymentPolicy.mjs'

export type InstallationDocument = {
  schema: 'openkubes.console.installation/v1'
  branding: BrandingDocument | { errors: string[] } | null
  deploymentPolicy: DeploymentPolicyDocument | { errors: string[] }
}
export declare const INSTALLATION_SCHEMA: 'openkubes.console.installation/v1'
export declare const INSTALLATION_ELEMENT_ID: 'ok-console-installation'
export declare function installationDocument(input?: { branding?: BrandingDocument | null; deploymentPolicy?: DeploymentPolicy | null; brandingErrors?: string[] | null; policyErrors?: string[] | null }): InstallationDocument
export declare function injectInstallation(html: string, installation: InstallationDocument): string
