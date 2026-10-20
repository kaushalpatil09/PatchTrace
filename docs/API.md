# Local API

PatchTrace runs a single-user HTTP API on the loopback interface. The browser UI uses the same API. All responses include `apiVersion: 1`.

Base URL: `http://127.0.0.1:4173` by default.

## Authentication

The server generates a random token at startup and prints it. Loading `/` in a browser sets an `HttpOnly`, `SameSite=Strict` cookie. API clients can use a cookie or one of these headers:

```http
Authorization: Bearer <token>
X-PatchTrace-Token: <token>
```

`GET /api/health` is public. Every other API route requires authentication.

Set a fixed token with `PATCHTRACE_TOKEN`; otherwise a new token is generated on each start.

## Host and origin checks

`Host` must be `127.0.0.1`, `localhost`, or `[::1]` (with any port), plus any hostname in `PATCHTRACE_ALLOWED_HOSTS`. Requests with a browser `Origin` must be same-origin. POST requests with a body must use `Content-Type: application/json` (a charset parameter is allowed); `/api/verify/cancel` accepts an empty body. Redirects and CORS are not used.

## Errors

```json
{
  "apiVersion": 1,
  "error": {
    "code": "invalid_bundle",
    "message": "Incident bundle is invalid.",
    "details": [
      { "path": "commits[0].timestamp", "message": "timestamp must include a timezone." }
    ]
  }
}
```

Common status codes:

| Status | Meaning |
| --- | --- |
| `400` | Invalid JSON, invalid bundle, invalid report request, or invalid verification request. |
| `401` | Missing or invalid session token. |
| `403` | Disallowed `Host`/`Origin`, verification disabled, or unexpected method. |
| `404` | Unknown route or static file. |
| `405` | Method not allowed. |
| `409` | Another real verification is already running, or there is no run to cancel. |
| `413` | Request body over the limit. |
| `500` | Unexpected server error. The response never includes a stack trace. |

Analysis bodies are limited to 5 MB; verification bodies to 1 MB.

## Routes

### `GET /`

Serves the browser UI and sets the session cookie. `GET /index.html` redirects here so the cookie is always established.

### `GET /api/health`

Public readiness information.

```json
{
  "apiVersion": 1,
  "status": "ok",
  "ready": true,
  "version": "0.1.0",
  "node": "v24.13.0",
  "platform": "win32",
  "git": {
    "available": true,
    "version": "git version 2.43.0"
  },
  "tempWritable": true,
  "realVerificationEnabled": false,
  "verificationInProgress": false
}
```

`status` is `degraded` and `ready` is false if Git is unavailable or the temporary directory is not writable. The health response never includes the session token.

### `GET /api/sample`

Returns the deterministic sample incident bundle. Requires auth.

```bash
curl -H "Authorization: Bearer $PATCHTRACE_TOKEN" \
  http://127.0.0.1:4173/api/sample
```

### `POST /api/analyze`

Analyzes a versioned incident bundle. The body is the bundle itself, not a wrapper.

```bash
curl -X POST http://127.0.0.1:4173/api/analyze \
  -H "Authorization: Bearer $PATCHTRACE_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @fixtures/sample-incident/manifest.json
```

Success: `200` with the analysis object, including `schemaVersion`, `incident`, `timeline`, `suspects`, `warnings`, `candidateWindowMinutes`, `excludedCandidateCount`, `weights`, and fixture `verification`. See [`INCIDENT_BUNDLE.md`](INCIDENT_BUNDLE.md) for input fields.

Invalid bundle: `400` with `error.code = "invalid_bundle"` and field paths.

### `POST /api/report`

Builds a versioned report from an analysis response and an optional verification result. The server supplies `generatedAt` and `toolVersion`; the request body is:

```json
{
  "analysis": { "...": "the analysis object" },
  "verification": { "...": "optional verification result" },
  "provenance": { "source": "local bundle", "bundleSha256": "..." }
}
```

Success: `200` with the report object (`schemaVersion`, `generatedAt`, `toolVersion`, `analysis`, `verification`, `provenance`, and `redaction`). Report JSON is deep-redacted with the same best-effort rules as Markdown/CSV; `redaction.matches` records the number of replacements. The request must contain an analysis with `schemaVersion: 1`, an incident with `title`, `environment`, and `incidentStart`, suspects, timeline, and a positive `candidateWindowMinutes`; invalid shapes return `400` with `error.code = "invalid_request"` and field-level details. The request limit is 5 MB. Raw analysis responses remain raw data; treat them as sensitive.

### `POST /api/verify`

Two modes share one route.

#### Fixture verification

Runs only against stored fixture data. It does not execute a repository.

```json
{
  "analysis": { "...": "the full analysis response" },
  "sha": "a81e7c2"
}
```

The response is the server-owned stored fixture verification result and includes `source: "fixture"`. Client-supplied `analysis.verification` data is ignored.

#### Real repository verification

Only available when the server starts with `PATCHTRACE_ENABLE_VERIFY=1`.

```json
{
  "repoPath": "D:\\projects\\checkout",
  "sha": "a81e7c2",
  "testCommand": ["npm", "test"],
  "timeoutMs": 30000,
  "mainline": 1
}
```

`repoPath` must be a normal Git worktree root with no uncommitted or untracked changes. Linked worktrees, submodule checkouts, bare/shallow repositories, filesystem roots, dirty worktrees, and symlinks escaping the root are rejected. `sha` must be 4–64 hex characters. `testCommand` is an argv array; it is never passed through a shell. Empty arguments and null bytes are rejected. `timeoutMs` is a per-command limit from 1–600000, default `30000`. The overall test budget is `timeoutMs × (baseline runs + 1) + 10 seconds` (100 seconds with defaults), so a sequence of commands cannot hang indefinitely. `mainline` is a positive integer, default `1`.

Only one real verification can run at a time. A concurrent request receives `409` with `error.code = "verification_in_progress"`.

The baseline command runs twice by default. If the runs disagree on pass/fail, the result is `inconclusive` with `reason = "flaky_baseline"`; the candidate revert is not tested.

Result fields:

- `status`: `passed`, `failed`, `timeout`, `cancelled`, `missing_history`, or `unsupported_layout`.
- `source`: `fixture` for server-owned demo evidence or `live` for a real repository run.
- `outcome`: `confirmed`, `not_confirmed`, `inconclusive`, `timeout`, `cancelled`, `invalid_repo`, `source_changed`, or `command_error`.
- `reason` and `message`. A dirty worktree returns `reason = "dirty_worktree"` and `outcome = "invalid_repo"` before any copy or command.
- `baseline`: the first baseline command result; `baselineRuns` contains every baseline attempt.
- `candidate`: command status, exit code, failing count, capped stdout/stderr.
- `revert`: Git revert status and output, or `null` if it was not attempted.
- `sourceUnchanged`: whether the source HEAD/status/config fingerprint still matches.
- `cleanup`: whether the temporary workspace was removed. `{ removed: false, skipped: true }` means no workspace was created.
- `isolation`, `platform`, `testCommand`, `timeoutMs`, `overallBudgetMs`, `baselineRunsRequested`, `startedAt`, `finishedAt`, and `durationMs`: audit fields.
- Command `stdout`/`stderr` are capped at 256 KB per stream, marked when truncated, and best-effort redacted for private keys, common token formats, bearer tokens, JWTs, URL credentials, and `password`/`token`/`secret` assignments. `redactions` records how many matches were removed. Redaction is not a guarantee; do not print secrets deliberately.

A confirmed result means the candidate revert changed the test outcome in the temporary copy. It is evidence, not proof of root cause. The runner is best-effort isolation, not a sandbox.

#### `POST /api/verify/cancel`

Requests cancellation of the active real verification. Requires authentication; no request body is required.

- `202` with `{ "cancelled": true }` when a run is active. The runner terminates the child process tree, removes the temporary copy, checks the source fingerprint, and returns the normal result to the original `/api/verify` request with `status = "cancelled"` and `outcome = "cancelled"`.
- `409` with `error.code = "no_verification_in_progress"` if no run is active.

Closing the HTTP connection that started a verification also requests cancellation. `SIGINT`/`SIGTERM` cancels an active run before the server closes.

Example:

```bash
curl -X POST http://127.0.0.1:4173/api/verify \
  -H "Authorization: Bearer $PATCHTRACE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"repoPath":"/repo","sha":"abc1234","testCommand":["npm","test"],"timeoutMs":30000}'
```

## Static files

`GET /styles.css` and `GET /app.js` are served from `public/`. Responses include CSP, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and `Cross-Origin-Resource-Policy: same-origin`. Path traversal and symlinks escaping `public/` are rejected.

## Not included

There is no CORS, no multi-user account system, no persistence API, no upload endpoint, and no rate limiter. The server is intended for a local single user. Put it behind a reverse proxy only after adding authentication and transport security appropriate for that deployment.
