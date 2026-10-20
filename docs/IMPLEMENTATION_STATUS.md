# Implementation status

This page records what is actually built, what is verified by tests, and what remains. It is not a substitute for the full production specification in [`PRODUCTION_READINESS.md`](PRODUCTION_READINESS.md).

Last updated: 2026-10-20

## Implemented and tested

### Safety and truth (M0)

- Local API session token: random per start (or `PATCHTRACE_TOKEN`), `HttpOnly`/`SameSite=Strict` cookie for the UI, and `Authorization: Bearer`/`X-PatchTrace-Token` for clients.
- `Host` and `Origin` allowlists, JSON-only POST bodies, 5 MB analysis/report and 1 MB verification body limits, structured error responses, and a response `apiVersion`.
- Security headers: CSP including `object-src 'none'`, `nosniff`, `DENY` framing, no-referrer, permissions policy, same-origin resource policy.
- Real repository verification disabled unless `PATCHTRACE_ENABLE_VERIFY=1`.
- Worktree, submodule, bare, shallow, root-path, dirty-worktree, outside-symlink, and absolute-link rejection before copying.
- Single-flight real verification with `409 verification_in_progress`, request/header/keep-alive timeouts, and explicit body limits.
- Two baseline runs by default with a `flaky_baseline` / `inconclusive` result when pass/fail disagrees.
- Explicit `/api/verify/cancel`, cancellation on client disconnect and graceful shutdown, process-tree termination, and cleanup.
- Stale marked `patchtrace-*` workspace sweep at server/CLI verification startup.
- Windows command resolution for `.cmd` launchers such as `npm`, with explicit `cmd.exe` invocation rather than caller-built shell strings; POSIX process-group kill and Windows `taskkill /T /F`.
- Timeout with a forced-resolution grace period, output caps, environment allowlist, and cleanup that does not hide the verification result.
- Best-effort output redaction for private keys, token formats, bearer tokens, JWTs, URL credentials, and password/token assignments; Markdown/CSV rendering and JSON report exports use the same key-aware deep-redaction rules.
- Source fingerprint checks (HEAD, status including untracked files, `.git/config` hash), audit timing fields, and `sourceUnchanged` reporting.
- `/api/health` reports Git availability/version, temporary-directory writability, readiness, and verification activity.
- Parsers: quoted/BOM/CRLF CSV; bounded JUnit self-closing cases, skipped tests, namespaces, entities, single-quoted attributes, CDATA, strict nesting, and malformed-XML errors.
- Scoring: timezone-mandatory timestamps, post-incident deployment exclusion, environment matching, candidate windows, short/full SHA deployment matching with ambiguity refusal, deployment commit lists, file-overlap/test-overlap separation, coverage-aware confidence, contribution breakdown, missing evidence, deterministic tie-breaking, and bounded why-not explanations.
- Docker image binds `0.0.0.0` inside the container, installs Git, runs as the non-root `node` user, and has a healthcheck and `.dockerignore`.

### Real vertical slice (M1, substantial)

- Versioned bundle v1, field-level validation, and a JSON Schema at `docs/incident-bundle.schema.json`.
- Browser bundle import from disk with validation errors and a server-built, redacted JSON report download.
- CLI: `doctor`, `validate`, `analyze`, `verify`, and `report`.
- Git enrichment with `--repo`: changed files, derived diff risk, candidate-window selection, HEAD/branch/dirty provenance, committer timestamps, unique short-SHA matching, and truncation/matched/unresolved reporting.
- Markdown, JSON, and CSV report export, with timeline, evidence, contributions, verification, caveats, provenance, and deep redaction in Markdown/JSON.
- Real-verification form in the UI when the server enables it.
- Fixture verification remains clearly labeled as stored demo evidence.
- API, security, privacy, contribution, changelog, and root security-policy references.
- GitHub Actions CI matrix on Ubuntu and Windows with Node 22 and 24 (install, tests, smoke, doctor).
- Local `patchtrace ingest` command for merging bundle overrides, deployment CSV, JUnit XML, and Git enrichment, with artifact hashes/parser provenance.
- Report/API evidence references, stricter report request validation, and server-owned fixture verification.

## Remaining work

### Before calling this production-ready

- **Container/VM sandbox** for verification. The current temp-copy runner is best-effort isolation, not a security boundary.
- **Complete API request/response schema validation** beyond the report request contract, and an OpenAPI document. Route-level docs exist in `docs/API.md`.
- **Dependency blast-radius derivation** from a package graph. `dependencyImpact` is currently manual; Git enrichment only derives `diffRisk`.
- **CI matrix execution/validation** on real GitHub runners. The workflow is checked in, but this environment cannot execute GitHub Actions.
- **Large-repository and slow-command performance tests.** A synthetic bundle at the documented collection limits is covered; repository copying/enrichment at scale is not.
- **Persistence and investigation history** are intentionally not implemented; JSON bundles/reports are the current contract.
- **Path scrubbing in report metadata.** Report JSON, Markdown, and CSV are redacted, but local filesystem paths and repository names are not scrubbed. Raw `/api/analyze` responses are not report exports.
- **Accessibility audit** with a browser/AT; keyboard support and labels are in place, but this needs real testing.
- **License and release metadata** decisions.
- **Docker build/runtime validation.** Docker is unavailable in this environment; the Dockerfile is not built here.

### Deliberately out of scope for the first version

- Multi-user auth, cloud storage, external observability integrations, production rollback execution, generic chat, and SQLite.

## Verification commands

```bash
npm ci
npm test
npm run smoke
node bin/patchtrace.mjs doctor --json
```

The test suite covers analysis, bounded parsers, scoring regressions, short/full SHA matching, why-not explanations, API security, report request validation, bundle validation, Git enrichment, ingestion, report rendering, JSON report redaction, injection escaping, CLI behavior, UI static wiring, API report generation, temporary-copy verification, absolute-link source-integrity rejection, dirty-worktree rejection, worktree rejection, path-escape detection, verification concurrency and cancellation, flaky-baseline detection, stale-workspace sweeping, output redaction, bundle collection limits including a synthetic maximum-size analysis/report run, and the Windows `npm` launcher path. The current suite has 87 tests across 12 files.
