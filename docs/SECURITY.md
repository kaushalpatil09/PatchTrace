# Security model

PatchTrace is a local-first, single-user tool. This document describes what the current controls protect, what they do not protect, and how to operate real verification safely.

## Trust model

- The person running PatchTrace controls the machine, the incident bundles, and the repository.
- Incident bundles and repository contents are **untrusted data** and are validated before analysis.
- The local server is not a multi-user service. The session token prevents other web origins and casual local HTTP clients from calling the API; it does **not** isolate PatchTrace from other processes running as the same user.
- Real verification is opt-in. It executes a test command chosen by the operator.

## Local API controls

- Random per-start session token printed at startup; optional fixed `PATCHTRACE_TOKEN`.
- `HttpOnly`, `SameSite=Strict` cookie for the browser UI.
- Optional bearer token or `X-PatchTrace-Token` header for clients.
- `Host` allowlist (`127.0.0.1`, `localhost`, `[::1]`, plus `PATCHTRACE_ALLOWED_HOSTS`).
- Same-origin `Origin` check for browser requests.
- JSON-only POST bodies with 5 MB (analysis/report) and 1 MB (verification) limits.
- Server request, header, and keep-alive timeouts, plus a single-flight lock for real verification.
- Explicit cancellation endpoint, cancellation on client disconnect, and cancellation during graceful shutdown.
- Security headers including CSP, `nosniff`, frame denial, no-referrer, permissions policy, same-origin resource policy, and `object-src 'none'`.
- Static-file containment: traversal and symlinks escaping `public/` are rejected.
- No stack traces or internal paths in API errors.

These controls reduce cross-site request forgery, DNS-rebinding, and drive-by browser access. They do not protect against malware or another user process on the same machine.

## Incident bundles

- Bundles are data only. They are never evaluated as code.
- `schemaVersion` must be `1`; unsupported versions are rejected.
- Timestamps must include a timezone, so the result does not depend on the host timezone.
- File paths, SHAs, numeric ranges, and array shapes are validated before scoring.
- Treat bundles as sensitive incident data: they may contain internal file names, commit subjects, and test names. Reports are written wherever the operator asks. Do not put secrets in a bundle.
- A bundle's `verification` field is fixture/demo evidence, never a trusted live result.

## Repository enrichment

`analyze --repo` reads Git history with `git log` and records HEAD, branch, and dirty state. It does not modify the repository.

## Real verification boundary

The default `temp-copy` runner is trusted-local, **best-effort execution, not a security sandbox**. The opt-in production mode replaces command execution with a constrained Docker/Podman container; it is a stronger boundary, but the container runtime, image, and host remain operator-controlled.

What the default `temp-copy` mode does:

1. Resolves and inspects the repository before copying.
2. Rejects linked worktrees, submodule checkouts, bare repositories, shallow clones, filesystem roots, dirty worktrees (uncommitted or untracked changes), and symlinks that resolve outside the repository.
3. Copies the repository to a fresh, marked temporary directory.
4. Runs the baseline command twice in the copy, never in the source working tree, and reports a pass/fail disagreement as an inconclusive flaky baseline.
5. Reverts the candidate only in the copy (`git revert --no-commit`).
6. Runs the command again and compares results.
7. Applies a per-command timeout plus an overall verification budget, and terminates the process tree on timeout or cancellation with a forced-resolution grace period.
8. Caps captured stdout/stderr at 256 KB per command and best-effort redacts private keys, common token formats, bearer tokens, JWTs, URL credentials, and password/token-style assignments.
9. Passes only an allowlisted environment (`PATH`, temp locations, locale, basic Windows/Unix runtime variables, plus `PATCHTRACE_VERIFY_ENV`).
10. Checks the source HEAD, status (including untracked files), and `.git/config` hash before and after the run.
11. Removes the temporary copy and reports cleanup failure separately from the test result.
12. Sweeps marked `patchtrace-*` workspaces older than 24 hours at server/CLI verification startup so a crash does not leave them forever.

The default `temp-copy` mode does **not**:

- Prevent a malicious test command from reading or modifying files elsewhere on the machine.
- Prevent network access.
- Provide CPU, memory, filesystem, or syscall isolation.
- Prove that a revert is safe or that a commit caused the incident.
- On Windows, `.cmd`/`.bat` launchers such as `npm` are invoked through `cmd.exe`. The caller does not build a shell string, but batch-file semantics still apply; prefer explicit argv JSON for unusual commands.

Production container mode (`PATCHTRACE_VERIFY_ISOLATION=production`) fails closed unless Docker or Podman and the configured local image are available. Each phase runs in a fresh container with no network, a read-only source mount, a separate writable workspace, a non-root numeric identity, dropped capabilities, and bounded CPU, memory, PIDs, and `/tmp`. It never silently falls back to `temp-copy` mode. Use a dedicated VM when the container daemon or host itself is not trusted; a container is not a hardware boundary.

## Secrets and reports

- Verification does not inherit arbitrary environment variables. Add only the variables a trusted test command needs with `PATCHTRACE_VERIFY_ENV`.
- Do not enable verification on a server exposed to untrusted users.
- Verification command output is redacted before it is returned, and the Markdown/CSV report renderers apply the same best-effort redaction to evidence and provenance text.
- Report JSON from the CLI, the download button, and `POST /api/report` is deep-redacted with the same rules and records `redaction.matches`. Raw `/api/analyze` responses and analysis objects assembled outside the report builder remain raw data, not reports.
- Report exports replace absolute local filesystem and home-directory paths, but repository-relative evidence, repository names or path fragments in messages, and non-pattern secrets may still appear. Treat all exports as sensitive and review them before sharing.
- Redaction is pattern-based. It can miss unusual secret formats and can over-redact matching text. It is not a substitute for keeping credentials out of repositories and test output.

## Docker

The image runs as the non-root `node` user and installs Git for verification. To reduce risk:

```bash
docker run --rm -p 127.0.0.1:4173:4173 \
  -e PATCHTRACE_ENABLE_VERIFY=1 \
  -v /path/to/repo:/repo:ro \
  patchtrace:local
```

Bind the published port to `127.0.0.1`, mount the repository read-only, and add network restrictions appropriate to your environment. The container is still an operator-controlled environment, not a guarantee.

## Reporting a vulnerability

Do not include live secrets, incident bundles, or repository contents in a public report. Share the smallest reproduction and use a private channel with the maintainers when one is available.
