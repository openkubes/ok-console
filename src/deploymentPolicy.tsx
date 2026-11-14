import { createContext, useContext, type ReactNode } from 'react'

// Client view of the server's deployment policy (bff/deploymentPolicy.mjs). Independent of branding.
// The server enforces the policy; the Console only labels the UI accordingly. Anything unclear makes
// the Console more restrictive, never less.
export type ConsoleDeploymentPolicy = { policy: 'default' | 'fixture-read-only' | 'unknown'; clusterLifecycleAvailable: boolean }

// eslint-disable-next-line react-refresh/only-export-components
export const DEFAULT_DEPLOYMENT_POLICY: ConsoleDeploymentPolicy = Object.freeze({ policy: 'default', clusterLifecycleAvailable: true })
// eslint-disable-next-line react-refresh/only-export-components
export const READ_ONLY_UNKNOWN: ConsoleDeploymentPolicy = Object.freeze({ policy: 'unknown', clusterLifecycleAvailable: false })

// Interprets the deployment-policy part of the installation data (bff/installation.mjs).
// eslint-disable-next-line react-refresh/only-export-components
export function resolveDeploymentPolicyValue(value: unknown): ConsoleDeploymentPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return READ_ONLY_UNKNOWN
  const document = value as { schema?: unknown; policy?: unknown; clusterLifecycle?: unknown }
  if (document.schema !== 'openkubes.console.deployment-policy/v1') return READ_ONLY_UNKNOWN
  if (document.policy === 'default' && document.clusterLifecycle === true) return DEFAULT_DEPLOYMENT_POLICY
  if (document.policy === 'fixture-read-only' && document.clusterLifecycle === false) return { policy: 'fixture-read-only', clusterLifecycleAvailable: false }
  return READ_ONLY_UNKNOWN
}

const DeploymentPolicyContext = createContext<ConsoleDeploymentPolicy>(DEFAULT_DEPLOYMENT_POLICY)

export function DeploymentPolicyProvider({ policy, children }: { policy: ConsoleDeploymentPolicy; children: ReactNode }) {
  return <DeploymentPolicyContext.Provider value={policy}>{children}</DeploymentPolicyContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export const useDeploymentPolicy = () => useContext(DeploymentPolicyContext)
