# Contributing to PatchTrace

PatchTrace is a local-first, zero-runtime-dependency incident analyzer. Keep changes small, deterministic, and inspectable.

## Setup

Use Node.js 22 or newer and Git 2.31 or newer. There is no build step and no package installation requirement for the application itself:

```bash
npm test
npm run smoke
npm run doctor -- --json
npm run security
```

Before opening a release-oriented change, run the focused gates and the complete local gate when the environment permits:

```bash
npm run test:ui
npm run test:cli
npm run check
npm run test:coverage
```

The coverage command uses Node's built-in instrumentation; report the command as run only when its output has actually been collected. `npm run security` audits the dependency graph and should be run with the normal npm registry access available.

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
- Keep the public package metadata, `LICENSE`, and release notes in sync when changing release-facing behavior.
- Keep the browser UI usable at 200% zoom, with keyboard-only input, visible focus, reduced motion, and high-contrast/forced-colors modes.

## Local workflow

See [`AGENTS.md`](AGENTS.md) for the product layout and checks, [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for data flow, and [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md) for the current gap list.

Windows works without nvm or a POSIX shell. Use the plain `node` commands above. Real repository verification is disabled by default and requires `PATCHTRACE_ENABLE_VERIFY=1`. Production-isolation verification additionally requires a locally available Docker or Podman runtime and a pre-built image; `npm run doctor -- --json` reports both local and container readiness.

## Docker and release checks

Build and run the image as the non-root `node` user, then verify `/api/health` and the Docker health state before publishing an image. The GitHub Actions `docker` job performs those checks on Ubuntu; this repository does not assume Docker is installed on every contributor workstation.

The package is MIT licensed and configured for public npm distribution. Keep release artifacts reproducible with `npm ci --ignore-scripts`, `npm test`, `npm run smoke`, `npm run security`, and the doctor check. Do not claim a Docker, coverage, or remote CI result unless that check actually ran.
