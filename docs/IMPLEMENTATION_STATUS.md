# Implementation status

This page records what is actually built, what is verified by tests, and what remains. It is not a substitute for the full production specification in [`PRODUCTION_READINESS.md`](PRODUCTION_READINESS.md).

Last updated: 2026-10-21

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
- Docker image uses a dependency/runtime multi-stage build, binds `0.0.0.0` inside the container, installs Git and CA certificates, runs as the non-root `node` user, and has a readiness-aware healthcheck and `.dockerignore`.
- CLI `doctor` reports local analysis readiness separately from container runtime/image readiness, exposes `productionReady`/`containerRequired`, and fails strictly when `--strict-container` or production isolation requires an unavailable image/runtime.
- Public npm metadata points to the configured GitHub remote, removes the private publication block, declares MIT licensing, and curates the package contents.
- Browser accessibility baseline: skip link, semantic landmarks, labels, live regions, focus handling, keyboard-safe native controls, responsive/zoom behavior, reduced motion, forced-colors/high-contrast fallbacks, and static regression checks.
- Resource and operational guidance covers body/input limits, parser and collection bounds, Git enrichment limits, verification budgets, Docker resources, readiness semantics, and release gates.

### Real vertical slice (M1, substantial)

- Versioned bundle v1, field-level validation, and a JSON Schema at `docs/incident-bundle.schema.json`.
- Browser bundle import from disk with validation errors and a server-built, redacted JSON report download.
- CLI: `doctor`, `validate`, `analyze`, `verify`, and `report`.
- Git enrichment with `--repo`: changed files, derived diff risk, candidate-window selection, HEAD/branch/dirty provenance, committer timestamps, unique short-SHA matching, and truncation/matched/unresolved reporting.
- Markdown, JSON, and CSV report export, with timeline, evidence, contributions, verification, caveats, provenance, and deep redaction in Markdown/JSON.
- Real-verification form in the UI when the server enables it.
- Fixture verification remains clearly labeled as stored demo evidence.
- API, security, privacy, contribution, changelog, and root security-policy references.
- GitHub Actions CI matrix on Ubuntu and Windows with Node 22 and 24 (install, tests, smoke, doctor), plus an Ubuntu Docker image build/start/health/non-root gate.
- Local `patchtrace ingest` command for merging bundle overrides, deployment CSV, JUnit XML, and Git enrichment, with artifact hashes/parser provenance.
- Report/API evidence references, stricter report request validation, and server-owned fixture verification.

## Remaining work

### Before calling this production-ready

- **Live verification-mode container/VM validation.** The constrained runner passes an end-to-end Docker verification on Windows, including a CRLF worktree with a failing candidate that reverted and passed inside the container. A dedicated VM audit and Linux/Podman coverage remain deployment gates.
- **Generated API schema tooling** beyond the dependency-free hand-written route contracts. OpenAPI 3.1 is checked in at `docs/openapi.yaml` and route-level docs exist in `docs/API.md`.
- **Full source-level package-graph analysis** remains deferred. Current Git enrichment derives a transparent dependency-impact heuristic from supported manifests/lockfiles and bounded diff churn; explicit values remain labeled as provided.
- **Large-repository and slow-command performance tests.** A synthetic bundle at the documented collection limits is covered; repository copying/enrichment at scale is not.
- **Persistence and investigation history** are intentionally not implemented; JSON bundles/reports are the current contract.
- **Path scrubbing in raw analysis responses.** Report JSON, Markdown, and CSV scrub absolute local paths while preserving repository-relative evidence. Raw `/api/analyze` responses remain sensitive data.
- **Accessibility audit** with a browser/AT; the static baseline and keyboard/zoom semantics are in place, but this needs real assistive-technology testing.

### Deliberately out of scope for the first version

- Multi-user auth, cloud storage, external observability integrations, production rollback execution, generic chat, and SQLite.

## Verification commands

```bash
npm ci
npm test
npm run smoke
npm run doctor -- --json
npm run security
```

The test suite covers analysis, bounded parsers, scoring regressions, short/full SHA matching, derived dependency impact, why-not explanations, API security/contracts, report request validation, bundle validation, Git enrichment limits, ingestion, report rendering, path scrubbing and JSON redaction, injection escaping, CLI behavior, UI accessibility/static wiring, API report generation, temporary-copy verification, container preflight behavior, absolute-link source-integrity rejection, dirty-worktree rejection, worktree rejection, path-escape detection, verification concurrency and cancellation, flaky-baseline detection, stale-workspace sweeping, output redaction, bundle collection limits including a synthetic maximum-size analysis/report run, and the Windows `npm` launcher path. `npm run test:coverage` is available as an on-demand Node built-in coverage path; no percentage is claimed without running and reviewing it.
