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
- [x] Add public npm metadata, MIT license text, curated package files, and release notes.
- [x] Add multi-stage non-root Docker packaging, healthcheck guidance, and an Ubuntu Docker build/runtime CI job.
- [x] Add local `doctor`, security, coverage-compatible, focused, and release-check npm scripts.
- [x] Add accessible landmarks, labels, live regions, focus/keyboard behavior, responsive zoom semantics, reduced-motion/contrast fallbacks, and static UI regressions.
- [x] Document operational limits, resource budgets, readiness semantics, Docker resources, and release validation.

## Next: production hardening

- [x] Fix Markdown output injection and compound credential redaction with adversarial regressions.
- [x] Index failed-test evidence, bound displayed details and isolate API analysis in a bounded worker.
- [x] Reject non-ISO and rolled-over calendar timestamps.
- [x] Add repeatable performance and synthetic ranking evaluation commands.
- [x] Pin CI action commits and test a clean installed tarball.
- [x] Preserve the old defect inventory in dated history and reconcile current defects.
- [ ] Execute the new real-container integration gate on a working daemon; extend adversarial resource/process-tree/disconnect/shutdown coverage.
- [ ] Enforce a container workspace disk quota; the current writable bind mount is not bounded by tmpfs limits.
- [ ] Complete real-browser automation, axe, manual keyboard/zoom/contrast and screen-reader validation.
- [ ] Supply independently reviewed historical cases; keep real-world ranking validation OPEN.
- [ ] Execute the full supported platform/runtime CI matrix and validate release provenance/image updates.

- [x] Add a constrained Docker/Podman verification runner behind the same result contract; live runtime validation remains a release gate and is not claimed without a daemon and image.
- [x] Add hand-written API request/response contracts and OpenAPI 3.1 documentation.
- [x] Add dependency-impact derivation from supported manifests/lockfiles and bounded diff churn (full source-level package graph remains deferred).
- [ ] Execute and validate the CI matrix, including the Docker job, on GitHub-hosted Ubuntu and Windows runners (workflow is defined; no remote run is claimed from this checkout).
- [x] Add repository-copy, free-space, Git-history, parser, and output bounds; large-repository benchmarking remains a release gate.
- [x] Add path-scrubbing policy for report metadata.
- [ ] Browser accessibility audit with assistive technology.
- [ ] Build and validate the Docker image through a live runtime or completed CI run.

## Deliberately deferred

- [ ] SQLite persistence — JSON bundles are the current contract.
- [ ] GitHub/GitLab/Sentry/Slack integrations.
- [ ] Multi-user auth and team workspaces.
- [ ] Production rollback execution.
- [ ] Generic chat assistant behavior.
