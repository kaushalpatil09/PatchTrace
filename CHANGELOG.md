# Changelog

## Unreleased

### Added

- Versioned incident bundle v1, field-level validation, and JSON Schema.
- Local API with session authentication, `Host`/`Origin` checks, JSON-only bodies, body limits, security headers, and structured errors.
- Dependency-free browser UI with bundle import, evidence detail, factor contributions, missing signals, fixture verification, and opt-in real verification.
- CLI commands: `doctor`, `validate`, `analyze`, `verify`, and `report`.
- Markdown, JSON, and CSV reports with timeline, injection-safe rendering, and best-effort secret redaction across exported text.
- Git enrichment for changed files, commit timestamps, short-SHA matching, and derived diff risk.
- Two-run baseline stability checks, explicit cancellation, process-tree termination, output caps, stale-workspace sweeping, and source fingerprint checks.
- `/api/health` readiness information including Git availability, temporary-directory writability, and verification activity.

### Security

- Real verification is opt-in and disabled by default.
- Worktrees, submodules, bare/shallow repositories, filesystem roots, dirty worktrees, and escaping symlinks are rejected before verification.
- Verification output and report JSON are redacted best-effort. Raw analysis API responses remain sensitive data, and local paths are not scrubbed.

### Known limitations

- Real verification uses temporary-copy isolation, not a hardened container/VM sandbox.
- API request/response schema validation is limited to bundle and verification request validation; an OpenAPI document is not included yet.
- Dependency blast-radius is a provided signal, not derived from a package graph.
- Docker runtime validation and the GitHub Actions matrix have not been executed in this environment.
