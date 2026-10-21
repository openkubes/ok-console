# Agent Contract v1alpha1

This contract is the reviewed boundary for exposing AI agents in the Console.
It separates a curated definition from artifact verification and observed runtime
deployment. A Kubernetes Pod is not an AgentDeployment by itself.

The contract is intentionally not wired into the live adapter yet. Promotion to
`Verified` requires an immutable OCI digest, signature/provenance evidence, and
an observed deployment that references the same artifact digest.
