# Security policy

PatchTrace is a local-first tool. It is not designed to be exposed to the internet or shared by multiple users.

Report suspected vulnerabilities privately to the maintainers rather than in a public issue. Do not include live secrets, private repository contents, or full incident bundles in a public report. Share the smallest reproduction and the affected version.

## Scope

- The local HTTP API, session token, `Host`/`Origin` checks, and static-file containment.
- Incident bundle validation, CSV/JUnit parsing, and report injection safety.
- The real-verification runner, repository safety checks, command execution, timeout/cancellation, and cleanup.
- Secret redaction boundaries and source-repository immutability checks.

## Important limitations

Real verification is **best-effort temporary-copy isolation, not a sandbox**. A hostile test command can still read or modify files outside the repository, and it can reach the network. Only run trusted test commands against trusted repositories. Use a dedicated container or VM when a security boundary is required.

When `PATCHTRACE_VERIFY_ISOLATION=production` is used, PatchTrace requires a pre-existing Docker or Podman runtime and local verification image. It fails closed when either is unavailable; it does not silently fall back to temporary-copy execution. The constrained runner uses a non-root identity, no network, read-only source input, bounded CPU/memory/PIDs/tmpfs, dropped capabilities, and a separate writable workspace. The image and runtime remain operator-controlled infrastructure, so keep the daemon and host trusted.

Operational limits are part of the security boundary: request bodies, bundle collections, Git history, JUnit input, command timeouts, command output, repository copies, and free-space checks are bounded. Review `README.md`'s operational limits table before selecting values for a large repository or slow test command.

The full threat model and operator guidance are in [`docs/SECURITY.md`](docs/SECURITY.md). Production requirements are tracked in [`docs/PRODUCTION_READINESS.md`](docs/PRODUCTION_READINESS.md).

The release is MIT licensed and published from the repository metadata in `package.json`. Report the affected version, operating system, runtime mode, and the smallest safe reproduction; do not attach secrets or private incident data.

## Supported versions

The current `main` branch is the only supported development version until a release is published.
