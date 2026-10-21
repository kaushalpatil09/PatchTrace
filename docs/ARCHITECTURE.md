# PatchTrace architecture

## Design principle

The evidence engine is the product. The browser UI and CLI are thin local shells around it. Keep the core pure and framework-independent so the same logic can power automation, a future desktop app, or a CI job without a rewrite.

## Current system

```text
Browser UI (public/)                 CLI (bin/patchtrace.mjs)
        |                                      |
        | HTTP JSON + session token            | local files
        v                                      v
Local Node server (server.mjs)        Core modules (src/core/)
        |                                      |
        +------------------+-------------------+
                           |
        +------------------+-------------------+
        |                  |                   |
  analysis.mjs       git-adapter.mjs      verification.mjs
  timeline/scoring   repository reads     temp-copy rollback
  bundle validation                       timeout/safety
        |                  |                   |
        +------------------+-------------------+
                           |
                    report.mjs
                    JSON / Markdown / CSV
```

There is no database and no external service call. Incident bundles and reports are JSON/Markdown/CSV files. The sample incident is a versioned JSON fixture loaded from disk. Git enrichment reads a normal local clone; it does not upload the repository.

## Data flow

1. Read and validate a versioned incident bundle.
2. Optionally enrich matching commits from a local Git repository: changed files and a Git-derived diff-risk signal.
3. Normalize timestamps to UTC while preserving the original timestamp strings.
4. Build one ordered timeline with before/during/after phases.
5. Filter candidates by the incident window and environment.
6. Score each candidate with explicit factors, contributions, coverage, and evidence.
7. Render the ranking in the UI, JSON, Markdown, or CSV.
8. Optionally run a real rollback hypothesis check in a temporary copy, never the source working tree.
9. Record provenance (bundle hash, repository HEAD/branch/dirty state, tool version) and export a report.

## Scoring contract

The score is deterministic and bounded between 0 and 1:

```text
temporal proximity       30%
incident-file overlap    25%
test overlap             20%
diff risk                15%
dependency impact        10%
```

Each suspect returns:

- `factors`: the raw 0–1 values;
- `contributions`: `weight × factor` for every signal;
- `coverage` and `missingSignals`: how many of the five signals are actually available;
- `signalSources`: `derived`, `provided`, or `missing`;
- `evidence`: human-readable items with a source and origin.

Confidence is deliberately conservative: high confidence requires both a high score and at least 80% signal coverage. Post-incident deployments and deployments before the commit receive zero temporal credit. Missing evidence is displayed, never silently replaced with a high score.

## Core entities

- `IncidentBundle`: versioned incident input (`schemaVersion: 1`).
- `Commit`: SHA, timestamp, message, changed files, optional risk signals.
- `Deployment`: one or more commit SHAs, environment, timestamp.
- `TestResult`: name, status, related files, failure signature.
- `Event`: normalized timeline entry with a phase.
- `Suspect`: scored commit with factors, contributions, coverage, and evidence.
- `VerificationRun`: two-run baseline versus candidate result, revert outcome, cancellation/timeout state, source-unchanged check, audit timing, and cleanup state.
- `Report`: schema version, generated time, tool version, redacted analysis, verification, provenance, and redaction count.

## Safety boundaries

- The source repository is never the verification command's working directory.
- Verification refuses linked worktrees, submodule checkouts, bare repos, shallow clones, filesystem roots, and symlinks that resolve outside the repository.
- Commands run with argv arrays and an environment allowlist. Windows `.cmd`/`.bat` launchers use an explicit `cmd.exe` invocation.
- Timeouts and cancellation terminate the process tree and force resolution after a grace period.
- Command output is capped and best-effort redacted before it leaves the runner. Report exports apply the same best-effort rules to nested strings.
- Source safety is checked before and after a run; a changed source invalidates a successful result.
- Real repository verification is disabled unless `PATCHTRACE_ENABLE_VERIFY=1`.
- The default temporary-copy runner is **best-effort isolation, not a sandbox**. Production mode uses a constrained Docker/Podman runner and fails closed when its runtime or image is unavailable; a dedicated VM remains the stronger boundary.

## Extension points

- `RepositoryAdapter`: currently `src/core/git-adapter.mjs`.
- `ArtifactParser`: CSV and JUnit parsers in `analysis.mjs`; add parsers behind the same normalized shapes.
- `VerificationRunner`: temp-copy by default, with a constrained Docker/Podman runner for production mode; a native VM backend remains an extension point.
- `ReportRenderer`: `src/core/report.mjs`.

## Technical trade-off

The implementation uses Node.js built-ins and a dependency-free browser UI so it stays portable, offline, and easy to audit. The cost is more hand-written validation and a smaller ecosystem. Do not introduce a framework or database until it buys a concrete user-visible capability; the current bottleneck is verification isolation and evidence quality, not web plumbing.
