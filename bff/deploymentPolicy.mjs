// Deployment policy: one explicit setting, independent of branding.
//
//   OK_CONSOLE_DEPLOYMENT_POLICY unset         built-in behaviour, unchanged
//   OK_CONSOLE_DEPLOYMENT_POLICY=fixture-read-only
//       fixture data only, always read-only: no cluster create/register, no live cluster access,
//       no dry-run runner, no write APIs except signing in and out.
//
// Not a feature-flag system: there is exactly one non-default value. Anything else, and any setting that
// contradicts the policy, stops the BFF before it listens (fail closed).

export const DEPLOYMENT_POLICY_FIXTURE_READ_ONLY = 'fixture-read-only'
const API_ROOT = '/api/console/v0'
// The only state-changing requests allowed under fixture-read-only: signing in, refreshing and ending a
// session. Exact method and exact path, as routed in bff/security/*. Everything else that is not GET/HEAD,
// including any auth or identity endpoint added later, is refused by default.
export const AUTHENTICATION_WRITES = Object.freeze([
  Object.freeze({ method: 'POST', path: `${API_ROOT}/auth/local` }), // exceptional local sign-in (localAccessHttp)
  Object.freeze({ method: 'POST', path: `${API_ROOT}/local-identity/login` }), // local identity sign-in (localIdentityHttp)
  Object.freeze({ method: 'POST', path: `${API_ROOT}/auth/session/rotate` }), // session refresh (httpSession)
  Object.freeze({ method: 'DELETE', path: `${API_ROOT}/auth/session` }), // sign-out (httpSession)
])

export class DeploymentPolicyError extends Error {
  constructor(problems) {
    super(`Invalid deployment policy configuration:\n- ${problems.join('\n- ')}`)
    this.name = 'DeploymentPolicyError'
    this.problems = problems
  }
}

// Returns null for the default, or the frozen fixture-read-only policy. Throws DeploymentPolicyError.
export const resolveDeploymentPolicy = (env = {}) => {
  const value = env.OK_CONSOLE_DEPLOYMENT_POLICY
  if (value === undefined) return null
  if (value !== DEPLOYMENT_POLICY_FIXTURE_READ_ONLY) {
    throw new DeploymentPolicyError([`OK_CONSOLE_DEPLOYMENT_POLICY must be unset or "${DEPLOYMENT_POLICY_FIXTURE_READ_ONLY}" (is "${value}")`])
  }
  const problems = []
  if ((env.OK_CONSOLE_OBSERVED_STATE_MODE ?? 'fixture') !== 'fixture') problems.push('OK_CONSOLE_OBSERVED_STATE_MODE must be "fixture": the policy forbids live cluster access')
  if (env.OK_CONSOLE_DRY_RUN_URL !== undefined) problems.push('OK_CONSOLE_DRY_RUN_URL must not be set: the policy forbids a dry-run runner')
  if (problems.length) throw new DeploymentPolicyError(problems)
  return Object.freeze({ name: DEPLOYMENT_POLICY_FIXTURE_READ_ONLY, clusterLifecycle: false, liveClusterAccess: false, writeApis: false })
}

// Server-side enforcement for API requests. Cluster operations are refused for every method. GET and
// HEAD stay available: every existing GET route only projects source.readSnapshot() (audited in
// deploymentPolicy.test.ts against the real BFF). Any other method needs an exact allowlist entry; the raw
// path must match, so encoded or differently spelled variants are refused too.
export const deploymentPolicyAllows = (policy, method, pathname) => {
  if (!policy) return true
  let path
  try { path = decodeURIComponent(pathname).toLowerCase() } catch { return false }
  if (/\/operations(?:\/|$)/.test(path)) return false
  if (method === 'GET' || method === 'HEAD') return true
  return AUTHENTICATION_WRITES.some((entry) => entry.method === method && entry.path === pathname)
}

// What the Console reads at startup to label the UI. The server enforces the policy either way.
export const deploymentPolicyDocument = (policy) => ({
  schema: 'openkubes.console.deployment-policy/v1',
  policy: policy?.name ?? 'default',
  clusterLifecycle: policy ? policy.clusterLifecycle : true,
})
