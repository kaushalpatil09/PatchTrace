# PatchTrace implementation TODO

See `docs/IMPLEMENTATION_STATUS.md` for what is verified and `docs/PRODUCTION_READINESS.md` for the full release specification.

## Completed

- [x] Capture the user, problem, constraints, and acceptance criteria.
- [x] Write the architecture and contributor guidance.
- [x] Create a deterministic, versioned incident fixture.
- [x] Build the pure analysis engine with timeline, scoring, coverage, and evidence.
- [x] Build a local API and dependency-free browser UI.
- [x] Add scoring, parser, API, CLI, report, and verification tests.
- [x] Add a smoke check for the running app.
- [x] Harden the API with a session token, Host/Origin checks, JSON-only bodies, limits, and security headers.
- [x] Reject linked worktrees, submodules, shallow/bare repos, roots, and outside symlinks before verification.
- [x] Add Windows `.cmd` launcher support, process-tree timeouts, cleanup checks, and environment allowlisting.
- [x] Add versioned bundle validation and a JSON Schema.
- [x] Add browser bundle import.
- [x] Add CLI `doctor`, `validate`, `analyze`, `verify`, and `report`.
- [x] Add Git enrichment for changed files and derived diff risk.
- [x] Add Markdown, JSON, and CSV report export with an incident timeline.
- [x] Add an opt-in real verification form in the UI.
- [x] Add a server-built, redacted JSON report download.
- [x] Add API and security references.
- [x] Add a GitHub Actions Ubuntu/Windows CI matrix definition.
- [x] Run the baseline twice and report flaky baselines as inconclusive.
- [x] Add explicit cancellation, disconnect cancellation, and shutdown cancellation.
- [x] Redact likely secrets from verification output and Markdown/CSV reports.
- [x] Sweep marked stale workspaces at startup.
- [x] Report Git availability, readiness, and verification activity in `/api/health`.
- [x] Add verification audit timing and cleanup fields.
- [x] Deep-redact report JSON and add a synthetic maximum-size analysis/report test.
- [x] Reject absolute repository links before verification and add a source-integrity regression test.
- [x] Make fixture verification server-owned and label fixture versus live results.
- [x] Resolve short/full deployment SHAs and refuse ambiguous prefixes.
- [x] Bound and strictly validate JUnit XML structure.
- [x] Add local `patchtrace ingest` for deployment CSV, JUnit XML, and Git evidence.
- [x] Record ingestion artifact hashes, parser versions, source paths, and ingestion time.
- [x] Add bounded why-not explanations and evidence source references.
- [x] Add stricter report request validation and safe repository error mapping.

## Next: production hardening

- [ ] Container/VM verification runner behind the same result contract.
- [ ] Complete API request/response schema validation and OpenAPI documentation (the report request contract is now validated; route docs exist).
- [ ] Dependency blast-radius derivation from a package graph.
- [ ] Execute and validate the CI matrix on real runners.
- [ ] Large-repository and slow-command limit tests (the maximum bundle size is covered).
- [ ] Path-scrubbing policy for report metadata.
- [ ] Browser accessibility audit.
- [ ] License and release metadata.
- [ ] Build and validate the Docker image.

## Deliberately deferred

- [ ] SQLite persistence — JSON bundles are the current contract.
- [ ] GitHub/GitLab/Sentry/Slack integrations.
- [ ] Multi-user auth and team workspaces.
- [ ] Production rollback execution.
- [ ] Generic chat assistant behavior.
