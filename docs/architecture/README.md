# OpenKubes Console architecture

This directory contains versioned architecture artefacts for the OpenKubes Console.
Confluence provides the living narrative specification; this repository remains the
canonical home for files that must evolve with the source code and be reviewed in
pull requests.

## OK-155 — first read-only vertical slice

- [`ok-155-component-architecture.png`](ok-155-component-architecture.png) — rendered diagram for documentation and presentations
- [`ok-155-component-architecture.dot`](ok-155-component-architecture.dot) — editable Graphviz source
- [Jira OK-155](https://kubernauts.atlassian.net/browse/OK-155) — spike scope and delivery tracking
- [`../../bff/README.md`](../../bff/README.md) — executable OK-158 BFF boundary,
  endpoints, security controls, and local integration

Regenerate the PNG after changing the source:

```sh
dot -Tpng -Gdpi=180 \
  docs/architecture/ok-155-component-architecture.dot \
  -o docs/architecture/ok-155-component-architecture.png
```

## Ownership legend

- **Blue — Developer B:** browser application, frontend state and typed BFF adapter.
- **Orange — Shared:** Presentation Contract v0, response semantics and contract tests.
- **Green — Developer A:** read-only BFF, query services, normalization and backend integration.
- **Grey — Sources:** deterministic fixtures and observed OpenKubes state.
- **Red dashed — Deferred:** mutation paths outside the OK-155 spike.

Architecture changes should update the editable source, regenerate the PNG and
link the corresponding Jira decision or ADR in the same pull request.
