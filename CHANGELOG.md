# Changelog

All notable changes to this project are documented here.

## [Unreleased]

### Fixed

- CLI value flags now accept both `--flag=value` and `--flag value`.
- Unknown flags and stray positional arguments are reported as usage errors.
- Invalid `--format` values are rejected instead of silently falling back to text.
- Text-format locations are rendered relative to the client root with POSIX separators.
- CLI direct-run detection uses URL-safe module path handling.
- The profiling script runs through the TypeScript runtime loader.

### Added

- MIT license and repository configuration files.
- Package metadata for npm distribution.
- GitHub Actions CI across supported Node.js versions.
- Regression coverage for CLI parsing and output behavior.
- `driftguard validate` for contract graph validation.
- Optional impact details in GitHub pull-request comments.
- Evidence and proof-level details in Markdown and SARIF output.

## [0.2.0]

- Added a provenance-backed contract graph.
- Added deterministic graph diffing.
- Added baseline-vs-worktree impact analysis.
- Added structured repair-intent verification.
- Added conservative AST-based repair with dry-run by default.
- Added intelligence integration tests while preserving the original CLI.

## [0.1.0]

- Initial static driftguard analyzer.
- TypeScript/JavaScript client and server parsing.
- Python/FastAPI and Go/Gin extraction.
- Exact and conservative dynamic route matching.
- Structural response-schema validation.
- SARIF, JSON, Markdown, and text reporting.
