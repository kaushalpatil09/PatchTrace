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
- Public npm package metadata for `https://github.com/kaushalpatil09/PatchTrace`, MIT licensing, and a curated package file list.
- Multi-stage Docker packaging with a non-root runtime, Git/CA certificates, and a readiness-aware healthcheck.
- Ubuntu CI image build/runtime checks, while the Node test matrix continues to run on Ubuntu and Windows with Node 22 and 24.
- Local `doctor`, `check`, `security`, UI/CLI, and Node built-in coverage-compatible npm gates.
- Operational guidance for request limits, repository-copy limits, container resources, readiness semantics, and release validation.

### Accessibility

- Skip link, semantic landmarks, labelled regions, status/live announcements, focus management, keyboard-operable controls, visible focus styling, larger touch targets, responsive zoom behavior, reduced-motion handling, and forced-colors/high-contrast fallbacks.
- Static UI regression checks for accessibility wiring, zoom semantics, reduced motion, contrast modes, and keyboard-safe interaction.

### Security

- Real verification is opt-in and disabled by default.
- Worktrees, submodules, bare/shallow repositories, filesystem roots, dirty worktrees, and escaping symlinks are rejected before verification.
- Verification output and report JSON are redacted best-effort. Raw analysis API responses remain sensitive data; report exports scrub absolute local paths while preserving repository-relative evidence paths.

### Fixed

- Container-mode verification now uses line-ending- and file-mode-safe Git settings for bind-mounted Windows worktrees, preventing false local-change conflicts during candidate reverts.

### Known limitations

- Default real verification uses temporary-copy isolation; production mode requires the constrained Docker/Podman runner, while a dedicated VM remains a stronger boundary.
- API request/response contracts are validated for the current local routes and documented in `docs/openapi.yaml`; a generated schema toolchain is intentionally not added.
- Dependency impact is derived from supported manifest/lockfile changes and bounded diff churn; full source-level package-graph analysis remains deferred.
- Docker runtime validation requires a Docker daemon; the checked-in Ubuntu CI job is the source of truth when it runs on GitHub-hosted runners.
