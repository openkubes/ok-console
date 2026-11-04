# Developer Workspaces — Console preview

This is a separate, fixture-only Console journey. It requires no Kubernetes cluster,
model service or BFF. It creates no workspace or credentials and sends no workspace
API requests. It is also included in the normal static Console build.

From the `ok-console` checkout:

```sh
pnpm install --frozen-lockfile
VITE_CONSOLE_DATA_MODE=fixture VITE_CONSOLE_AUTH_MODE=prototype pnpm dev --host 127.0.0.1
```

Open the URL printed by Vite with `/#/workspaces` appended. Complete the existing
prototype sign-in: **Continue with OpenKubes Identity → Simulate identity provider
return → Enter Console**. The sidebar entry is **Developer Workspaces**.

## Suggested stage walkthrough (2–3 minutes)

1. Show the three example environments: Persistent, Review and Ephemeral.
2. Inspect **Pull request review**: source/revision, restricted Git access,
   explicit inference/tools and no Kubernetes API or merge authority.
3. Return and inspect **Contract test runner** to show that a pending runtime
   does not imply successful tests or a completed task.
4. Return and click **Create Workspace**. Set a name and revision, choose a
   lifecycle/compute profile and select model or documentation-tool access.
5. Click **Review configuration**. Show the human-readable boundaries and the
   illustrative intent summary. This summary is not a deployable manifest.
6. Click **Finish preview**. The confirmation explicitly says no provisioning
   occurred. **Try another configuration** resets the form for another walkthrough.

Every workspace state, placement, retention policy and result shown is illustrative.
OpenCode is the reference runtime, not the public workspace API. Refreshing or
leaving the page resets the local interaction; there is no saved workspace state.

## Verified locally

- `pnpm build`
- `pnpm lint`
- `pnpm exec vitest run src/workspaces/DeveloperWorkspaces.test.tsx src/App.test.tsx`
- Browser walkthrough with desktop and compact viewports.

The full repository test suite additionally depends on deployment-test prerequisites
(such as Python PyYAML and Linux diagnostic facilities); those checks are separate
from this fixture preview.
