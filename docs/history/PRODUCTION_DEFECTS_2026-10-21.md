# Historical defect inventory — superseded 2026-10-22

This preserves the original inventory for traceability. Rows are historical hypotheses, not current defect claims. Current evidence: ../PRODUCTION_AUDIT_2026-10-22.md.

## 5. Current defects to fix

### 5.1 P0 release blockers

| ID | Area | Problem | Required fix |
|---|---|---|---|
| DEF-001 | API security | `/api/verify` executes arbitrary argv in a local repo with no token, Origin, Host, or content-type checks. A malicious page can send a `text/plain` POST without a CORS preflight. I confirmed `POST /api/analyze` with `text/plain` returns 200. | Add a session token, validate `Host`/`Origin`, require `application/json`, disable real verification unless explicitly enabled, and test cross-origin attempts. |
| DEF-002 | Verification | The "sandbox" is only a temp directory. The command inherits full filesystem, environment, and network access. | Run verification in a container with no network, non-root user, read-only base, and resource limits. Until then, rename the feature and warn loudly. |
| DEF-003 | Verification | Symlink guard bypass: `verification.mjs:112` misses `rel === '..'` and absolute paths on another drive. I confirmed parent and cross-drive targets are treated as inside. | Use `rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)`; add symlink escape tests. |
| DEF-004 | Verification | Copying a linked Git worktree copies a `.git` file that points to the original gitdir. I confirmed `git revert` in the copy changed the original worktree's index (`MM state.txt`). | Reject `.git` files and linked worktrees; add a regression test that asserts the original index is unchanged. |
| DEF-005 | Verification | Default `['npm', 'test']` fails on Windows with `ENOENT` because npm is `npm.cmd` and `shell: false`. I confirmed this. | Resolve commands using `PATHEXT`, or special-case `npm.cmd`/`npx.cmd`; add Windows CI coverage. |
| DEF-006 | Docker | `server.mjs:95` binds `127.0.0.1`; container port publishing cannot reach it. | Add `HOST` support, default `127.0.0.1`, set `HOST=0.0.0.0` in Docker, and test `docker run -p`. |
| DEF-007 | JUnit parser | Self-closing `<testcase ... />` consumes the next `</testcase>`, corrupting results. I confirmed a passed case was marked failed with the next failure's message. | Rewrite the parser to handle self-closing elements, skipped tests, entities, quoting, and malformed XML with tests. |
| DEF-008 | Scoring | Post-incident deployments get `temporal = 1.0` because negative durations clamp to zero. I confirmed a 15:00 deployment against a 14:09 incident scores 0.87 and says "0 minutes before." | Add directionality: only deployments before incident start can contribute; penalize or exclude later events. |
| DEF-009 | Scoring | `deploymentFor` ignores environment. A staging deployment can justify a production incident. | Filter deployments by incident environment; test production versus staging. |
| DEF-010 | Scoring | Commits after incident start are still ranked; there is no candidate window. | Add `incidentEnd` and a configurable candidate window; exclude post-incident commits by default. |
| DEF-011 | Scoring | Deployment matching is exact-SHA only; real deployments usually reference one release/merge SHA covering many commits. | Expand a deployment to its commit range, or accept an explicit commit list. |
| DEF-012 | Scoring | The failing test's file is counted in file overlap and the failing test is counted again in test overlap. | Define file overlap against incident files only, and test overlap separately; add a regression test. |
| DEF-013 | Scoring | High confidence is score-only. The fixture's 0.801 high label drops to 0.729 (medium) without the hand-authored `dependencyImpact: 0.72`. `diffRisk` and `dependencyImpact` are not computed. | Add evidence coverage and require independent signals for high confidence; compute or label provided signals explicitly. |
| DEF-014 | Verification | Source snapshot only compares HEAD and `git status --porcelain`; ignored files, `.git/config`, hooks, and objects are not compared. | Use a stronger snapshot or container isolation; at minimum hash tracked, untracked, and ignored files and protect Git metadata. |

### 5.2 P1 defects and gaps

| ID | Area | Problem | Required fix |
|---|---|---|---|
| DEF-015 | API | No request body limit; `readJsonBody` buffers the entire body. | Add byte and time limits; return 413/400 with a stable error code. |
| DEF-016 | API | No content-type validation or schema validation. | Require JSON, validate with a schema, and return field-level errors. |
| DEF-017 | Verification | Timeout can hang if the child does not close; Windows grandchildren can survive. | Force-resolve after a grace period; kill the full process tree; add a test with a grandchild. |
| DEF-018 | Verification | `rm()` in `finally` can throw and mask the verification result. | Wrap cleanup; report cleanup status separately; never lose the run result. |
| DEF-019 | Verification | Dirty source policy is undefined; baseline may not represent the deployed commit. | Reject dirty repos by default or record the dirty diff and warn; test both. |
| DEF-020 | Verification | No cancellation, queue, or concurrency limit. | Support abort, default concurrency 1, and queue or reject additional runs. |
| DEF-021 | Verification | No output redaction; test output may contain secrets. | Redact likely credentials and tokens; mark redactions. |
| DEF-022 | Verification | No stale temp cleanup on crash. | Sweep `patchtrace-*` directories at startup; register cleanup handlers. |
| DEF-023 | Verification | Submodules, bare repos, shallow clones, and LFS are not handled explicitly. | Reject with specific errors or support deliberately; document. |
| DEF-024 | Verification | `status: 'passed'/'failed'` conflates hypothesis outcome with command outcome. | Use a structured outcome enum plus separate baseline/candidate statuses. |
| DEF-025 | Verification | No audit record of command, environment, Git state, or isolation mode. | Add an audit record and optional local log. |
| DEF-026 | Analysis | Timestamps without an offset are interpreted in the local timezone. I confirmed a 5.5-hour difference. | Require ISO 8601 with `Z`/offset or reject naive timestamps; pin `TZ` in tests. |
| DEF-027 | Analysis | `clamp()` silently converts NaN/Infinity to 0, hiding bad input. | Validate finite numbers and report invalid fields. |
| DEF-028 | Analysis | `scoreCommit` tie-breaks by lexical timestamp comparison. | Normalize timestamps and document a deterministic tie-break. |
| DEF-029 | Analysis | No duplicate handling for commits, deployments, or tests. | Deduplicate with provenance or reject duplicates. |
| DEF-030 | Analysis | No per-suspect missing-signal model; warnings only appear when the top suspect is low confidence. | Add `missingSignals` and coverage per suspect; render them. |
| DEF-031 | Analysis | No evidence provenance; evidence text has no source. | Add `source` references to artifacts/events/commits/tests. |
| DEF-032 | Analysis | No "why not" explanation for lower-ranked suspects. | Add missing/contradictory evidence relative to the top suspect. |
| DEF-033 | CSV | BOM, quoted commas, escaped quotes, missing headers, and invalid timestamps are not handled. | Implement RFC 4180 parsing and validation; add fixtures. |
| DEF-034 | JUnit | Skipped tests count as passed; entities, single quotes, CDATA, and `classname`-only tests are not handled. | Fix and test with real reports. |
| DEF-035 | UI | Dependency impact is not displayed, despite "every ranking signal is inspectable." | Show all five factors and contributions. |
| DEF-036 | UI | No score contribution breakdown or formula. | Show weight, raw value, and weighted contribution. |
| DEF-037 | UI | Selecting a new suspect leaves the old verification panel visible. | Clear/hide the panel on selection change. |
| DEF-038 | UI | Server errors render `new Error(undefined)` as "undefined." | Use a fallback message and stable error code. |
| DEF-039 | UI | Fixture verification button says "sandboxed," but only reads fixture JSON. | Label fixture mode clearly; reserve "sandboxed" for real isolation. |
| DEF-040 | UI | No real bundle import or real repository verification form. | Add the real flow or label the UI as demo-only. |
| DEF-041 | UI | Suspect cards are clickable articles without keyboard support. | Use buttons or add role/tabindex/key handlers; test keyboard flow. |
| DEF-042 | UI | Rank display produces `010` for rank 10. | Pad only values below 10. |
| DEF-043 | UI | Timeline omits date and timezone; only `HH:mm` UTC is shown. | Show date, time, and `UTC`; handle multi-day incidents. |
| DEF-044 | UI | No loading/empty/error state beyond a status line. | Add distinct states, disable actions, and show retry paths. |
| DEF-045 | API | `/api/verify` returns different shapes depending on `repoPath`. | Split fixture and repository endpoints or add an explicit discriminator. |
| DEF-046 | API | No response schema version. | Add `apiVersion`/`schemaVersion` to responses. |
| DEF-047 | API | No security headers or CSP. | Add CSP, nosniff, frame denial, and referrer policy. |
| DEF-048 | API | No graceful shutdown, health endpoint, or friendly `EADDRINUSE`. | Add signal handling, `/api/health`, and port error messages. |
| DEF-049 | API | Raw internal error messages are returned to clients. | Map to stable codes and safe messages; log details locally. |
| DEF-050 | Docker | No `.dockerignore`; `.git`, tests, docs, and potentially `.env` are copied. Image runs as root. | Add `.dockerignore`, `USER node`, healthcheck, and `--init` guidance. |
| DEF-051 | Smoke | Fixed port `4174`; can conflict in CI. | Use an ephemeral port and parse the listening line. |
| DEF-052 | Tests | No API tests, no Windows CI, no parser edge cases, no symlink/worktree/dirty/timeout-tree tests. | Add the test matrix in section 9. |
| DEF-053 | Tests | No determinism/property tests for score bounds, monotonicity, or timezone independence. | Add property tests and a fixed-`TZ` determinism test. |
| DEF-054 | Tests | No end-to-end UI test. | Add a browser test or a documented manual checklist before release. |
| DEF-055 | Tests | No performance/limits benchmark. | Add a synthetic repo benchmark and enforce budgets. |
| DEF-056 | Docs | `AGENTS.md:30` references a missing `.opencode/skills/patchtrace/SKILL.md`. | Add the skill or remove the reference. |
| DEF-057 | Docs | `docs/PRODUCT.md:5` says the verification adapter is "later"; it exists. | Update the product brief. |
| DEF-058 | Docs | `docs/ARCHITECTURE.md` plans React/Fastify/SQLite, conflicting with the zero-dependency constraint. | Mark as optional future or replace with the actual decision. |
| DEF-059 | Docs | `TODO.md` says CSV/JUnit parsers are not started; basic versions exist. | Mark "basic" versus "robust" accurately. |
| DEF-060 | Docs | Handoff contains stale absolute paths and buildathon notes. | Archive it under `docs/history/` or rewrite it. |
| DEF-061 | Repo | No `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`, or CI workflow. | Add all four before public release. |
| DEF-062 | Repo | `package.json` lacks description, repository, license, and bugs metadata. | Add metadata. |
| DEF-063 | Repo | No screenshot, demo GIF, or "real vs fixture" section in README. | Add them. |
| DEF-064 | Accessibility | No focus-visible styles, ARIA selection semantics, or keyboard-operable suspect list. | Meet WCAG 2.1 AA for the core flow. |
| DEF-065 | Privacy | No explicit no-telemetry/privacy statement or data-handling doc. | Add a privacy note and verify no outbound requests in tests. |
| DEF-066 | Supply chain | Zero runtime dependencies is good, but no policy exists for future additions. | Require justification, lockfile, audit, and license review for every dependency. |

### 5.3 P2 / deliberately deferred

| ID | Item | Decision |
|---|---|---|
| DEF-201 | SQLite persistence | Use versioned JSON bundles instead; revisit only for multi-investigation queries. |
| DEF-202 | React/Fastify migration | Not justified; keep the dependency-free UI and Node HTTP server. |
| DEF-203 | GitHub/Sentry/Slack integrations | Out of scope until the local core is reliable. |
| DEF-204 | Cloud/team/auth | Out of scope for a local-first 1.0. |
| DEF-205 | AI root-cause explanations | Conflicts with the evidence-first product. |
| DEF-206 | Archive upload | Defer until traversal, symlink, zip-bomb, and size protections are implemented. |
| DEF-207 | Desktop packaging | Consider after CLI and UI are stable. |
| DEF-208 | Multi-repo analysis | Out of scope for 1.0. |
| DEF-209 | Continuous monitoring | Out of scope for 1.0. |
| DEF-210 | Production rollback | Never a product feature. |

---
