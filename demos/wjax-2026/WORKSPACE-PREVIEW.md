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

## User & Project Management preview

The separate `#/users` journey uses the existing local preview gate. Start Vite on
loopback with `VITE_WJAX_KIND_PREVIEW=true` in addition to the fixture/prototype
settings above. This gate and the independent `#/wjax` read-only cluster reader
are unchanged; identity management is excluded from production builds.

The sidebar label is **User & Project Management**, with **Preview · identity &
access** as its caption. The page is organized into Users, Projects and Access
Assignments, using the Console's design tokens and responsive module CSS.

1. Add a preview username, an example namespace and a proposed role.
2. Disable and enable the entry; its proposal becomes paused or proposed. Neither
   state grants effective access.
3. Remove the entry; its proposed assignment disappears too.
4. Refresh, or navigate to Developer Workspaces and back: the entries reset.

Projects are an explanatory demo-only section with no project lifecycle actions.
Namespace choices are illustrative examples, not discovered cluster inventory or
cross-cluster bindings. User and assignment state lives only in React memory;
there are no identity/access requests, credentials, authentication changes,
persistence, OIDC/Keycloak writes or Kubernetes RBAC changes.

### UI refinement verification (2026-11-04)

- `pnpm lint` and `pnpm build`: passed.
- `pnpm exec vitest run src/App.test.tsx src/workspaces`: 46 passed.
- `pnpm exec vitest run src/App.test.tsx src/workspaces src/identity src/wjax`:
  75 passed, covering validation, duplicate names, create/disable/enable/remove,
  no network/storage writes, reset, navigation, local gating and Reader regression.
- Full suite: 747 passed, 23 failed, 12 skipped. A clean detached checkout of
  baseline `900516a` produced 735 passed, the same 23 failing cases, 12 skipped.
  Failures: `ok170.test.ts` (2), `ok172.test.ts` (2), `ok200-capture.test.ts` (7),
  `ok200.test.ts` (12). The first two lack Python PyYAML; the OK-200 cases include
  platform-specific diagnostic and shell fixture assumptions. No new failing
  cases. The handoff's previously reported 24 OK-200 failures was not reproduced
  as that exact count in this macOS environment; the overall suite remains red.
- Chrome walkthrough: create/disable/enable/remove and reload reset passed at
  1440×1100 and 390×844. No page errors or document horizontal overflow at 390px.
  Axe reported zero violations within `.identity-preview` at both sizes; this is
  a scoped automated check, not a full Console accessibility audit.
- `src/workspaces/DeveloperWorkspaces.tsx`, its tests and stylesheet are unchanged.

Deployment-test portability/prerequisites remain a separate issue. Real identity
and authorization services and versioned contracts remain future architecture
work. This refinement does not merge or deploy the prototype.
