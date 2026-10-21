import type { AgentDefinition } from '../domain/contracts'

/** Curated catalog entries are not runtime observations or deployment evidence. */
export const curatedAgents: AgentDefinition[] = [
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
