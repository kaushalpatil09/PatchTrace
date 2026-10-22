# PatchTrace production readiness specification

**Status:** Draft for implementation  
**Target:** PatchTrace 1.0 — local-first, single-user incident analysis  
**Last updated:** 2026-10-22

> **Current implementation:** M0 safety controls and a substantial M1 vertical slice are implemented and tested. The constrained container runner, hand-written API contracts and OpenAPI document, dependency-impact heuristic, release metadata, Docker CI job, and resource limits are in place. No live Docker or Podman verification is claimed from this checkout: the current doctor result reports that the Docker daemon is unavailable. Dedicated-VM validation, live container validation, full package-graph analysis, assistive-technology review, and executing the release gates remain open. See [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md) for the verified checklist.

---

## 1. Purpose

This document defines what "production level" means for PatchTrace, what must be built, what must be fixed, and how we will know it is ready.

It is intentionally stricter than the current MVP. The goal is not to turn PatchTrace into a cloud product. The goal is to make the local-first tool **safe, correct, reproducible, observable, and supportable** for a real engineering team.

---

## 2. Production target

### 2.1 Product shape

PatchTrace 1.0 is:

- A **single-user local tool** with a browser UI and a CLI.
- **Offline-first**: no cloud calls, no telemetry, no external services.
- **Deterministic**: the same incident bundle and repository state produce the same analysis.
- **Evidence-first**: every ranking decision is inspectable and tied to a source.
- **Read-only with respect to source repositories**: verification never mutates the repository it is inspecting.
- **Conservative**: uncertainty is displayed; a weak case never produces a confident-sounding answer.

### 2.2 Supported environments

| Area | Requirement |
|---|---|
| Operating systems | Windows 11, macOS 13+, Ubuntu 22.04+ (and equivalent Linux) |
| Node.js | Node 22 LTS or newer; tested on 22 and 24 |
| Git | Git 2.31 or newer |
| Browsers | Current Chrome, Edge, Firefox, Safari |
| Containers | Docker or Podman for the constrained verification mode; if neither is available, production/container verification is unavailable and trusted-local temp-copy mode remains best-effort only |
| Network | Not required after installation; constrained container verification runs with networking disabled |
| Filesystems | NTFS, APFS, ext4; Unicode paths; CRLF and LF inputs |

### 2.3 Trust model

- The **user** is trusted.
- The **local repository** is trusted by default, but it is still treated as potentially hostile code because running its tests executes code.
- **Incident bundles** are untrusted input and must be validated.
- **Remote web pages** are untrusted and must never be able to trigger local analysis or verification.
- **Verification commands** are chosen by the user, but they execute repository code and must run inside an explicit isolation boundary.

### 2.4 Explicit non-goals for 1.0

Do not build these before the local core is production-ready:

- Cloud hosting, accounts, teams, or multi-tenancy.
- GitHub, GitLab, Sentry, Slack, PagerDuty, or CI integrations.
- Continuous monitoring or background alerting.
- AI-generated root-cause explanations or a generic chat interface.
- Production rollback execution or production write access.
- A remote artifact upload service.
- A plugin ecosystem.
- Mobile apps.
- Multi-repository or multi-service incident correlation.

---

## 3. Production definition of done

PatchTrace 1.0 is production-ready only when all of the following are true:

- [ ] A user can load a real, versioned incident bundle, validate it, and see actionable errors for malformed data.
- [ ] A real local Git repository can be analyzed without uploading it anywhere.
- [ ] Timeline and ranking work on real deployment, test, and commit data.
- [ ] Every score is accompanied by factor contributions, evidence provenance, and missing-signal labels.
- [ ] Real rollback verification is available from the UI or CLI, not only through the API.
- [ ] Verification is isolated, bounded, cancellable, and auditable.
- [ ] The source repository is provably unchanged after verification.
- [ ] The same bundle and repository state produce byte-identical analysis JSON.
- [ ] The tool works on Windows and Linux; macOS is verified before release.
- [ ] All P0 and P1 defects in this document are closed.
- [ ] CI runs unit, integration, security, and cross-platform checks.
- [ ] A user can export a Markdown report that clearly separates evidence from uncertainty.
- [ ] Installation, configuration, troubleshooting, security, and limitations are documented.
- [ ] A reproducible release artifact and a license are published.
- [ ] No feature claims are stronger than the implementation.

---

## 4. Required features

Priority key:

- **P0** — required for 1.0 production.
- **P1** — required for a public beta or a credible general release.
- **P2** — deliberately deferred.

### 4.1 Incident bundle and ingestion

| ID | Priority | Requirement | Acceptance criteria |
|---|---|---|---|
| FR-101 | P0 | Versioned JSON incident bundle | Bundle contains `schemaVersion`; unsupported versions fail with a clear message; migrations are documented. |
| FR-102 | P0 | Bundle validation command | `patchtrace validate <bundle>` and UI import both return field-level errors with paths. |
| FR-103 | P0 | Bundle import from disk | User can select or pass a local bundle; no upload or network required. |
| FR-104 | P0 | Artifact provenance | Every artifact records source path, content hash, parser name/version, and ingestion time. |
| FR-105 | P0 | UTC normalization | All timestamps are stored as ISO 8601 UTC with the original value preserved. |
| FR-106 | P0 | Deployment ingestion | CSV and JSON deployment events are supported with validation and duplicate detection. |
| FR-107 | P0 | JUnit ingestion | XML reports are parsed robustly, including self-closing test cases, skipped tests, errors, and namespaces. |
| FR-108 | P0 | Incident event ingestion | Alert, incident, mitigation, and resolution events are supported with a stable event type enum. |
| FR-109 | P0 | Size and count limits | Bundle size, artifact count, event count, and line length limits are enforced with clear errors. |
| FR-110 | P1 | Encoding handling | UTF-8 with optional BOM is supported; invalid encodings are rejected with a clear message. |
| FR-111 | P1 | Archive import | Optional `.zip` support only with traversal, symlink, file-count, size, and compression-ratio protections. |
| FR-112 | P2 | Direct log ingestion | Logs are not parsed until a concrete user-visible need and a bounded parser exist. |

### 4.2 Git repository adapter

| ID | Priority | Requirement | Acceptance criteria |
|---|---|---|---|
| FR-201 | P0 | Local repository validation | Path must exist, be a directory, and be a usable Git worktree. |
| FR-202 | P0 | Git version check | The tool reports a clear error if Git is missing or too old. |
| FR-203 | P0 | SHA resolution | Full and abbreviated SHAs resolve unambiguously; ambiguous SHAs are rejected. |
| FR-204 | P0 | Commit metadata | Commit SHA, timestamp, message, author date, changed files, and change status are captured. |
| FR-205 | P0 | Merge and rename handling | Merge commits and renames are handled explicitly; `--no-renames` or rename detection is documented. |
| FR-206 | P0 | Candidate window | Only commits inside a configurable window before the incident are ranked by default. |
| FR-207 | P0 | Deployment expansion | A deployment SHA can expand to the commits included in that deployment range. |
| FR-208 | P0 | Environment mapping | Production, staging, and other environments are kept separate; production analysis does not use staging deployments as temporal evidence. |
| FR-209 | P0 | Dirty tree policy | The tool reports whether the worktree is dirty and either rejects verification or records the dirty diff explicitly. |
| FR-210 | P0 | Worktree safety | Linked worktrees are rejected unless the implementation can prove isolation. |
| FR-211 | P0 | Submodule safety | Submodules are rejected or handled without modifying the superproject or module metadata. |
| FR-212 | P0 | Shallow/bare repository handling | Shallow and bare repositories fail with specific, actionable errors. |
| FR-213 | P0 | Read-only Git operations | Only read-only Git commands run against the source; hooks, fsmonitor, and filters are disabled or avoided. |
| FR-214 | P0 | Performance limits | Commit, file, diff-size, and history-depth limits are enforced. |
| FR-215 | P1 | Repository provenance | Result records HEAD, branch/ref, dirty state, and relevant Git configuration. |
| FR-216 | P2 | Remote repository cloning | Out of scope for 1.0; local paths only. |

### 4.3 Parsers

| ID | Priority | Requirement | Acceptance criteria |
|---|---|---|---|
| FR-301 | P0 | RFC 4180 CSV parsing | Quoted commas, escaped quotes, CRLF, BOM, and blank lines are handled. |
| FR-302 | P0 | Header validation | Required headers are checked; common aliases are documented; unknown required data fails clearly. |
| FR-303 | P0 | JUnit self-closing tests | `<testcase ... />` is parsed correctly and does not consume the next test. |
| FR-304 | P0 | JUnit skipped tests | `<skipped/>` is reported as skipped, not passed. |
| FR-305 | P0 | JUnit failures/errors | `<failure>` and `<error>` are both failures, with message and type preserved. |
| FR-306 | P0 | XML entities and quoting | Entities are decoded; single- and double-quoted attributes work; CDATA is handled. |
| FR-307 | P0 | Test file mapping | `file`, `classname`, and framework-specific conventions are supported or documented. |
| FR-308 | P0 | Malformed XML reporting | Parse errors include a useful location or reason; the tool never silently returns partial results as complete. |
| FR-309 | P1 | Parser fuzz/limit tests | Huge, deeply nested, and malformed inputs fail within configured limits. |
| FR-310 | P1 | Real report fixtures | Fixtures from Jest, pytest, Maven, and Gradle are included. |
| FR-311 | P2 | Other formats | TAP, TRX, and XUnit are deferred until requested. |

### 4.4 Analysis engine

| ID | Priority | Requirement | Acceptance criteria |
|---|---|---|---|
| FR-401 | P0 | Deterministic timeline | Events are sorted by UTC timestamp and stable tie-breakers; identical input produces identical output. |
| FR-402 | P0 | Incident window | Incident start and optional end are modeled; post-incident events are marked and excluded from causal ranking. |
| FR-403 | P0 | Candidate ranking | Every candidate has a score in `[0, 1]`, a confidence label, factors, and evidence. |
| FR-404 | P0 | Directional temporal signal | Only deployments before the incident and after the commit can contribute positively. |
| FR-405 | P0 | Environment-aware temporal signal | Temporal evidence uses deployments in the incident's environment only. |
| FR-406 | P0 | Deployment-to-commit expansion | Temporal evidence covers all commits included in a deployment, not only the deployment SHA. |
| FR-407 | P0 | No double counting | A file/test relationship contributes once per intended signal; file overlap and test overlap are defined separately. |
| FR-408 | P0 | Computed diff risk | Diff risk is derived from churn, files changed, sensitive paths, test changes, lockfiles, deletions, and binary changes. |
| FR-409 | P0 | Dependency impact | Dependency impact is computed from manifest/lockfile changes, or explicitly labeled as a user-provided signal. |
| FR-410 | P0 | Evidence provenance | Every evidence item references an artifact, event, commit, file, or test source. |
| FR-411 | P0 | Missing-signal reporting | Each suspect lists which signals were unavailable or not applicable. |
| FR-412 | P0 | Coverage-aware confidence | High confidence requires sufficient independent evidence; score alone cannot produce high confidence. |
| FR-413 | P0 | Factor contributions | Output includes weight, raw factor, and weighted contribution for every factor. |
| FR-414 | P0 | Why-not explanation | Each suspect explains what evidence is missing or contradictory relative to the top suspect. |
| FR-415 | P0 | Determinism tests | Same input produces identical JSON across time zones, machines, and repeated runs. |
| FR-416 | P0 | Input validation | Missing fields, wrong types, invalid timestamps, and non-finite numbers produce clear errors instead of silent zeros. |
| FR-417 | P0 | Bounded processing | Maximum commits, files, tests, events, and evidence items are enforced. |
| FR-418 | P1 | Tie-break policy | Ties are resolved by documented, deterministic rules (for example, later deployment proximity, then lower churn). |
| FR-419 | P1 | Duplicate handling | Duplicate commits, deployments, and tests are merged or rejected with provenance. |
| FR-420 | P1 | Score calibration | Weights and thresholds are documented and tested against multiple scenarios. |
| FR-421 | P1 | Property-based tests | Score bounds, monotonicity, and order independence are tested. |
| FR-422 | P2 | Learned ranking | No ML ranking until the deterministic baseline is reliable and explainable. |

### 4.5 Verification

| ID | Priority | Requirement | Acceptance criteria |
|---|---|---|---|
| FR-501 | P0 | Fixture and real modes are distinct | UI and API clearly label fixture-backed results versus real repository verification. |
| FR-502 | P0 | Real verification UI | User can select a repository, candidate, command, and timeout, and see progress and results. |
| FR-503 | P0 | Isolated execution | Verification runs in a container or equivalent sandbox with no network, non-root user, read-only base, and bounded CPU/memory/PIDs. |
| FR-504 | P0 | Source immutability | Source repository content, index, config, hooks, and ignored files are unchanged after verification. |
| FR-505 | P0 | Symlink safety | Symlinks that escape the workspace are rejected; symlinks are not followed into the source. |
| FR-506 | P0 | Worktree rejection | Linked worktrees, `.git` files, submodules, and bare repositories are rejected with clear errors. |
| FR-507 | P0 | Command safety | Commands are argv arrays, never shell strings; executable resolution works on Windows, macOS, and Linux. |
| FR-508 | P0 | Environment allowlist | Verification receives a minimal environment; secrets and unrelated credentials are not inherited. |
| FR-509 | P0 | Timeout and process tree | Overall timeout is enforced; the entire process tree is killed on timeout, including Windows grandchildren. |
| FR-510 | P0 | Cancellation | A user can cancel a run; the child process tree is terminated and cleanup completes. |
| FR-511 | P0 | Baseline stability | Baseline is run at least twice or with an explicit flaky-test policy; inconsistent baselines are reported as inconclusive. |
| FR-512 | P0 | Revert correctness | Single commits and merge commits with `mainline` are supported; conflicts produce a clear `revert_conflict` outcome. |
| FR-513 | P0 | Structured outcome | Outcomes use a stable enum such as `confirmed`, `not_confirmed`, `inconclusive`, `timeout`, `invalid_repo`, `command_error`, `source_changed`. |
| FR-514 | P0 | Output limits and redaction | stdout/stderr are capped, truncation is flagged, and likely secrets are redacted. |
| FR-515 | P0 | Cleanup | Temporary workspaces are removed on success, failure, timeout, cancellation, and crash; stale directories are swept at startup. |
| FR-516 | P0 | Concurrency limit | At most one verification run per process by default; additional requests queue or fail clearly. |
| FR-517 | P0 | Audit record | Each run records command, repo path, SHA, timestamps, duration, exit codes, platform, and isolation mode. |
| FR-518 | P0 | No production actions | There is no code path that writes to production or performs a real rollback. |
| FR-519 | P1 | Resource limits | CPU, memory, disk, and wall-clock budgets are configurable and enforced. |
| FR-520 | P1 | Disk-space check | Verification fails before copying if free space is insufficient. |
| FR-521 | P1 | Copy strategy | `.git`, dependency caches, and build outputs are handled deliberately; repository size is bounded. |
| FR-522 | P2 | Native sandbox backends | Windows Job Objects, macOS `sandbox-exec`, and Linux namespaces can replace the container later. |

### 4.6 Local API and server

| ID | Priority | Requirement | Acceptance criteria |
|---|---|---|---|
| FR-601 | P0 | Local bind by default | Server binds `127.0.0.1` by default; `HOST` is configurable for containers. |
| FR-602 | P0 | Session token | A random token is required for all non-static API calls. |
| FR-603 | P0 | Origin and Host validation | Requests from unexpected origins or hosts are rejected. |
| FR-604 | P0 | Content-type validation | API endpoints require `application/json`; `text/plain` and form posts are rejected. |
| FR-605 | P0 | Body limits | Request body size and parsing time are bounded. |
| FR-606 | P0 | Schema validation | Every API request and response is validated against a documented schema. |
| FR-607 | P0 | Stable error contract | Errors return `{ code, message, details? }` with no stack traces or internal paths. |
| FR-608 | P0 | Separate verify endpoints | Fixture verification and real repository verification are separate routes or explicitly discriminated. |
| FR-609 | P0 | Security headers | CSP, `X-Content-Type-Options`, frame denial, and no-referrer headers are set. |
| FR-610 | P0 | Static file safety | Path traversal and symlink escapes are tested; only intended public files are served. |
| FR-611 | P0 | Graceful shutdown | SIGINT/SIGTERM cancel running verification, clean temp directories, and close the server. |
| FR-612 | P0 | Port error handling | `EADDRINUSE` and invalid `PORT` values produce actionable messages. |
| FR-613 | P0 | Health endpoint | `/api/health` returns version, Git availability, and readiness without exposing secrets. |
| FR-614 | P1 | Request logging | Optional structured logs include method, route, status, duration, and request ID; bodies are not logged. |
| FR-615 | P1 | API documentation | OpenAPI or equivalent documents routes, schemas, errors, and security. |
| FR-616 | P1 | Response versioning | Responses include an API/schema version. |
| FR-617 | P2 | Remote access | Not supported. No LAN or internet exposure. |

### 4.7 Web UI

| ID | Priority | Requirement | Acceptance criteria |
|---|---|---|---|
| FR-701 | P0 | Real bundle import | User can choose a local bundle and see validation results. |
| FR-702 | P0 | Real repository form | User can enter a repository path, candidate SHA, command, timeout, and environment. |
| FR-703 | P0 | Clear fixture/real labels | Sample data and fixture verification are visibly labeled as demo/fixture. |
| FR-704 | P0 | Timeline | Events show date, time, UTC, source, type, and incident-relative position. |
| FR-705 | P0 | Ranking table | Shows score, confidence, rank, commit, changed files, and missing evidence. |
| FR-706 | P0 | Factor breakdown | All five factors show weight, raw value, and weighted contribution. |
| FR-707 | P0 | Evidence detail | Evidence shows source, kind, weight, text, and whether it is derived or provided. |
| FR-708 | P0 | Why-not view | Selected suspect explains missing/contradictory evidence. |
| FR-709 | P0 | Verification progress | Shows queued/running phase, elapsed time, and cancel action. |
| FR-710 | P0 | Verification results | Shows outcome, baseline/candidate results, exit codes, durations, truncation, and warnings. |
| FR-711 | P0 | Error states | Loading, empty, invalid, timeout, and server errors are distinct and actionable. |
| FR-712 | P0 | No stale panels | Selecting a new suspect clears the previous verification result. |
| FR-713 | P0 | No undefined messages | Error rendering always has a fallback message. |
| FR-714 | P0 | Keyboard accessibility | All interactions work with keyboard; focus is visible; cards are buttons/links or have correct roles. |
| FR-715 | P0 | Screen-reader semantics | Landmarks, headings, labels, live regions, and table semantics are correct. |
| FR-716 | P0 | Contrast | Text and controls meet WCAG 2.1 AA contrast. |
| FR-717 | P0 | XSS safety | User data is rendered as text or escaped; CSP blocks inline/unexpected scripts. |
| FR-718 | P0 | Disable duplicate actions | Buttons disable while a request is in flight. |
| FR-719 | P1 | Empty/weak-case demo | A scenario with no reliable suspect is available and clearly explained. |
| FR-720 | P1 | Report preview/export | User can preview and download Markdown and JSON reports. |
| FR-721 | P1 | Responsive layout | Usable at 360px width and at 200% zoom. |
| FR-722 | P1 | Reduced motion | Motion respects `prefers-reduced-motion`. |
| FR-723 | P2 | Deep links | Investigation state can be restored from a local URL fragment or file. |
| FR-724 | P2 | i18n | English only for 1.0; strings are centralized for later translation. |

### 4.8 CLI

| ID | Priority | Requirement | Acceptance criteria |
|---|---|---|---|
| FR-801 | P0 | `patchtrace analyze` | Analyzes a bundle and repository; outputs human-readable or JSON results. |
| FR-802 | P0 | `patchtrace verify` | Runs a bounded rollback verification and returns a structured exit code. |
| FR-803 | P0 | `patchtrace validate` | Validates a bundle without analyzing it. |
| FR-804 | P0 | `patchtrace report` | Produces Markdown/JSON from an analysis result. |
| FR-805 | P0 | `patchtrace doctor` | Checks Node, Git, container runtime, permissions, and supported platform. |
| FR-806 | P0 | Exit codes | `0` success, `1` analysis/verification negative, `2` usage error, `3` environment error, `4` safety refusal. |
| FR-807 | P0 | No shell interpolation | Arguments are passed as argv arrays only. |
| FR-808 | P0 | JSON output | Machine-readable output is stable and versioned. |
| FR-809 | P1 | Config file | Local config supports defaults for timeout, limits, and report path. |
| FR-810 | P1 | Progress output | Long verification runs show phase progress without corrupting JSON mode. |
| FR-811 | P2 | Watch mode | Deferred; monitoring is not a 1.0 feature. |

### 4.9 Reports and exports

| ID | Priority | Requirement | Acceptance criteria |
|---|---|---|---|
| FR-901 | P0 | Markdown report | Includes incident summary, timeline, ranking, evidence, contributions, verification, caveats, and provenance. |
| FR-902 | P0 | JSON export | Includes schema version, generated timestamp, tool version, and complete analysis data. |
| FR-903 | P0 | Uncertainty section | Report explicitly lists missing evidence and limits of the analysis. |
| FR-904 | P0 | Redaction | Likely tokens, passwords, private keys, and environment values are redacted. |
| FR-905 | P0 | Safe filenames | Report filenames are sanitized and cannot escape the chosen directory. |
| FR-906 | P1 | Reproducibility metadata | Report includes bundle hash, repo HEAD, dirty state, platform, and tool version. |
| FR-907 | P1 | Stable format | Report structure is versioned and covered by snapshot tests. |

### 4.10 Packaging, release, and operations

| ID | Priority | Requirement | Acceptance criteria |
|---|---|---|---|
| FR-1001 | P0 | Node and Git requirements | `engines` and documentation match tested versions. |
| FR-1002 | P0 | Reproducible install | `npm ci --ignore-scripts` works from a clean checkout with the checked-in lockfile; after the dependency cache is warm, no install network is required. |
| FR-1003 | P0 | Docker image | Multi-stage build, non-root user, `.dockerignore`, healthcheck, `HOST=0.0.0.0`, and `--init` guidance. |
| FR-1004 | P0 | CI matrix | Ubuntu and Windows run `npm ci --ignore-scripts` and `npm run check`; Ubuntu/Node 22 also runs the lockfile-based `npm run security` audit. |
| FR-1005 | P0 | Release artifacts | Versioned source archive, Docker tag, and checksums. |
| FR-1006 | P0 | SemVer and changelog | Every release has a version, date, changes, and migration notes. |
| FR-1007 | P0 | License | MIT or Apache-2.0 is present and referenced from the README and package metadata. |
| FR-1008 | P0 | Security policy | `SECURITY.md` explains local-only scope, arbitrary command execution, and reporting. |
| FR-1009 | P0 | No telemetry | The app makes no outbound calls; verification runs with networking disabled inside the sandbox. |
| FR-1010 | P1 | Package metadata | Description, repository, license, keywords, and bugs URL are present. |
| FR-1011 | P1 | SBOM/checksums | Release includes dependency inventory (empty is fine) and artifact checksums. |
| FR-1012 | P1 | Upgrade path | Bundle schema and API migrations are documented. |

### 4.11 Documentation and support

| ID | Priority | Requirement | Acceptance criteria |
|---|---|---|---|
| FR-1101 | P0 | README | Status, quickstart, screenshot, real-versus-fixture explanation, limitations, and support path. |
| FR-1102 | P0 | User guide | Bundle format, artifact formats, CLI usage, UI flow, and verification safety. |
| FR-1103 | P0 | Bundle schema documentation | Field-by-field reference with examples and validation rules. |
| FR-1104 | P0 | API documentation | Routes, request/response schemas, errors, auth, and security model. |
| FR-1105 | P0 | Security model | Threat model, trust boundaries, sandbox behavior, and known limitations. |
| FR-1106 | P0 | Troubleshooting | Common failures: Git missing, worktree, shallow clone, port in use, timeout, permissions, disk full. |
| FR-1107 | P0 | Demo script | A two-minute reproducible script using the fixture. |
| FR-1108 | P0 | Limitations | Explicitly state what PatchTrace does not prove. |
| FR-1109 | P1 | Architecture decisions | ADRs for zero dependencies, JSON persistence, container sandbox, and no cloud. |
| FR-1110 | P1 | Contributing guide | Setup, checks, style, test expectations, and security rules. |
| FR-1111 | P1 | Changelog | User-visible changes per release. |
| FR-1112 | P1 | Privacy note | Local-only data handling and what verification may expose. |
| FR-1113 | P0 | Remove stale handoff | Archive or rewrite `PATCHTRACE_SESSION_HANDOFF.md`; no stale absolute paths in public docs. |
| FR-1114 | P0 | Fix missing skill reference | `AGENTS.md` must not reference a nonexistent `.opencode/skills/patchtrace/SKILL.md`. |

---

## 5. Current defects and validation gates

Reconciled 2026-10-22 against commit 7b21c6a plus the local hardening changes. The superseded DEF inventory is preserved in [history](history/PRODUCTION_DEFECTS_2026-10-21.md). See the [dated audit](PRODUCTION_AUDIT_2026-10-22.md) for commands, test evidence, limits and PT-001 through PT-010 status. The original production/ audit documents are preserved unchanged.

| Priority | Current issue / gate | Evidence and required follow-up |
| --- | --- | --- |
| P0 | Live container isolation remains unvalidated locally | Docker daemon unavailable; test:container fails closed. CI now executes the real runner. Resource exhaustion, process-tree, disk quota, disconnect and shutdown checks require further live evidence. |
| P0 | Container workspace is a writable host bind mount without an enforced disk quota | tmpfs has a size limit, but workspace writes can consume host disk. Implement and exercise a bounded workspace before accepting hostile repositories. |
| P0 | Trusted-local verification cannot guarantee host/source immutability against hostile code | Fingerprint covers HEAD/status/config; it is not a complete content or Git-object hash. Use the stronger boundary and obtain real-runtime evidence. |
| P1 | Real-browser and assistive-technology accessibility review is incomplete | Static UI tests and a browser spot check cannot establish WCAG 2.2 AA conformance; axe, keyboard/zoom/screen-reader matrix remain release gates. |
| P1 | Historical incident effectiveness has no external dataset | Offline evaluation harness exists with six related synthetic scenarios; real-world validation stays OPEN. |
| P1 | Release/platform matrix not executed here | Local Windows/Node 24 evidence only; Node 22, Linux, macOS, remote CI and Docker image build remain unverified. |
| P1 | Resource bounds outside API analysis need further scale testing | Worker analysis is bounded; JSON parsing, response transfer/report processing and repository copy still need scale and slow-client measurements. No global rate limiter. |
| P1 | Evidence deduplication policy is incomplete | Duplicate commits are rejected. Duplicate tests/deployments can remain and need an explicit provenance policy. |
| P1 | Dependency evidence is a heuristic | Manifest/lockfile and diff heuristic exists; no complete transitive graph is claimed. |
| P1 | Release signing/provenance and independent audit remain open | Clean tarball install is tested; publication, protected release workflow, provenance and image digest/update validation are not established. |

### Resolved in this hardening pass

- PT-001: untrusted Markdown punctuation is encoded as literal text, line breaks normalized, raw HTML encoded, and provenance fenced with a delimiter longer than any supplied backtick run. Adversarial regression tests cover report fields and block syntax.
- PT-002: compound secret-key names/assignments and credential URLs are redacted; provider, nested canary and false-positive tests added. Redaction metadata says processing is best-effort, not a sharing guarantee.
- PT-003: failed-test paths are indexed once; full counts drive scores. Detail arrays are capped at 20 with truncation metadata. API analysis runs in a worker with single-flight admission, timeout, V8 heap and output budgets. Benchmarks and HTTP/worker regressions are recorded in the audit.
- PT-004: historical claims about missing authentication, parsers, CI, license and packaging moved out of current defects. Existing behavior is covered by the full suite; runtime-sensitive claims remain open above.
- PT-008: CI action tags resolved through official GitHub repositories and pinned to full commits. This does not establish that a remote CI run passed.

Persistence, frameworks, integrations, cloud/accounts, AI ranking, archive uploads, desktop packaging and multiple repositories remain deferred. Production rollback execution remains outside the product.

---

## 6. Security requirements

### 6.1 Threat model

| Threat | Example | Required control |
|---|---|---|
| Cross-origin trigger | Malicious page POSTs to `127.0.0.1:4173/api/verify` | Token, Origin/Host checks, JSON-only content type, no simple-request path. |
| DNS rebinding | Attacker domain resolves to localhost and reads API responses | Validate `Host`; require token; do not trust `Origin` alone. |
| Arbitrary code execution | User-provided command runs repository scripts | Explicit consent, command allowlist or warning, container isolation, no network. |
| Source mutation | Symlink, worktree, submodule, or test writes to source | Reject unsafe layouts; read-only source mount; source snapshot; container. |
| Path traversal | Static file or report path escapes the workspace | Canonicalize and verify prefixes; reject absolute/`..` paths. |
| Symlink escape | Link inside repo points outside | Correct `relative`/`isAbsolute` check; do not follow links out. |
| Zip slip | Archive entry `../../.ssh/authorized_keys` | Reject absolute paths, `..`, symlinks, and special files; enforce size ratios. |
| XML/CSV bomb | Huge or deeply nested artifact | Body/artifact limits, parser depth limits, timeout, no expansion of external entities. |
| Secret leakage | Test output or environment contains tokens | Environment allowlist, redaction, no body logging. |
| XSS | Incident title or test name contains markup | Escape all data, use text nodes, CSP without unsafe-inline. |
| Supply chain | A new dependency is compromised | Zero-dependency default; justify and audit every addition. |
| Local multi-user | Another local user accesses the server or temp files | Bind localhost, token auth, restrictive temp permissions, cleanup. |
| Accidental production action | User expects a real rollback | No production credentials, no production writes, explicit "hypothesis only" messaging. |
| Report leakage | Report contains secrets or private paths | Redaction, path options, review before export. |

### 6.2 Security acceptance criteria

- [ ] No API call can execute code or read repository data without a valid local token.
- [ ] A cross-origin `text/plain` POST is rejected.
- [ ] A request with an unexpected `Host` is rejected.
- [ ] Verification cannot reach the network in isolated mode.
- [ ] Verification cannot write to the source repository.
- [ ] Symlink, worktree, submodule, and path traversal tests fail closed.
- [ ] All user-controlled strings are rendered safely.
- [ ] Secrets are not logged or returned unredacted.
- [ ] `SECURITY.md` documents the trust model and known limitations.
- [ ] No telemetry or outbound call exists except an explicitly configured sandbox.

---

## 7. Data contracts

### 7.1 Core entities

| Entity | Required fields |
|---|---|
| `Incident` | `id`, `title`, `summary`, `environment`, `start`, `end?`, `severity?` |
| `Artifact` | `id`, `kind`, `sourcePath`, `sha256`, `parser`, `parserVersion`, `ingestedAt` |
| `Commit` | `sha`, `timestamp`, `message`, `authorDate?`, `changedFiles[]` |
| `FileChange` | `path`, `status`, `additions?`, `deletions?`, `binary?`, `previousPath?` |
| `Deployment` | `id`, `commitSha` or `commitShas[]`, `timestamp`, `environment`, `sourceArtifactId` |
| `TestResult` | `id`, `name`, `status`, `timestamp?`, `relatedFiles[]`, `errorSignature?`, `durationMs?` |
| `Event` | `id`, `kind`, `timestamp`, `title`, `detail`, `sourceArtifactId?`, `commitSha?` |
| `Suspect` | `sha`, `score`, `confidence`, `factors`, `contributions`, `evidence[]`, `missingSignals[]` |
| `Evidence` | `id`, `kind`, `weight`, `text`, `source`, `derived` |
| `VerificationRun` | `id`, `outcome`, `command[]`, `repoPath`, `head`, `dirty`, `baseline`, `candidate`, `revert`, `durations`, `platform`, `isolation`, `sourceUnchanged` |
| `Report` | `schemaVersion`, `generatedAt`, `toolVersion`, `analysis`, `verification?`, `provenance` |

### 7.2 Contract rules

- Every bundle and API response has a schema version.
- Every artifact is content-hashed.
- Every derived value says whether it is `derived` or `provided`.
- Every timestamp is ISO 8601 UTC.
- Every score is finite and bounded in `[0, 1]`.
- Every error has a stable code and a safe message.
- Unknown fields are ignored or rejected according to a documented policy.

---

## 8. Failure modes and required behavior

| Failure | Expected behavior |
|---|---|
| Bundle is invalid JSON | `400`/CLI exit 2 with line/column and no analysis. |
| Unsupported schema version | Clear migration/unsupported message; no partial analysis. |
| Missing artifact file | Validation error naming the field and path. |
| Invalid timestamp | Validation error; no silent local-time interpretation. |
| Repository path missing | `invalid_repo` with the normalized path and reason. |
| Not a Git repository | `invalid_repo`; do not attempt verification. |
| No commits | `empty_repository`; no ranking. |
| Ambiguous SHA | `ambiguous_sha`; list candidates or require a longer SHA. |
| Candidate unreachable | `candidate_missing_or_unreachable`; do not copy or execute. |
| Shallow clone | Clear error explaining required history. |
| Linked worktree | Reject with `unsupported_worktree`. |
| Submodule | Reject with `unsupported_submodule` unless safely supported. |
| Dirty worktree | Reject by default or record and warn; never silently ignore. |
| Permission denied | `permission_denied` with the path and required access. |
| Disk full | Fail before copy with required/free space. |
| Command not found | `command_error` with resolved executable and platform hint. |
| Timeout | `timeout`, kill the process tree, preserve partial output, clean up. |
| Orphan child | Force-kill process tree; report cleanup warning if it survives. |
| Revert conflict | `revert_conflict` with stdout/stderr and the conflicting paths. |
| Baseline passes | `baseline_did_not_fail`; do not claim rollback confirmation. |
| Flaky baseline | `inconclusive`; recommend rerun or a narrower test command. |
| Output too large | Truncate with a flag; never blow memory. |
| Temp cleanup failure | Return the run result plus `cleanup_warning`; schedule a sweep. |
| Port in use | Friendly `EADDRINUSE` message with the conflict and `PORT` guidance. |
| Client disconnects | Cancel the run, kill the process tree, clean up. |
| Malformed XML | Parser error with location; no partial "complete" result. |
| Huge bundle | Reject with limit details; no OOM. |
| Unicode/long Windows paths | Preserve paths; test `\\?\` handling if needed. |
| CRLF input | Parse correctly; normalize where appropriate. |
| Symlink escape | Reject before execution; no source access. |

---

## 9. Testing and quality gates

### 9.1 Required test layers

- **Unit tests:** parsers, scoring, timeline, confidence, validation, redaction, path checks.
- **Integration tests:** API routes, bundle import, Git adapter, verification lifecycle, report generation.
- **End-to-end tests:** browser flow for import → analyze → inspect → verify → export.
- **Security tests:** CSRF, Origin/Host, content-type, body limits, traversal, symlink escape, worktree, submodule, command injection, output redaction.
- **Cross-platform tests:** Windows and Linux in CI; macOS before release.
- **Determinism tests:** fixed `TZ`, repeated runs, shuffled input order, stable JSON snapshots.
- **Property-based tests:** score bounds, monotonicity, factor contributions, no NaN/Infinity.
- **Performance tests:** synthetic repository with commits/files; enforce budgets.
- **Failure tests:** every row in section 8 has at least one test.

### 9.2 CI gates

The checked-in `.github/workflows/ci.yml` currently runs this local gate on every Ubuntu/Windows and Node 22/24 matrix entry:

```bash
npm ci --ignore-scripts
npm run check
```

The Ubuntu/Node 22 matrix entry also runs the release security gate:

```bash
npm run security
```

That script is `npm audit --package-lock-only --omit=dev --audit-level=high`: the dependency graph comes from the checked-in lockfile, while advisory results come from the configured npm registry and can change over time. `npm run test:coverage` is available locally but is not currently a CI gate. `npm run lint` and `npm run test:security` are future gates, not scripts in the current package.

Plus:

- [ ] Windows and Ubuntu matrix.
- [ ] Docker build and container health check.
- [ ] No network calls in tests.
- [ ] No high-severity security findings.
- [ ] Core coverage target: 80% lines and branches.
- [ ] Snapshot tests for report output and analysis JSON.
- [ ] CLI doctor passes on both platforms.

### 9.3 Required fixtures

- Strong-evidence incident (current VAT sample).
- Weak-evidence incident with no reliable suspect.
- Red-herring incident with a plausible but wrong commit.
- Merge/deployment-range incident.
- Staging-versus-production deployment scenario.
- Post-incident deployment scenario.
- Dirty worktree scenario.
- Linked worktree and submodule scenarios.
- Real JUnit reports from Jest, pytest, Maven, and Gradle.
- CSV with BOM, quotes, CRLF, and invalid rows.

---

## 10. Performance and limits

Proposed defaults, all configurable:

| Limit | Default |
|---|---:|
| Bundle size | 25 MB |
| Single artifact size | 10 MB |
| Artifact count | 50 |
| Commits analyzed | 5,000 |
| Changed files per commit | 2,000 |
| Timeline events rendered | 2,000 |
| Failing tests parsed | 5,000 |
| Verification timeout | 30 s |
| Maximum verification timeout | 10 min |
| stdout/stderr cap | 256 KB per stream |
| Concurrent verifications | 1 |
| Repository copy size | 2 GB |
| Temp disk free reserve | 2 GB |
| Analysis p95 (typical bundle) | < 2 s |
| UI first render after load | < 500 ms |
| Verification overhead beyond test time | < 5 s |

Performance requirements:

- Precompute deployment and test indexes instead of scanning per commit.
- Avoid O(n²) output accumulation in the command runner.
- Stream or paginate large timelines.
- Skip or explicitly handle `node_modules`, build caches, and logs when copying.
- Fail fast on disk, memory, or time limits.

---

## 11. Packaging and release

### 11.1 Release gates

- [ ] `npm ci --ignore-scripts` from a clean checkout.
- [ ] `npm test` on Windows and Linux.
- [ ] `npm run smoke` on Windows and Linux.
- [ ] Docker image builds, runs as non-root, passes health check, and serves the UI.
- [ ] CLI `doctor`, `analyze`, `verify`, and `report` work on both platforms.
- [ ] Real bundle → analysis → verification → report works end-to-end.
- [ ] No P0/P1 defects open.
- [ ] Changelog and migration notes are present.
- [ ] License and security policy are present.
- [ ] Release artifact checksums are published.

### 11.2 Distribution

- npm package for the CLI/server.
- Docker image for isolated verification and demo use.
- Source archive.
- Optional standalone binary later; not required for 1.0.

### 11.3 Versioning

- SemVer for the package.
- Separate `schemaVersion` for incident bundles.
- Separate `apiVersion` for HTTP responses.
- Report format version.
- Backward-compatible readers for at least one previous schema version.

---

## 12. Observability and operations

- Structured logs with level, timestamp, request ID, route, status, and duration.
- Debug mode is opt-in; bodies and secrets are never logged.
- Verification audit record includes command, repo, SHA, durations, outcome, isolation, and cleanup status.
- `/api/health` reports version, Git availability, container availability, and temp-directory writability.
- Startup sweeps stale `patchtrace-*` temp directories.
- Graceful shutdown cancels runs and cleans temp dirs.
- Local log rotation or a size cap.
- No telemetry, analytics, or remote logging.
- A `doctor` command checks Node, Git, container runtime, permissions, and paths.

---

## 13. Accessibility and UX quality

- WCAG 2.1 AA for the core flow.
- Full keyboard operation: import, select suspect, verify, cancel, export.
- Visible focus indicators.
- Correct roles, labels, and live-region announcements.
- No color-only meaning for confidence or status.
- Text alternatives for icons and status pills.
- Responsive at 360px and 200% zoom.
- Respect reduced motion.
- Clear distinction between fixture/demo data and real repository data.
- No stale results after changing selection.
- Errors always have a human-readable message and a next action.

---

## 14. Roadmap

### Milestone M0 — Safety and truth (1–2 days)

Scope:

- Fix Docker bind and add `HOST`.
- Add `.dockerignore`, non-root user, healthcheck.
- Fix symlink guard.
- Reject worktrees and `.git` files.
- Fix Windows command resolution.
- Add token, Origin/Host, content-type checks.
- Rename or disable "sandboxed" claims.
- Add regression tests for all of the above.

Exit criteria: no known source-mutation or cross-origin-trigger path; Docker works; Windows default verification works.

### Milestone M1 — Real vertical slice (4–6 days)

Scope:

- Versioned bundle schema and validation.
- Local Git adapter.
- Robust CSV and JUnit parsers.
- Real bundle import UI or CLI.
- Real verification UI or CLI.
- Markdown report export.

Exit criteria: one real repository and one real bundle go from import to report without manual API calls.

### Milestone M2 — Evidence quality (2–3 days)

Scope:

- Directional temporal scoring.
- Environment filtering.
- Deployment-to-commit expansion.
- Candidate window.
- Remove double counting.
- Computed or labeled diff/dependency signals.
- Coverage-aware confidence.
- Factor contributions, provenance, and why-not explanations.

Exit criteria: every score is auditable; weak-evidence scenarios produce low confidence; the sample no longer depends on hand-authored ranking inputs to look strong.

### Milestone M3 — Production hardening (3–5 days)

Scope:

- Container sandbox with no network and resource limits.
- Process-tree kill, cancellation, queue, cleanup, redaction.
- API schemas, limits, security headers, structured errors.
- Accessibility pass.
- Cross-platform CI.
- Security tests.
- Performance limits and benchmarks.

Exit criteria: security checklist and failure-mode matrix pass on Windows and Linux.

### Milestone M4 — Release (1–2 days)

Scope:

- Docs: README, user guide, schema, API, security, troubleshooting, demo.
- License, changelog, contributing.
- Screenshot/GIF and demo script.
- Versioned artifacts and checksums.
- Remove or archive stale handoff.

Exit criteria: a new user can install, load a real bundle, analyze, verify, and export a report using only the documentation.

---

## 15. Production acceptance checklist

### Functional

- [ ] Real incident bundle import and validation.
- [ ] Real Git repository adapter.
- [ ] Robust deployment CSV/JSON ingestion.
- [ ] Robust JUnit ingestion.
- [ ] Timeline with UTC timestamps and incident window.
- [ ] Ranked suspects with all five factors.
- [ ] Evidence provenance and missing-signal labels.
- [ ] Real verification from UI or CLI.
- [ ] Markdown and JSON report export.
- [ ] CLI analyze/verify/validate/report/doctor.
- [ ] Deterministic fixture demo remains available.

### Correctness

- [ ] No post-incident temporal credit.
- [ ] Environment-aware deployments.
- [ ] Deployment-to-commit expansion.
- [ ] No double counting.
- [ ] Diff risk computed or labeled.
- [ ] Dependency impact computed or labeled.
- [ ] Coverage-aware confidence.
- [ ] Deterministic JSON across time zones and repeated runs.
- [ ] Parser fixtures from real tools pass.
- [ ] Weak-evidence and red-herring scenarios behave correctly.

### Security

- [ ] Session token and Origin/Host validation.
- [ ] JSON-only API content type.
- [ ] Body limits and schema validation.
- [ ] Container isolation with no network.
- [ ] Source immutability proven by tests.
- [ ] Symlink/worktree/submodule rejection.
- [ ] Path traversal and static-file safety.
- [ ] Output redaction.
- [ ] No telemetry.
- [ ] Security headers and CSP.
- [ ] `SECURITY.md` published.

### Reliability

- [ ] Timeout kills the full process tree.
- [ ] Cancellation cleans up.
- [ ] Cleanup never masks results.
- [ ] Stale temp directories are swept.
- [ ] Disk and resource limits enforced.
- [ ] Graceful shutdown.
- [ ] Port conflict handling.
- [ ] Failure-mode tests pass.

### Performance

- [ ] Analysis p95 budget met.
- [ ] Verification overhead budget met.
- [ ] Large bundle/repo limits enforced.
- [ ] UI remains responsive with 2,000 events.
- [ ] Memory stays bounded.

### UX and accessibility

- [ ] Real versus fixture is obvious.
- [ ] All factors and contributions visible.
- [ ] Loading, empty, error, and timeout states.
- [ ] No stale verification panel.
- [ ] Keyboard and screen-reader operation.
- [ ] Contrast and zoom pass.
- [ ] Mobile layout usable.

### Operations and release

- [ ] CI matrix passes on Windows and Linux.
- [ ] Docker image builds and runs.
- [ ] `npm ci --ignore-scripts`, `npm run check`, and the Ubuntu/Node 22 `npm run security` gate pass.
- [ ] CLI doctor passes.
- [ ] License, changelog, contributing, and security docs present.
- [ ] Release artifacts and checksums published.
- [ ] No stale docs or missing-file references.
- [ ] README has a screenshot, demo, and limitations.

---

## 16. Open decisions

| Decision | Options | Recommendation |
|---|---|---|
| Primary interface | UI first, CLI first, both | CLI first for real use; UI for demo and inspection. Share the same core. |
| Verification isolation | Temp copy only, container, native sandbox | Container for 1.0. Temp copy is a fallback with an explicit warning, not a sandbox. |
| Persistence | JSON bundles, SQLite, both | JSON bundles. No database until multiple investigations and queries exist. |
| XML parsing | Hand-rolled, one vetted dependency | Prefer one well-tested XML parser if it materially improves correctness; otherwise implement a bounded parser and test real fixtures. |
| Diff risk | Provided, heuristic, external | Heuristic from local diff data, with the inputs visible. |
| Dependency impact | Provided, manifest diff, graph | Start with manifest/lockfile diff; label it as an approximation. |
| Deployment model | One SHA, commit list, range | Support release SHA plus commit range; accept an explicit list for flexibility. |
| Confidence semantics | Probability, ordinal, coverage-based | Ordinal ranking confidence plus evidence coverage; never call it a probability. |
| Report format | Markdown only, Markdown + JSON | Both. Markdown for humans; JSON for automation. |
| License | MIT, Apache-2.0 | MIT for simplicity, or Apache-2.0 if patent protection matters. |
| Distribution | npm, Docker, binary | npm + Docker for 1.0; binary later. |
| Supported OS | Windows only, Windows + Linux, all three | Windows + Linux in CI, macOS verified before release. |
| Archive upload | Now, later | Later, only with full traversal/symlink/size protections. |
| Multi-user | Now, later | Never for the local-first 1.0. |

---

## 17. Revision history

| Date | Change |
|---|---|
| 2026-10-20 | Initial production-readiness specification based on full code and documentation review. |
