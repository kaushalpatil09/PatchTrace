# Incident bundle v1

A PatchTrace incident bundle is a local JSON file. It is untrusted input: the analyzer validates it before scoring commits. The machine-readable schema is [`incident-bundle.schema.json`](incident-bundle.schema.json); this page is the field-by-field guide.

## Minimal example

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

Times must be ISO 8601 **with a timezone** (`Z` or `+02:00`). A timestamp without a zone is rejected because the analysis must not depend on the machine's local timezone.

Use a full date and time including seconds. Invalid calendar dates, hour 24, leap-second notation and invalid offset components are rejected rather than normalized. Fractional seconds and compact offsets such as `+0530` are supported. Total commit/test path references are limited to 250,000 and estimated overlap visits to 50,000,000. Analysis can reject an otherwise schema-valid bundle that exceeds its workload budget.

## Top-level fields

| Field | Required | Type | Meaning |
| --- | --- | --- | --- |
| `schemaVersion` | yes | `1` | Unsupported versions fail with a clear error. |
| `title` | yes | string | Incident title shown in the UI and report. |
| `summary` | no | string | Short human description. |
| `environment` | yes | string | Deployments must match this exact environment, e.g. `production`. |
| `incidentStart` | yes | timestamp | Start of the incident. Candidate commits must be at or before this time. |
| `incidentEnd` | no | timestamp | Optional end of the incident window, used for timeline phases. |
| `candidateWindowMinutes` | no | positive number | How far before `incidentStart` to look for commits. Default `1440` (24 hours). |
| `incidentFiles` | no | string[] | Files implicated by incident evidence. A non-empty array is required together with each candidate's `changedFiles` array to evaluate file overlap; an absent or empty array leaves that signal unavailable. |
| `commits` | yes | commit[] | Candidate commits. May be empty when `--repo` enrichment is used. |
| `deployments` | no | deployment[] | Deployment events. Missing deployments reduce confidence. |
| `tests` | no | test[] | Test results. Only `failed` tests contribute. |
| `incidentEvents` | no | event[] | Operator/alert events shown in the timeline. |
| `verification` | no | object | Fixture-only stored verification. Never treated as a live verification result. |
| `provenance` | no | object | Ingestion provenance. May include parser version, artifact hashes, source paths, and ingestion time. Treat paths as sensitive. |

## Commit

| Field | Required | Type | Meaning |
| --- | --- | --- | --- |
| `sha` | yes | string | Git commit SHA, 4–64 hex characters. |
| `timestamp` | yes | timestamp | Commit time with timezone. |
| `message` | yes | string | Commit subject. |
| `changedFiles` | no | string[] | Repository-relative paths. Required per candidate for file/test overlap evaluation. An omitted array means the candidate's overlap evidence is missing; an explicit empty array is observed evidence of no changed files and can produce observed no-overlap. |
| `diffRisk` | no | 0–1 | Manual diff-size/risk signal, or the value derived by `--repo` enrichment. Missing means unavailable. |
| `diffRiskSource` | no | string | `derived:git` when supplied by `--repo` enrichment. |
| `dependencyImpact` | no | 0–1 | Explicit blast-radius signal, or the value derived from supported dependency files. Missing means unavailable. |
| `dependencyImpactSource` | no | string | `provided` or `derived:dependency-files`. |
| `dependencyImpactDetails` | no | object | Inspectable dependency derivation inputs and component signals. |
| `diffLines` | no | number | Total changed lines observed for the commit by Git enrichment. |
| `diffStats` | no | object[] | Per-file additions, deletions, and changed-line counts used for dependency and risk evidence. |

File matching normalizes `\` to `/`, but paths should be repository-relative.

## Deployment

A deployment must have `commitSha` or a non-empty `commitShas` array (for a release containing several commits).

| Field | Required | Type | Meaning |
| --- | --- | --- | --- |
| `commitSha` | one of | string | Commit deployed. |
| `commitShas` | one of | string[] | Commits in a multi-commit deployment. |
| `timestamp` | yes | timestamp | Deployment completion time. |
| `environment` | yes | string | Must equal the bundle's `environment` to count. |

A deployment after `incidentStart` is shown as evidence but receives **zero** temporal credit. A deployment before the commit also receives zero.

## Test

| Field | Required | Type | Meaning |
| --- | --- | --- | --- |
| `name` | yes | string | Test name used in evidence. |
| `status` | yes | `passed`, `failed`, `skipped` | Only failures contribute. |
| `timestamp` | no | timestamp | Used in the timeline when supplied. Imported test results do not receive a synthetic `incidentStart` timestamp; a missing value remains unknown rather than being treated as an event at incident start. |
| `relatedFiles` | no | string[] | Files connected to the test. Every failing test must provide this field (including an explicit empty array) for that candidate's test-overlap signal to be available. An omitted field leaves the signal missing; an explicit empty array is observed no-related-file evidence and can produce observed no-overlap. |
| `errorSignature` | no | string | Short failure signature displayed in evidence. |

## Incident event

| Field | Required | Type | Meaning |
| --- | --- | --- | --- |
| `kind` | yes | string | e.g. `error_spike`, `incident`, `operator_note`. |
| `timestamp` | yes | timestamp | Event time. |
| `title` | yes | string | Timeline title. |
| `detail` | no | string | Supporting detail. |
| `commitSha` | no | string | Optional related commit. |

## Validation and import

Validate without analyzing:

```bash
node bin/patchtrace.mjs validate fixtures/sample-incident/manifest.json
node bin/patchtrace.mjs validate bundle.json --json
```

The browser UI has **Load incident bundle** on the home screen. It reads the file locally, sends it only to the local server, and displays field-level errors (for example `commits[0].timestamp: ...`).

## Repository enrichment

A bundle can omit `changedFiles` and `diffRisk` and let PatchTrace read them from a local Git repository:

```bash
node bin/patchtrace.mjs analyze bundle.json --repo /path/to/repository --json
```

`--repo`:

- requires a normal clone (not a linked worktree, submodule checkout, bare repo, or shallow clone);
- reads at most 200 commits in the candidate window by default (`--max-commits`, max 500);
- fills `changedFiles` from `git log --numstat` and derives `diffRisk` from changed-line count;
- records the repository HEAD, branch, and dirty state in provenance;
- never mutates the source repository.

When `commits` is empty, the repository commits inside the candidate window become the candidate list. When `commits` is non-empty, matching SHAs (full or unique short prefixes) are enriched and other fields remain as authored. `--max-commits` limits Git enrichment to 500 entries; the report records when the result is truncated.

## Limits

- API request body: 5 MB for analysis, 1 MB for verification.
- Bundle collections: 2,000 commits, 2,000 deployments, 5,000 tests, 5,000 incident files, 2,000 incident events, 5,000 changed or related files per entry, and 1,000 SHAs per deployment.
- Candidate commits: 500 maximum when enriched from Git.
- Verification output is capped at 256 KB per command, with a 10-minute maximum timeout.
- Real verification rejects dirty worktrees and runs one verification at a time.

## Ingestion provenance

`patchtrace ingest` records an optional `provenance.ingestion` object in the generated bundle. Each imported artifact includes a SHA-256 hash, source path when supplied, parser name/version, artifact kind, and ingestion time. This metadata makes it possible to audit which local evidence produced a ranking; it may contain private filesystem paths and should be treated as sensitive.

Imported JUnit rows preserve a timestamp only when the source row provides one. In particular, ingestion never substitutes `incidentStart` for a missing test timestamp, and timeline construction does not create a timestamped test event for an untimestamped failure. Explicit empty `relatedFiles` arrays in bundle input are retained so observed no-overlap remains distinguishable from missing test-file evidence; a JUnit row without a file attribute remains missing related-file evidence.

When analysis skips an untimestamped failed test from the ordered timeline, it adds a warning naming the omitted evidence and states that no timestamp was inferred. The failed test can still contribute to overlap scoring only when its required file evidence is present.

## Security notes

- Treat the bundle as untrusted input. Do not put secrets in it.
- `verification` in a bundle is demo evidence only. Real verification results must come from the verification runner.
- Real verification executes the supplied test command in a temporary copy. It is **not** a sandbox. Only point it at a trusted local repository and a trusted test command.
- The local API requires a session token and rejects unexpected `Host`/`Origin` values and non-JSON requests.
