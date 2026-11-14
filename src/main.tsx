import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { applyBrandingToDocument, applyNeutralDocument, brandingFailed } from './branding/branding'
import { BrandingProvider } from './branding/BrandingContext'
import BrandingFailure from './branding/BrandingFailure'
import { DeploymentPolicyProvider } from './deploymentPolicy'
import { readInstallation } from './installation'
import './styles.css'

const root = createRoot(document.getElementById('root')!)
const { branding: { branding, status, errors }, policy } = readInstallation()

if (brandingFailed(status)) {
  console.error(`Branding ${status}: the Console is not shown with a different brand.`, errors)
  applyNeutralDocument()
  root.render(<BrandingFailure errors={errors} onRetry={() => window.location.reload()}/>)
} else {
  applyBrandingToDocument(branding)
  root.render(
    <StrictMode>
      <DeploymentPolicyProvider policy={policy}>
        <BrandingProvider branding={branding}>
          <App />
        </BrandingProvider>
      </DeploymentPolicyProvider>
    </StrictMode>,
  )
}
