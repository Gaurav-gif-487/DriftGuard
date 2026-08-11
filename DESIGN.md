# Design

## Overview

`driftguard` is a zero-execution static analyzer for detecting API driftguard between client and server source code.

The analyzer builds structural representations of client call sites and server handlers, resolves routes, compares response schemas, and reports changes without starting the application or making network requests.

## Design goals

- Analyze source code rather than runtime traffic.
- Require no OpenAPI specification or generated contract file.
- Prefer deterministic evidence over heuristic guesses.
- Treat unresolved information as unknown rather than as a violation.
- Produce stable machine-readable output for CI and code scanning.
- Keep the core analyzer independent of external services.

## Analysis pipeline

```text
Client source ──> Client parser ──┐
                                  ├──> Route matching ──> Schema validation ──> Report
Server source ──> Server parser ──┘
```

The intelligence pipeline extends this model:

```text
Source
  │
  ├── Contract graph
  │       ├── nodes
  │       ├── dependencies
  │       └── provenance
  │
  ├── Baseline graph
  │
  └── Worktree graph
          │
          └── graph diff
                  │
                  └── impact analysis
                          │
                          ├── risk
                          ├── evidence
                          └── optional repair verification
```

## Source extraction

### TypeScript and JavaScript

The TypeScript compiler API is used for client and server analysis. The implementation covers common patterns including:

- `fetch`
- Axios
- React Query
- Express
- Fastify
- Next.js Pages Router
- Next.js App Router

Type information is converted into the internal structural schema model. One-hop local import and `tsconfig` path resolution are supported.

### Python

Python source is parsed with Tree-sitter. Current extraction focuses on:

- FastAPI route decorators
- Pydantic-style response models
- `requests`
- `httpx`

### Go

Go source is parsed with Tree-sitter. Current extraction focuses on:

- Gin handlers and route groups
- `net/http` client calls
- struct-based response models

## Route matching

Route matching is deterministic for static paths.

Dynamic paths can use a heuristic classifier when literal evidence is incomplete. A fuzzy match is accepted only when:

1. the score meets the configured threshold; and
2. the best candidate is sufficiently separated from the next candidate.

Otherwise the route remains unresolved.

The unresolved state is intentional. A static analyzer should not convert insufficient evidence into a breaking-change claim.

## Schema validation

The validator compares the client-required shape with the server-provided shape.

For response compatibility, the relevant relationship is:

```text
server response ⊆ client-accepted response
```

The validator reports structural incompatibilities such as:

- required field removal
- type changes
- enum variant removal
- nullability changes
- optionality changes

Unknown or unsupported shapes are reported as unverifiable where appropriate.

## Contract graph

The graph layer represents:

- contracts
- consumers
- dependencies
- provenance
- resolution methods

Graph construction is deterministic within a single analysis run. Validation can detect duplicate node and edge identifiers and other structural issues.

The graph can be built for both a Git baseline and the current worktree. Their difference is used by impact analysis to preserve consumers of deleted or changed contracts.

## Evidence and provenance

Findings carry evidence describing how a conclusion was derived. Evidence may include:

- source location
- parser or resolver origin
- dependency relationship
- route matching strategy
- schema comparison
- proof level
- limitations

The reporting layer exposes this evidence instead of presenting an unsupported confidence percentage.

## Repair

The repair engine is intentionally conservative.

Supported repair intents currently include:

- field rename
- required-to-optional widening

Repairs are dry-run by default. Only changes backed by sufficient provenance are eligible. Dynamic property accesses and unsupported transformations remain untouched.

A repair can be re-analyzed against a temporary copy to verify that the proposed change removes the targeted impact without modifying the real working tree.

## CLI modes

The original analyzer supports:

```text
driftguard --client <path> --server <path>
```

The intelligence layer adds:

```text
driftguard check
driftguard impact
driftguard validate
driftguard agent-check
driftguard fix
driftguard receipt
```

The commands share project discovery and configuration resolution.

## Reporting

Supported formats include:

- text
- JSON
- Markdown
- SARIF 2.1.0

The GitHub Action can upload SARIF results to code scanning and optionally maintain a Markdown pull-request comment.

## Testing strategy

The test suite uses Node's built-in test runner and covers:

- parser behavior
- route matching
- schema validation
- graph construction and validation
- impact analysis
- repair behavior
- CLI argument handling
- output formats
- path normalization
- adversarial fixtures
- integration behavior
- Tree-sitter parsing edge cases
- cross-file resolution

Fixtures are kept small and deterministic so failures can be reproduced locally.

## Verification policy

A feature is considered complete when it has:

1. deterministic implementation behavior;
2. focused regression coverage;
3. integration coverage where the feature crosses pipeline boundaries;
4. build/typecheck coverage; and
5. documented limitations where static evidence is insufficient.

Real repositories may be used for validation, but they are not treated as substitutes for deterministic fixtures and regression tests.

## Known boundaries

The analyzer is not a replacement for runtime integration testing or a full language server.

Known boundaries include:

- one-hop cross-file type resolution;
- limited inference for runtime-generated URLs;
- unsupported opaque database/service return values;
- incomplete modeling of non-object response schemas;
- framework-specific extraction coverage;
- conservative handling of dynamic code.

These cases are surfaced as unresolved or unverifiable rather than silently guessed.
