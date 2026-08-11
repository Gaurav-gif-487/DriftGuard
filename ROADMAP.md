# Roadmap

This roadmap prioritizes correctness, distribution, framework coverage, and maintainability. A phase is complete only when the implementation, regression tests, build, and documentation are updated together.

## Current baseline

- TypeScript/JavaScript, Python, and Go source extraction
- Express, Fastify, Next.js, FastAPI, and Gin coverage
- Deterministic graph construction and validation
- Baseline/worktree impact analysis
- Evidence and provenance in reports
- Conservative repair for field rename and required-to-optional changes
- CLI, SARIF, Markdown, JSON, and text output
- GitHub composite action
- Fixture, regression, adversarial, and integration test coverage

## Phase 1 — Repair precision

Improve repair safety before expanding automatic transformations.

- Attach exact source locations to field-access evidence.
- Scope AST edits to proven access nodes rather than matching field names across a file.
- Add regression fixtures for request-body fields, local state, destructuring, aliases, and nested accesses.
- Re-run post-repair analysis and require the targeted impact to disappear before reporting a verified repair.
- Extend safe repair coverage to Python and Go only where equivalent source evidence exists.

## Phase 2 — Distribution

Make installation and CI integration straightforward.

- Publish a versioned npm package.
- Verify clean installation from a packed tarball.
- Maintain stable CLI exit codes and JSON schemas.
- Provide a versioned GitHub Action release.
- Add release automation and package validation.

## Phase 3 — GraphQL

Add GraphQL only where both sides can be resolved from source.

- Parse GraphQL schemas.
- Resolve server query and mutation handlers.
- Extract client operations and selected fields.
- Integrate GraphQL contracts into the existing graph and diff model.
- Add deterministic fixtures and real-project validation.

## Phase 4 — tRPC

Support procedure-based contracts.

- Extract routers and procedures.
- Resolve Zod input/output schemas.
- Support nested routers.
- Trace client procedure calls.
- Reuse the existing schema, graph, and impact infrastructure.

## Phase 5 — Go HTTP coverage

Expand beyond Gin.

- Chi route registration and groups.
- Standard-library `net/http` handlers.
- Go 1.22 route patterns.
- Response extraction for common JSON encoder patterns.
- Dedicated fixtures and regression coverage.

## Phase 6 — Analysis quality

Improve precision without weakening conservative behavior.

- Better cross-file resolution.
- Broader response-schema modeling.
- Improved dynamic-route diagnostics.
- More precise evidence locations.
- Performance profiling for large repositories.
- Incremental or cached analysis where measurements justify it.

## Phase 7 — Release engineering

Establish a predictable open-source maintenance workflow.

- Automated release checks.
- Dependency update policy.
- Compatibility matrix for supported Node versions.
- Reproducible package contents.
- Security policy and contribution guide.
- Issue and pull-request templates.

## Non-goals

The project will not:

- execute analyzed applications as part of static analysis;
- silently infer unsupported runtime behavior;
- claim certainty where source evidence is insufficient;
- require a hosted service for the core analyzer;
- add automatic rewrites without a verifiable transformation.
