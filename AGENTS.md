# PatchTrace contributor guide

## Product focus

PatchTrace is a local-first incident-to-change analyzer for small engineering teams. The first useful flow is:

> Load a reproducible incident bundle -> build a timeline -> rank likely commits with inspectable evidence -> verify a rollback hypothesis safely.

Do not turn the first version into a generic chatbot, cloud observability dashboard, or production rollback tool.

## Working rules

- Preserve offline operation and deterministic behavior.
- Keep the analysis engine framework-independent and testable without the web server.
- Never mutate the source repository during verification.
- Never execute an uploaded command without a timeout and an explicit sandbox boundary.
- Prefer evidence and uncertainty labels over confident root-cause claims.
- Keep external integrations out of the MVP.
- Use the existing Node.js runtime and avoid dependencies unless they are necessary for a user-visible capability.
- Add a meaningful automated test for each new analysis behavior.

## Project layout

- `docs/PRODUCT.md`: users, problem, constraints, acceptance criteria.
- `docs/ARCHITECTURE.md`: system design and data flow.
- `src/core/`: pure analysis logic.
- `public/`: dependency-free browser UI.
- `fixtures/`: deterministic demo data.
- `tests/`: Node built-in test suite.
- [`SKILL.md`](SKILL.md): local workflow guidance for future agents.

## Checks

Run from the repository root:

```bash
npm test
npm run smoke
```

`npm run smoke` starts the local server, checks the home page and sample API, then stops the process.
