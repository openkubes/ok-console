const countReadiness = (items) => ({
  total: items.length,
  ready: items.filter((item) => item.readiness === 'Ready').length,
  pending: items.filter((item) => item.readiness === 'Pending').length,
  failed: items.filter((item) => item.readiness === 'Failed').length,
  unknown: items.filter((item) => item.readiness === 'Unknown').length,
})

export const clusterSummary = (cluster) => ({
  id: cluster.id,
  name: cluster.name,
  role: cluster.role,
  provider: cluster.provider,
  profile: cluster.profile,
  kubernetesVersion: cluster.kubernetesVersion,
  region: cluster.region,
  readiness: cluster.readiness,
  compatibility: cluster.compatibility,
  contractVersion: cluster.contractVersion,
  revision: cluster.revision,
  evidenceId: cluster.evidenceId,
  capabilityCount: cluster.capabilities.length,
})

export const sessionProjection = (snapshot, identity, expiresAt) => ({
  subject: {
    id: identity.id,
    displayName: identity.displayName,
    identitySource: identity.identitySource === 'OIDC' ? 'OIDC' : 'Local',
    assurance: identity.identitySource === 'OIDC' ? 'Federated' : 'Break glass',
  },
  environment: {
    id: snapshot.environment.id,
    displayName: snapshot.environment.displayName,
  },
  permissions: [...identity.permissions],
  expiresAt,
})

export const overviewProjection = (snapshot) => ({
  clusters: countReadiness(snapshot.clusters),
  capabilities: { ...snapshot.metrics.capabilities },
  workloadClaims: { ...snapshot.metrics.workloadClaims },
  openFindings: { ...snapshot.metrics.openFindings },
  managementPlane: clusterSummary(snapshot.clusters.find((cluster) => cluster.role === 'Management plane')),
  recentPlacements: snapshot.placements.map((placement) => ({
    id: placement.id,
    name: placement.name,
    targetCluster: placement.targetCluster,
    readiness: placement.readiness,
    evidenceId: placement.evidenceId,
  })),
})

export const clusterListProjection = (snapshot) => ({
  items: snapshot.clusters.map(clusterSummary),
})

export const clusterDetailProjection = (cluster) => ({
  ...clusterSummary(cluster),
  capabilities: cluster.capabilities.map((capability) => ({
    id: capability.id,
    name: capability.name,
    readiness: capability.readiness,
    evidenceId: capability.evidenceId,
  })),
  lifecycle: cluster.lifecycle.map((stage) => ({
    label: stage.label,
    state: stage.state,
    detail: stage.detail,
  })),
})

export const evidenceProjection = (evidence) => ({
  id: evidence.id,
  title: evidence.title,
  type: evidence.type,
  outcome: evidence.outcome,
  clusterId: evidence.clusterId,
  contract: evidence.contract,
  revision: evidence.revision,
  observedAt: evidence.observedAt,
  source: evidence.source,
  summary: evidence.summary,
  classification: evidence.classification,
  redacted: true,
  drillDownRef: `/api/console/v0/evidence/${encodeURIComponent(evidence.id)}`,
})
