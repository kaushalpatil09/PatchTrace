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

## Reporting

Do not publish live secrets, incident data, or private repository contents. See [`../SECURITY.md`](../SECURITY.md).
