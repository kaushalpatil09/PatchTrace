# Privacy and data handling

PatchTrace is offline-first and has no telemetry, analytics, accounts, or cloud services.

## What stays local

- Incident bundles and repository paths are read on the machine running PatchTrace.
- Analysis, fixture verification, API responses, and reports are generated locally.
- The browser UI talks only to the local PatchTrace server. It does not load third-party scripts, fonts, or images.
- Real verification runs a command against a temporary copy on the local machine.

## What verification may expose

The test command is arbitrary code and can print repository data, environment values, secrets, or network responses. PatchTrace passes only an allowlisted environment and best-effort redacts command output, but redaction is pattern-based and cannot guarantee that every secret is removed.

Reports can include commit messages, file paths, test names, and command output. Treat Markdown, CSV, and JSON exports as sensitive. Report JSON is deep-redacted best-effort, but local paths and unusual secret formats can remain; raw `/api/analyze` responses are not redacted reports.

## Network behavior

Normal analysis makes no outbound requests. A verification command may make network requests because the current runner is not a hardened sandbox. Use a container or VM with networking disabled when that matters.

When `PATCHTRACE_VERIFY_ISOLATION=production` is configured, the constrained container runner uses a pre-existing local image and disables container networking. It does not pull images or send bundles, repositories, reports, or command output to a remote service. If Docker or Podman, the configured image, or the local resource budget is unavailable, production verification reports that it is unavailable rather than falling back silently.

The server and CLI enforce bounded request/input sizes, collection counts, Git history, JUnit parsing, command duration/output, repository-copy size, and minimum free space. These limits reduce accidental resource exposure but do not make arbitrary test commands safe; review the resource table in [`../README.md`](../README.md) for deployment planning.

## Reporting

Do not publish live secrets, incident data, or private repository contents. See [`../SECURITY.md`](../SECURITY.md).

The public package is MIT licensed and contains only the application, fixtures, documentation, and release metadata listed in `package.json`; local `.env` files, tests, coverage output, and workspace state are excluded from Docker/npm packaging where applicable.
