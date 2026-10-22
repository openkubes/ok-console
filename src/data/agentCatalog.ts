import type { AgentDefinition } from '../domain/contracts'

/** Curated catalog entries are not runtime observations or deployment evidence. */
export const curatedAgents: AgentDefinition[] = [
  {
    id: 'agent-kagent-platform-operator',
    name: 'Kagent Platform Operator',
    category: 'Platform Operations',
    description: 'Read-only Kubernetes platform diagnostics backed by the Kagent operator on the dedicated ok-kagent cluster.',
    version: 'v0.9.12',
    publisher: 'OpenKubes',
    verified: true,
    artifactDigest: 'sha256:058ca9fc1a9ac994dde3354a7df56f5a6b93222572eda40ba295da2f0b6c101b',
    requiredCapabilities: ['cap-observability'],
    resourceProfile: 'Read-only diagnostics · ok-kagent',
    deployments: 1,
    recommendedCluster: 'ok-kagent',
    tools: [
      { id: 'diagnostics.read', label: 'Read-only platform diagnostics', authority: 'Read only' },
      { id: 'evidence.read', label: 'Source evidence lookup', authority: 'Read only' },
    ],
  },
  {
    id: 'agent-ok-ai-document-search',
    name: 'OK AI Document Search Agent',
    category: 'Developer Experience',
    description: 'Searches reviewed OpenKubes documentation and returns source-linked answers without claiming unsupported platform state.',
    version: 'Beta 1.1',
    publisher: 'OpenKubes',
    verified: true,
    artifactDigest: 'sha256:013ecff99e7db43a8d7d05c0d17e5385dac22254403561905b189a2bc9c2afb1',
    requiredCapabilities: ['cap-observability'],
    resourceProfile: 'Signed image · no runtime placement',
    deployments: 0,
    recommendedCluster: 'No deployment approved',
    tools: [
      { id: 'documents.search', label: 'Reviewed document search', authority: 'Read only' },
      { id: 'evidence.read', label: 'Source evidence lookup', authority: 'Read only' },
    ],
  },
]
