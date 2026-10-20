# PatchTrace local workflow

Use this skill when changing PatchTrace in this repository.

## Read first

1. `AGENTS.md`
2. `docs/IMPLEMENTATION_STATUS.md`
3. `docs/PRODUCTION_READINESS.md`
4. `docs/ARCHITECTURE.md`
5. `docs/INCIDENT_BUNDLE.md` when touching input formats

## Checks

Run from the repository root:

```bash
npm test
npm run smoke
node bin/patchtrace.mjs doctor --json
```

Add a regression test for every analysis, parser, API security, scoring, or verification behavior.

## Guardrails

- Keep `src/core/` independent of the HTTP server and browser.
- Never mutate the source repository during verification.
- Real repository verification stays opt-in (`PATCHTRACE_ENABLE_VERIFY=1`) and must be labeled best-effort, not a sandbox.
- Reject linked worktrees, submodules, shallow/bare repos, filesystem roots, and symlinks escaping the repository.
- Use argv arrays, an environment allowlist, a timeout, and process-tree termination. Do not build a shell command from user input.
- Validate incident bundles before analysis and return field paths.
- Do not introduce a dependency unless it buys a user-visible capability that built-ins cannot provide.
- Prefer evidence, coverage, and uncertainty over confident root-cause claims.
- Do not add cloud integrations, multi-user auth, SQLite, or production rollback execution to the MVP.
