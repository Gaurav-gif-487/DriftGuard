# 🛡️ DriftGuard

Zero-execution static analysis for detecting breaking API contract drift between frontend and backend.

`driftguard` reads client and server source code, extracts route and response information, matches corresponding endpoints, and compares their structural contracts. It does not require an OpenAPI specification, a running server, Docker, or network traffic.

## Features

- TypeScript/JavaScript client and server analysis
- Python/FastAPI and Go/Gin extraction
- `fetch`, Axios, React Query, `requests`, `httpx`, and common HTTP client patterns
- Exact route matching with conservative dynamic-route resolution
- Structural response-schema validation
- Contract graph construction with provenance
- Baseline/worktree impact analysis
- Risk scoring and evidence-backed reports
- Conservative AST-based repair for supported intents
- JSON, Markdown, text, and SARIF 2.1.0 output
- GitHub Actions integration
- No runtime execution of the analyzed application

## Quick start

```bash
npx driftguard --client ./frontend --server ./backend
```

Run the bundled demonstration:

```bash
npx driftguard --demo
```

Example output:

```text
GET /api/v1/users/:id  ->  GET /api/v1/users/:id  (exact, confidence 1)
  at frontend/src/api/userClient.ts:12:21
  ERROR [missing-field] Required field 'email' is missing from the server response.
  ERROR [type-mutation] Field 'age' changed type from 'number' to 'string'.

2 error(s), 0 warning(s), 0 note(s)
```

## How it works

```text
client source ──> client parser ──┐
                                 ├──> route matcher ──> validator ──> report
server source ──> server parser ──┘
```

1. The client parser extracts HTTP call sites and the response shape the client expects.
2. The server parser extracts handlers and the response shape the server provides.
3. The route matcher resolves client calls to server handlers.
4. The validator compares the two structural schemas.
5. The reporting layer emits human- and machine-readable findings.

The analyzer is conservative: unresolved routes and unsupported schemas are reported as unresolved or unverifiable instead of being treated as breaking changes.

## Supported extraction

### TypeScript / JavaScript

- Client: `fetch`, Axios, React Query
- Server: Express, Fastify, Next.js Pages Router, Next.js App Router
- TypeScript compiler API for syntax and type extraction
- One-hop relative imports and `tsconfig` path aliases

### Python

- FastAPI route decorators
- Pydantic-style response models
- `requests`
- `httpx`
- Tree-sitter parsing

### Go

- Gin routes and route groups
- `net/http` client patterns
- Go structs
- Tree-sitter parsing

Framework coverage is intentionally scoped to patterns that can be established from source evidence.

## CLI

```text
OPTIONS
  --format=<fmt>       sarif | json | text | markdown
  --out=<file>         Write the report to a file
  --threshold=<0..1>   Minimum score for fuzzy dynamic-route resolution
  --strict             Fail when routes remain unresolved
  --explain            Include route-resolution evidence
  --demo               Analyze bundled fixtures
  -h, --help           Show help
```

Exit status is suitable for CI gating:

- `0` — no breaking violations
- `1` — breaking violations or strict-mode unresolved routes
- usage errors are reported explicitly

All value options accept both `--flag=value` and `--flag value`.

## GitHub Actions

The repository includes a composite action in `action.yml`.

```yaml
permissions:
  contents: read
  pull-requests: write
  security-events: write

steps:
  - uses: actions/checkout@v4

  - uses: ./path/to/driftguard
    with:
      client: ./frontend
      server: ./backend
```

For a published action, replace the local `uses` path with the repository and release tag used by your organization.

The action can:

- run the analyzer;
- upload SARIF to GitHub code scanning;
- publish or update a Markdown pull-request comment;
- optionally compare the current worktree with a Git baseline.

See `.github/workflows/example-usage.yml` for the repository's self-test workflow.

## Contract intelligence

The intelligence layer adds a provenance-backed graph and Git-baseline comparison.

```bash
driftguard check --client ./frontend --server ./backend
driftguard impact --client ./frontend --server ./backend --base main
driftguard validate --client ./frontend --server ./backend
driftguard agent-check --client ./frontend --server ./backend --base main --rename User.email->User.emailAddress
driftguard fix --client ./frontend --server ./backend --base main --rename User.email->User.emailAddress
```

`fix` is dry-run by default. Applying a repair requires `--apply`.

Supported repair intents:

- `--rename=Contract.old->new`
- `--widen-optional=Contract.field`

Unsupported transformations remain available for verification but are not rewritten automatically.

## Configuration

Copy the example configuration when risk policies or conventional project discovery need customization:

```bash
cp driftguard.config.example.json driftguard.config.json
```

The schema is available at `config.schema.json`.

## Project structure

```text
src/
  client-parser.ts
  server-parser.ts
  python-parser.ts
  go-parser.ts
  route-matcher.ts
  validator.ts
  cross-file-resolver.ts
  graph/
  impact/
  repair/
  receipt/
  agent/
  cli.ts
  sarif.ts
  index.ts

fixtures/                   deterministic frontend/backend examples
test/                       unit, regression, adversarial, and integration tests
scripts/                    profiling and benchmark utilities
action.yml                  GitHub composite action
DESIGN.md                   architecture and verification policy
ROADMAP.md                  planned work
CHANGELOG.md                release history
```

## Development

Requirements:

- Node.js 18.17 or newer
- npm

Install dependencies and run the full verification suite:

```bash
npm ci
npm test
npm run build
```

Additional commands:

```bash
npm run test:watch
npm run profile
npm run benchmark
```

The build emits declarations and JavaScript into `dist/`.

## Known limitations

Static analysis cannot recover information that exists only at runtime. Current limitations include:

- one-hop cross-file type resolution;
- runtime-generated URLs with no literal route evidence;
- opaque values returned by databases or external services;
- incomplete modeling of top-level primitive and array response schemas;
- framework-specific extraction coverage;
- dynamic property access;
- factory-generated route handlers whose response schema cannot be resolved statically.

When evidence is insufficient, the analyzer reports the affected item as unresolved or unverifiable.

## Design

See [DESIGN.md](./DESIGN.md) for the architecture, evidence model, repair policy, and verification strategy.

## Roadmap

See [ROADMAP.md](./ROADMAP.md) for planned framework coverage, distribution work, and analysis improvements.

## License

MIT. See [LICENSE](./LICENSE).
