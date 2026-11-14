import { brandIndexHtml } from './branding.mjs'
import { deploymentPolicyDocument } from './deploymentPolicy.mjs'

// Per-installation data travels inside index.html as a non-executable JSON data block, so the Console can
// read it synchronously and renders as early as without any configuration: no extra request, no timing
// gap, no window in which a different brand or more permissions could show.
export const INSTALLATION_SCHEMA = 'openkubes.console.installation/v1'
export const INSTALLATION_ELEMENT_ID = 'ok-console-installation'

// branding: null (not configured) | validated branding document | { errors } (dev server only; the BFF
// refuses to start instead). deploymentPolicy: policy document | { errors } (dev server only).
export const installationDocument = ({ branding = null, deploymentPolicy = null, brandingErrors = null, policyErrors = null } = {}) => ({
  schema: INSTALLATION_SCHEMA,
  branding: brandingErrors ? { errors: brandingErrors } : branding,
  deploymentPolicy: policyErrors ? { errors: policyErrors } : deploymentPolicyDocument(deploymentPolicy),
})

// JSON that cannot end the script element or start markup inside it.
const scriptSafeJson = (value) => JSON.stringify(value)
  .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
  .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')

const EXISTING_BLOCK = new RegExp(`\\s*<script type="application/json" id="${INSTALLATION_ELEMENT_ID}">[^<]*</script>`, 'g')

// Replaces any block already present, so only the server's own data can reach the Console.
export const injectInstallation = (html, installation) => {
  html = html.replace(EXISTING_BLOCK, '')
  const branded = installation.branding && !installation.branding.errors ? brandIndexHtml(html, installation.branding) : html
  const block = `<script type="application/json" id="${INSTALLATION_ELEMENT_ID}">${scriptSafeJson(installation)}</script>`
  if (branded.includes('</head>')) return branded.replace('</head>', () => `  ${block}\n  </head>`)
  // No head element: the block works anywhere, as the Console reads it after parsing.
  return `${block}\n${branded}`
}
