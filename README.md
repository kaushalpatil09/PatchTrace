# PatchTrace

**Find the change worth investigating first.**

PatchTrace is a local-first incident-to-change analyzer for small engineering teams. It turns a versioned incident bundle and an optional local Git repository into a deterministic timeline, an evidence-backed ranking of suspect commits, and — when explicitly enabled — a rollback hypothesis check in a temporary copy of the repository.

It is deliberately **not** a chatbot, a cloud observability dashboard, or a production rollback tool. A ranking is evidence, not proof of root cause.

> **Project status:** early-stage (`0.1.0`). The safety controls and the main vertical slice are implemented and tested. Production hardening is tracked in [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md) and [`docs/PRODUCTION_READINESS.md`](docs/PRODUCTION_READINESS.md).

| | |
| --- | --- |
| **Local-first** | No accounts, telemetry, cloud calls, or third-party assets. |
| **Zero runtime dependencies** | Node.js built-ins only. |
| **Deterministic** | The same bundle and repository state produce the same analysis. |
| **Inspectable** | Every suspect exposes factors, weighted contributions, evidence, coverage, and missing signals. |
| **Read-only by default** | Analysis never mutates the source repository. |
| **Opt-in verification** | Real rollback checks are disabled unless explicitly enabled. |

## Why PatchTrace

A small team may know that a deployment preceded an incident but still spend hours comparing commits, logs, and test output. PatchTrace answers three questions quickly:

1. Which change should we inspect first?
2. What evidence connects that change to the failure?
3. Can we safely reproduce the suspected fix before touching production?

It is built for maintainers and engineers who cannot or do not want to send private incident data to a third-party service.

## What it does

- Validates versioned JSON incident bundles with field-level errors.
- Builds a chronological timeline of commits, deployments, failures, and operator events.
- Ranks candidate commits with explicit scoring factors and evidence provenance.
- Enriches commits from a local Git repository: changed files and a derived diff-risk signal.
- Labels missing evidence and lowers confidence instead of inventing certainty.
- Runs fixture verification against deterministic demo data.
- Runs real rollback verification in a marked temporary copy, opt-in and bounded by timeouts.
- Exports JSON, Markdown, and CSV reports with provenance and best-effort secret redaction.
- Keeps the analysis engine independent of the HTTP server and browser.

## Requirements

- **Node.js 22 or newer** (developed on `22.23.3`, verified on `24.13.0`).
- **Git 2.31 or newer** for repository enrichment and verification.
- No runtime dependencies, external services, or network access for normal analysis.
- Docker is optional.

`node bin/patchtrace.mjs doctor` checks Node, Git, and temporary-directory writability.

## Quick start

From the repository root:

```bash
npm ci
npm start
```

Open <http://127.0.0.1:4173>. The server binds to `127.0.0.1` by default.

`npm ci` installs nothing today, but it validates that `package.json` and `package-lock.json` agree. There is no build step.

To use a different port:

```powershell
# PowerShell
$env:PORT = "8080"; npm start
```

```bash
# macOS / Linux
PORT=8080 npm start
```

To load a `.env` file, copy `.env.example` and run the server directly:

```bash
cp .env.example .env
node --env-file=.env server.mjs
```

`npm start` does **not** read `.env` automatically.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address. Keep loopback unless you deliberately expose the server. |
| `PORT` | `4173` | HTTP port. Use `0` for an ephemeral port. |
| `PATCHTRACE_ENABLE_VERIFY` | `0` | Set to `1` to allow real repository verification through the UI/API. |
| `PATCHTRACE_ALLOWED_HOSTS` | empty | Comma-separated extra hostnames allowed in `Host`/`Origin` checks. |
| `PATCHTRACE_VERIFY_ENV` | empty | Comma-separated environment variable allowlist for verification commands. |
| `PATCHTRACE_TOKEN` | random per start | Fixed API token. If unset, a random token is generated and printed at startup. |

### Local session security

When `PATCHTRACE_TOKEN` is unset, the server prints a generated session token at startup. Loading `/` in a browser sets an `HttpOnly`, `SameSite=Strict` cookie, so the UI authenticates automatically. API clients can use the cookie or one of:

```http
Authorization: Bearer <token>
X-PatchTrace-Token: <token>
```

```bash
curl -H "Authorization: Bearer <token>" http://127.0.0.1:4173/api/sample
```

The API rejects unexpected `Host` and `Origin` values, non-JSON POST bodies, and oversized bodies. If you access the server by a hostname other than `127.0.0.1`, `localhost`, or `::1`, add it to `PATCHTRACE_ALLOWED_HOSTS`.

The token protects against other browser origins and casual local HTTP clients. It does **not** isolate PatchTrace from other processes running as the same user.

## Use the browser UI

The UI is a dependency-free local inspection surface:

1. **Load sample incident** runs the deterministic fixture.
2. **Load incident bundle** reads a local JSON file and sends it only to the local server.
3. Inspect the timeline, ranked candidates, score breakdown, evidence, and missing signals.
4. Run **sample verification** to see the stored fixture result, clearly labeled as demo evidence.
5. When the server enables it, run **real verification** against a trusted local repository.
6. **Download JSON** builds a server-side report with provenance and deep redaction.

Validation errors are shown with field paths such as `commits[0].timestamp`. The UI has no third-party scripts, fonts, or images.

## Incident bundles

An incident bundle is a local, versioned JSON file. It is untrusted input and is validated before scoring. A minimal bundle looks like this:

```json
{
  "schemaVersion": 1,
  "title": "Checkout errors after deploy",
  "summary": "EU checkout started failing after the 14:00 deployment.",
  "environment": "production",
  "incidentStart": "2026-10-20T14:09:00Z",
  "candidateWindowMinutes": 1440,
  "incidentFiles": ["src/tax.ts"],
  "commits": [
    {
      "sha": "a81e7c2",
      "timestamp": "2026-10-20T13:55:00Z",
      "message": "Simplify VAT exemption calculation",
      "changedFiles": ["src/tax.ts", "tests/vat.test.ts"],
      "diffRisk": 0.88,
      "dependencyImpact": 0.72
    }
  ],
  "deployments": [
    {
      "commitSha": "a81e7c2",
      "timestamp": "2026-10-20T14:00:00Z",
      "environment": "production"
    }
  ],
  "tests": [
    {
      "name": "VAT-07",
      "status": "failed",
      "timestamp": "2026-10-20T14:10:00Z",
      "relatedFiles": ["src/tax.ts", "tests/vat.test.ts"],
      "errorSignature": "expected exempt order to have zero tax"
    }
  ]
}
```

Key rules:

- `schemaVersion` must be `1`.
- Timestamps must be ISO 8601 **with a timezone** (`Z` or `+02:00`), so analysis does not depend on the host timezone.
- `commits` is required but may be empty when using `--repo` enrichment.
- Deployments must match the bundle's `environment` to count as temporal evidence.
- A bundle's `verification` field is fixture/demo evidence only; it is never treated as a live result.

See [`docs/INCIDENT_BUNDLE.md`](docs/INCIDENT_BUNDLE.md) for every field and [`docs/incident-bundle.schema.json`](docs/incident-bundle.schema.json) for the JSON Schema.

## How ranking works

Each candidate commit receives a deterministic score between `0` and `1`:

| Signal | Weight | Source |
| --- | ---: | --- |
| Temporal proximity | 30% | Matching deployment timing relative to the incident. |
| Incident-file overlap | 25% | Changed files that overlap `incidentFiles`. |
| Test overlap | 20% | Failing tests whose `relatedFiles` overlap the commit's changed files. |
| Diff risk | 15% | Provided `diffRisk`, or derived from Git churn with `--repo`. |
| Dependency impact | 10% | Provided `dependencyImpact`; package-graph derivation is not implemented yet. |

For every suspect the output includes:

- `factors`: raw `0–1` values;
- `contributions`: `weight × factor` for each signal;
- `score`, `confidence`, and `coverage`;
- `missingSignals` and `signalSources` (`derived`, `provided`, or `missing`);
- human-readable `evidence` items.

Confidence is deliberately conservative: high confidence requires both a high score and at least 80% signal coverage. Post-incident deployments and deployments before the commit receive zero temporal credit. Commits after `incidentStart` or outside `candidateWindowMinutes` are excluded. Ties are broken deterministically by score, temporal contribution, older timestamp, then SHA.

The sample incident ranks `a81e7c2` first because it was deployed nine minutes before the incident, touches an incident file, and is connected to the failing `VAT-07` test.

## CLI

The CLI is a thin shell around the same core engine. Run it through npm:

```bash
npm run patchtrace -- doctor
npm run patchtrace -- validate fixtures/sample-incident/manifest.json
npm run patchtrace -- analyze fixtures/sample-incident/manifest.json
```

Or call the executable directly:

```bash
node bin/patchtrace.mjs doctor --json
```

```text
patchtrace doctor [--json]
patchtrace validate <bundle.json> [--json]
patchtrace analyze <bundle.json> [--repo <path>] [--max-commits <n>] [--generated-at <timestamp>] [--json] [--out <file>] [--format human|json|markdown|csv]
patchtrace verify --repo <path> --sha <sha> [--test-command <command|json>] [--timeout <ms>] [--mainline <n>] [--json] [--out <file>]
patchtrace report <bundle.json> [--repo <path>] [--verification <json>] [--max-commits <n>] [--generated-at <timestamp>] [--out <file>] [--format markdown|json|csv]
```

Bundle input may be `-` to read from stdin.

### Validate and analyze

```bash
node bin/patchtrace.mjs validate bundle.json
node bin/patchtrace.mjs analyze bundle.json --json
```

Enrich commits from a local repository:

```bash
node bin/patchtrace.mjs analyze bundle.json --repo /path/to/repository --json
```

`--repo`:

- requires a normal Git clone pointing at the worktree root — not a linked worktree, a repository with submodules, a bare repo, or a shallow clone;
- reads at most 200 commits in the candidate window by default (`--max-commits`, maximum 500);
- fills `changedFiles` from `git log --numstat` and derives `diffRisk` from changed-line count;
- uses repository commits as the candidate list when the bundle's `commits` array is empty;
- records the repository HEAD, branch, and dirty state in provenance;
- never mutates the source repository.

### Generate reports

```bash
node bin/patchtrace.mjs report bundle.json --format markdown --out report.md
node bin/patchtrace.mjs report bundle.json --format json --out report.json
node bin/patchtrace.mjs report bundle.json --format csv --out ranking.csv
```

Markdown reports include the timeline, ranking, evidence, verification results, caveats, and provenance. CSV is a ranking table. JSON includes the redacted analysis, optional verification, provenance, and a redaction count.

Use `--generated-at <ISO-8601-with-timezone>` when you need a reproducible report timestamp.

### Exit codes

| Code | Meaning |
| ---: | --- |
| `0` | Success / confirmed |
| `1` | Not confirmed or doctor found problems |
| `2` | Invalid input, invalid bundle, unsupported repository layout, or usage error |
| `3` | Timeout |
| `4` | Command error |

## Rollback verification

Real verification is available through the CLI, API, and UI. It is **disabled by default** for the server:

```powershell
# PowerShell
$env:PATCHTRACE_ENABLE_VERIFY = "1"; npm start
```

```bash
# macOS / Linux
PATCHTRACE_ENABLE_VERIFY=1 npm start
```

The verifier:

1. Refuses linked worktrees, repositories with submodules, bare repositories, shallow clones, filesystem roots, dirty worktrees (including untracked files), and symlinks that escape the repository.
2. Copies the repository into a fresh, marked temporary directory.
3. Runs the baseline test command twice and reports a pass/fail disagreement as a flaky, inconclusive baseline.
4. Runs `git revert --no-commit` only in the copy.
5. Runs the test command again and compares results.
6. Caps and best-effort redacts command output, removes the temporary copy, and checks the source repository's HEAD/status/config fingerprint.
7. Supports cancellation from the UI/API and sweeps marked workspaces left by an older crash.

```bash
node bin/patchtrace.mjs verify \
  --repo /path/to/repository \
  --sha abc1234 \
  --test-command "npm test" \
  --timeout 30000 \
  --json
```

- `--test-command` is parsed into an argv array. Use explicit JSON for unusual quoting: `--test-command '["npm","test"]'`. PatchTrace passes argv arrays and never asks the caller to build a shell command string.
- `--timeout` is per command, in milliseconds: `1–600000`, default `30000`.
- The overall test budget is `timeoutMs × (baseline runs + 1) + 10 seconds` (100 seconds with defaults).
- Only one real verification runs at a time per server.
- `Ctrl+C` cancels a CLI run, cleans up, and checks the source fingerprint.

On Windows, `.cmd` and `.bat` launchers such as `npm` are invoked through `cmd.exe` without the caller building a shell string. Batch-file semantics still apply, so prefer explicit JSON argv when quoting is unusual.

### Verification is not a sandbox

The temp-copy runner is **best-effort isolation, not a security boundary**. A hostile test command can still read or modify files outside the repository, access the network, and consume CPU or memory. Only run trusted test commands against trusted repositories. Use a dedicated container or VM with a read-only repository mount and network isolation when a real security boundary is required.

A confirmed result means the revert changed the test outcome in the temporary copy. It supports the rollback hypothesis; it does not prove root cause or production safety.

## HTTP API

The local API is documented in [`docs/API.md`](docs/API.md). All JSON API responses include `apiVersion: 1`.

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /` | Public | Browser UI; sets the session cookie. |
| `GET /api/health` | Public (Host-checked) | Readiness: Git availability, temp writability, verification state. |
| `GET /api/sample` | Token | Deterministic sample bundle. |
| `POST /api/analyze` | Token | Analyze a bundle (body is the bundle itself). |
| `POST /api/report` | Token | Build a versioned, redacted report. |
| `POST /api/verify` | Token | Fixture verification or opt-in real verification. |
| `POST /api/verify/cancel` | Token | Cancel the active real verification. |

```bash
curl -X POST http://127.0.0.1:4173/api/analyze \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  --data-binary @fixtures/sample-incident/manifest.json
```

Request limits are 5 MB for analysis/report bodies and 1 MB for verification. API errors are structured and never include stack traces. `GET /api/health` never includes the token.

The server is single-user. There is no CORS, persistence API, upload endpoint, rate limiter, or multi-user account system.

## Reports, provenance, and redaction

Reports record:

- the bundle SHA-256, tool version, and platform supplied by the caller (CLI reports also record the Node version);
- repository HEAD, branch, and dirty state when `--repo` was used;
- optional verification results;
- a count of redaction matches.

JSON report exports and the UI download are deep-redacted: string values matching private keys, common token formats, bearer tokens, JWTs, URL credentials, and `password`/`token`/`secret` assignments are replaced, and sensitive object keys are redacted. Markdown and CSV apply the same text rules.

Redaction is **best-effort**:

- Unusual secret formats can be missed, and matching text can be over-redacted.
- Local filesystem paths and repository names are **not** scrubbed.
- Raw `/api/analyze` responses are **not** report exports and are not redacted.

Treat every bundle, analysis response, report, and verification output as sensitive. Review exports before sharing.

## Security and privacy

- No telemetry, analytics, accounts, or cloud services.
- The browser UI talks only to the local PatchTrace server and loads no third-party assets.
- Incident bundles are data only; they are never evaluated as code.
- Real verification is opt-in and labeled best-effort isolation.
- Verification receives only an allowlisted environment plus anything you explicitly add to `PATCHTRACE_VERIFY_ENV`; credentials and cloud tokens are not passed through by default.
- Verification checks the source repository fingerprint before and after a run; a changed source invalidates a successful result.
- Static files are contained to `public/`; traversal and escaping symlinks are rejected.
- Security headers include CSP, `nosniff`, frame denial, no-referrer, and a permissions policy.

See [`docs/SECURITY.md`](docs/SECURITY.md) for the threat model and [`docs/PRIVACY.md`](docs/PRIVACY.md) for data handling. To report a vulnerability, follow [`SECURITY.md`](SECURITY.md).

## Testing

```bash
npm test
npm run smoke
node bin/patchtrace.mjs doctor --json
```

`npm test` uses the Node built-in test runner and covers analysis, scoring, bundle validation, CSV/JUnit parsing, Git enrichment, reports and redaction, API security, CLI behavior, UI static wiring, temporary-copy verification, flaky baselines, cancellation, stale-workspace sweeping, bundle collection limits, and a synthetic maximum-size bundle. The suite is split across 10 files in `tests/`.

`npm run smoke` starts the server on an ephemeral port, checks the home page and session cookie, verifies unauthenticated rejection, loads and analyzes the sample, runs fixture verification, exports a redacted report, and stops the server.

Run one file at a time:

```bash
node --test tests/analysis.test.mjs
node --test tests/verification.test.mjs
node --test tests/server.test.mjs
```

Tests create temporary Git repositories and workspaces under the OS temporary directory.

## Docker

```bash
docker build -t patchtrace:local .
docker run --rm -p 127.0.0.1:4173:4173 patchtrace:local
```

The image installs Git, runs as the non-root `node` user, binds `0.0.0.0` inside the container, and includes a healthcheck. Real verification is disabled by default.

To enable it, mount a repository and pass the flag:

```bash
docker run --rm -p 127.0.0.1:4173:4173 \
  -e PATCHTRACE_ENABLE_VERIFY=1 \
  -v /path/to/repo:/repo:ro \
  patchtrace:local
```

Use `/repo` as the repository path. The container is still an operator-controlled environment, not a hardened sandbox; add network and resource restrictions appropriate to your setup.

## Project layout

```text
bin/patchtrace.mjs       CLI entry point
server.mjs               Local HTTP server and API
src/core/
  analysis.mjs           Validation, timeline, scoring, CSV/JUnit parsers
  git-adapter.mjs        Local repository history and enrichment
  verification.mjs       Temp-copy runner, timeouts, cleanup, safety checks
  report.mjs             JSON, Markdown, and CSV report rendering
  redaction.mjs          Best-effort secret redaction
  command-line.mjs       Test-command argv parsing
public/                  Dependency-free browser UI
fixtures/                Deterministic sample incident
scripts/smoke.mjs        Offline smoke check
tests/                   Node built-in test suite
docs/                    Product, architecture, API, bundle, security, status
```

The core engine does not depend on the server or browser. `RepositoryAdapter`, `ArtifactParser`, `VerificationRunner`, and `ReportRenderer` are the intended extension points; see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Current limits

- Real verification uses a temporary copy, not a container/VM sandbox. A container/VM runner is a production requirement.
- `dependencyImpact` is a provided signal; dependency blast-radius is not derived from a package graph.
- Diff risk is derived from changed-line count, not a full semantic risk model.
- There is no persistence or investigation history; JSON bundles and reports are the contract.
- The UI is a single-user local surface, not a multi-user service.
- API request/response schema validation and an OpenAPI document are not implemented; route-level docs exist.
- Report metadata is not path-scrubbed.
- Docker image and the GitHub Actions matrix are defined, but have not been validated on real runners in this workspace.
- License and release metadata are not finalized.

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/PRODUCT.md`](docs/PRODUCT.md) | Users, problem, constraints, acceptance criteria. |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System design, data flow, scoring contract, safety boundaries. |
| [`docs/INCIDENT_BUNDLE.md`](docs/INCIDENT_BUNDLE.md) | Bundle v1 field reference. |
| [`docs/API.md`](docs/API.md) | Local HTTP API, authentication, errors, routes. |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Threat model and verification boundary. |
| [`docs/PRIVACY.md`](docs/PRIVACY.md) | Data handling and network behavior. |
| [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md) | What is built, tested, and still missing. |
| [`docs/PRODUCTION_READINESS.md`](docs/PRODUCTION_READINESS.md) | Full production specification and release gates. |
| [`CHANGELOG.md`](CHANGELOG.md) | Release notes. |

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`AGENTS.md`](AGENTS.md). Keep changes small, deterministic, and inspectable; keep `src/core/` framework-independent; never mutate a source repository during verification; and add an automated test for each analysis, API, parser, or verification behavior.

Do not add cloud integrations, multi-user auth, SQLite, production rollback execution, or a generic chat interface before the production-hardening items are complete.
