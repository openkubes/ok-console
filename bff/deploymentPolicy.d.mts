export type DeploymentPolicy = Readonly<{ name: 'fixture-read-only'; clusterLifecycle: false; liveClusterAccess: false; writeApis: false }>
export type DeploymentPolicyDocument = { schema: 'openkubes.console.deployment-policy/v1'; policy: 'default' | 'fixture-read-only'; clusterLifecycle: boolean }

export declare const DEPLOYMENT_POLICY_FIXTURE_READ_ONLY: 'fixture-read-only'
export declare const FIXTURE_EVALUATION_WRITES: ReadonlyArray<Readonly<{ method: 'POST'; path: string }>>
export declare const AUTHENTICATION_WRITES: ReadonlyArray<Readonly<{ method: 'POST' | 'DELETE'; path: string }>>
export declare class DeploymentPolicyError extends Error {
  problems: string[]
}
export declare function resolveDeploymentPolicy(env?: Record<string, string | undefined>): DeploymentPolicy | null
export declare function deploymentPolicyAllows(policy: DeploymentPolicy | null, method: string, pathname: string): boolean
export declare function deploymentPolicyDocument(policy: DeploymentPolicy | null): DeploymentPolicyDocument
