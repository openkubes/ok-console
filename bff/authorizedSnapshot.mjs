import { ConsoleBffError } from './contract.mjs'

const METRICS = {
  capabilities: ['total', 'ready', 'pending', 'failed', 'unknown'],
  workloadClaims: ['total', 'ready', 'pending', 'failed', 'unknown'],
  openFindings: ['total', 'critical'],
}

// Work exclusively on the adapter's validated graph, before any presentation lookup or aggregate.
export const authorizedSnapshot = (snapshot, scope) => {
  if (!scope || scope.environmentId !== snapshot.environment.id || !Array.isArray(scope.tenantIds)) {
    throw new ConsoleBffError(403, 'FORBIDDEN', 'This identity cannot read the requested Console projection.')
  }
  const tenants = new Set(scope.tenantIds)
  const visible = (item) => item.ownership.environmentId === scope.environmentId && tenants.has(item.ownership.tenantId)
  const evidence = snapshot.evidence.filter(visible)
  const buckets = snapshot.metrics.filter(visible)
  const metrics = Object.fromEntries(Object.entries(METRICS).map(([category, fields]) => [
    category,
    Object.fromEntries(fields.map((field) => [field, buckets.reduce((sum, bucket) => {
      const value = bucket[category][field]
      // A partial sum would imply completeness. Unknown coverage wins for each metric leaf.
      return sum === null || value === null ? null : sum + value
    }, 0)])),
  ]))
  return {
    ...snapshot,
    // The validated graph requires every capability to share its parent cluster's owner.
    clusters: snapshot.clusters.filter(visible),
    placements: snapshot.placements.filter(visible),
    evidence,
    sourceHealth: {
      ...snapshot.sourceHealth,
      warnings: (snapshot.sourceHealth?.warnings ?? []).filter((warning) => (
        warning.code !== 'REDACTED' || evidence.some((item) => item.redacted)
      )),
    },
    metrics,
  }
}
