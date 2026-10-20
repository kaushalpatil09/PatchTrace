# PatchTrace product brief

## What we are making

PatchTrace is a local-first tool that helps a small engineering team connect a production incident to the most likely recent code change. It combines deployment timing, changed files, test failures, and risk signals into an inspectable ranking. It can also test a rollback hypothesis in a temporary copy of a Git repository.

The first usable vertical slice now includes:

- a versioned JSON incident bundle that is validated before analysis;
- a deterministic sample incident and a real local bundle import;
- a browser ranking with evidence, coverage, and missing-signal labels;
- a CLI for validation, analysis, real verification, and report export;
- a clearly labeled fixture verification and an opt-in real verification path.

## Why we are making it

A small team may know that a deployment preceded an incident but still spend hours comparing commits, logs, and test output. They need a fast answer to three questions:

1. Which change should we inspect first?
2. What evidence connects that change to the failure?
3. Can we safely reproduce the suspected fix before touching production?

PatchTrace is designed to reduce investigation time without pretending to prove a root cause.

## Who we are making it for

Primary user:

- A technical founder, maintainer, or engineer on a small team.
- They have a Git history, deployment events, and at least some test or incident evidence.
- They cannot or do not want to send private incident data to a third-party service.

Secondary users:

- Open-source maintainers investigating regressions.
- Student or indie teams without a dedicated SRE function.
- Reviewers who need a reproducible incident-analysis demo.

## Constraints

### Build constraints

- Keep the product runnable with the existing Node.js runtime.
- Prefer zero runtime dependencies so it works offline and is easy to audit.
- Keep the core analysis deterministic and unit-testable without the web server.
- Do not require cloud credentials or live integrations.

### Safety constraints

- Never claim certainty from weak evidence.
- Never mutate the original repository during verification.
- Never perform a production rollback.
- Never execute a supplied command without a timeout and an explicit isolation boundary. The current temp-copy runner is best-effort, not a sandbox; real verification is opt-in and labeled accordingly.
- Do not run arbitrary uploaded bundles as code. Bundles are data only.
- Keep secrets out of bundles and reports; verification does not inherit arbitrary environment variables.

### Product constraints

- The product must demonstrate one complete user outcome rather than many disconnected features.
- GitHub, GitLab, Sentry, Slack, hosted accounts, continuous monitoring, and multi-user workspaces remain out of scope.
- The local server is single-user. The session token protects against other browser origins, not other local processes.

## Acceptance criteria

1. A user can open the local PatchTrace page and load the sample incident.
2. A user can load a local incident bundle and see field-level validation errors.
3. The app displays a chronological incident timeline.
4. The app ranks candidate commits with a visible numeric score, coverage, and evidence reasons.
5. The sample regression ranks the intended commit first.
6. A user can inspect changed files, related tests, deployment proximity, and missing signals.
7. A user can run the fixture verification flow and see baseline versus candidate results.
8. When explicitly enabled, a user can run real verification against a trusted local repository.
9. A user can validate, analyze, verify, and export a report from the CLI.
10. The core scoring behavior and safety boundaries are covered by automated tests.
11. The app and tests run without network access.

## Non-goals for this slice

- Uploading repositories or executing arbitrary remote code.
- Production rollback automation.
- Cloud persistence or team collaboration.
- AI-generated root-cause explanations.
- A general observability dashboard.
