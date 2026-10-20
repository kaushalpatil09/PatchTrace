# Contributing to PatchTrace

PatchTrace is a local-first, zero-runtime-dependency incident analyzer. Keep changes small, deterministic, and inspectable.

## Setup

Use Node.js 22 or newer and Git 2.31 or newer. There is no build step and no package installation requirement for the application itself:

```bash
npm test
npm run smoke
node bin/patchtrace.mjs doctor --json
```

## Rules

- Keep `src/core/` framework-independent; analysis must work without the web server.
- Do not mutate a source repository during verification or tests.
- Never execute a command without a timeout and an explicit boundary. The current runner is best-effort temporary-copy isolation, not a sandbox.
- Treat bundles and parser input as untrusted. Validate before scoring or rendering.
- Prefer evidence and uncertainty labels over confident root-cause claims.
- Keep external integrations out of the current product scope.
- Avoid runtime dependencies. A new dependency needs a user-visible capability justification, license review, and lockfile update.
- Add an automated test for each analysis, API, parser, or verification behavior.
- Do not commit secrets, real incident data, or local absolute paths.

## Local workflow

See [`AGENTS.md`](AGENTS.md) for the product layout and checks, [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for data flow, and [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md) for the current gap list.

Windows works without nvm or a POSIX shell. Use the plain `node` commands above. Real repository verification is disabled by default and requires `PATCHTRACE_ENABLE_VERIFY=1`.
