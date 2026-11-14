import { loadBrandingDirectory } from './brandingRuntime.mjs'
import { resolveDeploymentPolicy } from './deploymentPolicy.mjs'
import { injectInstallation, installationDocument } from './installation.mjs'

const BRANDING_ASSET_PATH = /^\/branding\/([a-z0-9][a-z0-9-]{0,62}\.(?:svg|png|webp|ico))(?:\?.*)?$/

// Vite plugin for the dev server (`vite`): injects the same installation data block into index.html as
// the BFF and serves the validated branding assets, from the same variables (OK_CONSOLE_BRANDING_DIR,
// OK_CONSOLE_DEPLOYMENT_POLICY), re-read on every request. Where the BFF refuses to start, the dev server
// passes the problems to the Console instead, which then fails closed (failure screen, read-only).
export const installationFilesPlugin = (env = process.env) => {
  const loadBranding = () => loadBrandingDirectory(env.OK_CONSOLE_BRANDING_DIR)
  const middleware = (request, response, next) => {
    if (!request.url?.startsWith('/branding/')) return next()
    const match = BRANDING_ASSET_PATH.exec(request.url)
    loadBranding().then((snapshot) => {
      const entry = match && snapshot?.assets.get(match[1])
      if (!entry) {
        response.statusCode = 404
        response.end('Not found.')
        return
      }
      response.setHeader('Content-Type', entry.contentType)
      response.setHeader('Cache-Control', 'no-cache')
      response.end(entry.body)
    }, () => {
      response.statusCode = 404
      response.end('Not found.')
    })
  }
  return {
    name: 'ok-console-installation-files',
    // Dev server only: a build must never bake installation data into the image.
    apply: 'serve',
    configureServer: (server) => { server.middlewares.use(middleware) },
    transformIndexHtml: async (html) => {
      const input = {}
      try { input.deploymentPolicy = resolveDeploymentPolicy(env) } catch (error) { input.policyErrors = error.problems ?? [String(error)] }
      try { input.branding = (await loadBranding())?.branding ?? null } catch (error) { input.brandingErrors = error.problems ?? [String(error)] }
      return injectInstallation(html, installationDocument(input))
    },
  }
}
