# PatchTrace hardening audit — 2026-10-22

Verdict: **Not production-ready**. This pass fixes the reproduced report, credential and analysis hot-path defects and adds executable release gates. Hostile-code verification still has an unbounded writable workspace and lacks executed container evidence here. External ranking validation, complete browser/accessibility validation and the platform/release matrix remain open.

## Scope and baseline

- Repository: `D:/project3`, branch `main`, baseline commit `7b21c6ae15b2c112bf5bb8e5b6faeb4c8bfed827`.
- Initial tracked working tree was clean; `production/` contained the user's untracked audit documents. Those documents were preserved unchanged. Changes in this pass are local and uncommitted; no fix commit or remote CI result is claimed.
- Windows, Node `v24.13.0`, npm `11.6.2`, Git `2.52.0.windows.1`, Intel Core i5-13450HX. Only this Node runtime was exercised. Docker CLI is installed; its Linux daemon pipe is absent. Podman was not found.
- The supplied ZIP audit is historical evidence, not evidence about this checkout. Its findings were checked against source and reproduced where feasible. Embedded role/mission text was treated as reference task guidance within the user's request to start building, not independent authorization for publication or repository mutation.
- Repository contributor/workflow guidance and the supplied audit/pack informed this pass. The priority review covered report/redaction, timeline/scoring/validation, ingestion/Git constraints, API routes, UI rendering, verifier/container wiring, package contents, Docker and CI. This is an implementation and regression review, not a completed independent penetration test or exhaustive standards audit.

The initial restricted execution failed 45 tests because the environment denied Git writes in temporary repositories and localhost connections. Rerunning with the necessary access passed **110 tests, 0 failed, 1 skipped** out of 111; smoke passed. The skipped absolute-symlink test reported `EPERM` on Windows. Do not count that scenario as verified here.

## Finding-by-finding disposition

| ID | Severity | Reproduction / evidence | Fix and verification | Remaining risk / follow-up owner |
| --- | --- | --- | --- | --- |
| PT-001 | High | Reproduced. `md()` in `src/core/report.mjs` left images and links active. New `tests/output-security.test.mjs` failed against baseline. | Unit-tested literal punctuation/HTML encoding, CR/LF normalization, block-marker protection, removal of unsafe inline-code wrappers. Provenance uses a dynamically sized JSON fence. Tests cover incident, timeline, suspects, evidence, warnings, verification, provenance and block syntax. | Report viewer behavior is not exhaustively tested. Maintainer: keep renderer regressions and review exports. |
| PT-002 | High | Reproduced. Compound fields/assignments survived baseline redaction; canary regressions failed before fix. | `redaction.mjs` now recognizes compound secret keys and connection-string fields, applies sensitive-key matching to assignments, redacts credential URLs beyond HTTP and recognizes Stripe-style tokens. Recursive/format/provider/false-positive tests pass. Metadata and UI explain best-effort processing. | Unknown secrets can remain; raw analysis is sensitive. Maintainer/user must review exports. |
| PT-003 | High | Reproduced with the documented 400 commits / 2,000 failures / 50 paths shape. Local generator differs from the ZIP audit: 2,188,560 dense bytes rather than 3,312,945. Baseline median about 11.78 seconds; serialized dense results could also exceed the runtime string limit. | File-to-test index, stable test identity/order, work limits, 20-detail cap with full counts, single worker slot/no queue, cancellation, 5-second worker limit, 128 MiB V8 old heap and 16 MiB worker output. Tests cover budgets, amplification, timeout, abort, busy responses, recovery and deterministic baseline hashes. API benchmark records responsive health/control routes. | Main-thread JSON and reports are still synchronous. V8 heap is not total RSS. CLI/core execution remains synchronous. Maintainer: slow-client, report and repository scale tests. |
| PT-004 | Medium | Reproduced. Current-defect table claimed authentication, parsers, CI, license and packaging were absent despite source/tests. | Replaced with current issues and dated evidence; retained original DEF inventory under `docs/history/PRODUCTION_DEFECTS_2026-10-21.md`. Updated implementation/TODO/API/architecture/bundle docs. | Full 1.0 specification remains a target, not an all-checked implementation claim. Maintainer: keep status evidence current. |
| PT-005 | High gate | Blocked. `docker info` cannot connect to the Docker Desktop Linux daemon; `doctor` reports `container_daemon_unavailable`. | Existing fail-closed unit tests preserved. Added `npm run test:container` and Ubuntu CI execution against a real built image. The local command fails rather than skipping. | NOT live-validated here. Disk quota, hostile resource/process-tree behavior, disconnect/shutdown and broader Linux/Podman/VM validation remain required. Maintainer/release owner. |
| PT-006 | High evidence gap | Reproduced as an evidence gap: no independently labeled historical incident dataset. | Added pure evaluation module, tests and `npm run evaluate`; exact labels, split-specific Top-1/Top-3/MRR, coverage/abstention, baselines, failure cases. | Six related synthetic variants are illustrative and biased. External validation explicitly OPEN. Product/release owner: obtain licensed/sanitized independent cases. |
| PT-007 | Medium gate | Partially reproduced. Static tests existed; complete browser/AT evidence did not. | In-app browser spot check: sample/import/ranking/selection/fixture labeling and literal hostile strings. A horizontal overflow was observed and fixed, then normal-sample reflow verified. | Automated browser regression suite, axe, keyboard/zoom/contrast, screen-reader and browser matrix remain open. Maintainer/accessibility reviewer. |
| PT-008 | Medium | Reproduced: CI used mutable `@v4` action references. | Official `git ls-remote` resolved checkout to `11d5960a326750d5838078e36cf38b85af677262`, setup-node to `49933ea5288caeca8642d1e84afbd3f7d6820020`; workflow pinned and read-only permissions retained. | No remote workflow run or independent action-source audit claimed. Maintainer: review/update pins and execute CI. |
| PT-009 | Sensitive surface | Reproduced by HTTP regression: a synthetic credential remains in raw analysis and is absent in report JSON. | Contract intentionally preserved. API/OpenAPI/docs explicitly distinguish raw analysis from best-effort redacted reports; test exercises both surfaces. | Raw analysis must stay local/private. Redaction is not publication approval. User/maintainer. |
| PT-010 | Evidence gap | Partially reproduced: effectiveness is unmeasured. Reviewed README/UI/report text already uses investigation/hypothesis language, and demo risk/dependency factors are labeled provided. | Kept uncertainty language and added explicit synthetic-evaluation limitations. No probability, accuracy or MTTR improvement claim added. | Independent evaluation is still required before efficacy claims. Product owner. |

## Additional findings and behavior changes

1. **Output amplification:** dense matching duplicated every test's related paths into every candidate. Detail arrays now retain 20 matching tests in original order; evidence says when truncated. `relatedTestCount`/`relatedTestsTruncated` and signal-detail `relatedTestCount`/`truncated` expose full count versus displayed subset. All matches still contribute to scores. Small fixture/corpus JSON is unchanged; sparse corpus hashes were captured from the baseline source and checked automatically.
2. **Permissive timestamps:** suffix-only timezone checks allowed strings such as a diagnostic assignment ending in a parseable year, plus calendar rollover. Full ISO date/time, calendar, time and offset validation now reject these; CLI `--generated-at` uses the same parser. Seconds are required; leap-second notation and hour 24 are rejected. Offset spelling and fractional seconds remain supported.
3. **Container disk/source risk, OPEN:** `/patchtrace/workspace` is a writable host bind mount. The 64 MiB tmpfs limit only covers `/tmp`, not workspace writes. A trusted-local command can also access the host; HEAD/status/config fingerprints do not hash every ignored file or Git object. These are blockers for hostile-code verification, not proof of isolation.
4. **Browser reflow:** a long disabled verification label exceeded the side column, producing horizontal scrolling. Grid children/panels now shrink/wrap and verification labels wrap. Post-fix browser check measured document width equal to viewport width (1,102 px) for the sample with the long label. A full zoom/reflow matrix remains untested.
5. **Error logging:** unexpected HTTP failures now log a fixed event label instead of arbitrary exception objects. This avoids printing incident-derived exception strings by default. Broader structured operational logs remain future work.
6. **CSV:** formula guards include leading invisible/direction controls. This is string-level regression evidence; Excel/LibreOffice import behavior was not manually validated.

HTTP changes: `503 analysis_busy` while one analysis/body is active; `422 analysis_limit` for computational/output bounds; `503 analysis_timeout`, `analysis_cancelled` or `analysis_failed` for worker failures when a connection remains. No automatic queue/fallback/retry. Core limits count 250,000 commit/test path references and 50,000,000 overlap postings. The 5-second budget starts with worker execution/setup after body parsing/validation, not at initial request arrival. Request timeouts and body limits remain separate.

## Measurements

`npm run benchmark` performs three calls per shape, reporting median and maximum, byte size, point-in-time process RSS and event-loop delay. Delay spans consecutive synchronous calls; it is not API-worker delay. Samples were collected during development, with possible background contention; they are diagnostic observations, not p95 estimates, peak-memory measurements or an SLA.

| Shape | Commits / failures / paths | Bytes | Baseline median ms | Indexed/capped median ms |
| --- | --- | ---: | ---: | ---: |
| Small sparse | 10 / 20 / 2 | 3,470 | 1.27 | 0.92 |
| Typical sparse | 100 / 500 / 5 | 98,140 | 45.17 | 3.68 |
| Large sparse | 400 / 2,000 / 50 | 2,439,240 | 13,226.44 | 54.12 |
| Dense | 400 / 2,000 / 50 | 2,188,560 | 11,780.17 | 255.56 |

Indexed dense maximum: 261.82 ms. Dense point-in-time process RSS: about 197 MB in that multi-case benchmark; this includes more than the worker's old heap. Full files: `production/performance-before.jsonl`, `production/performance-final.jsonl`.

`npm run benchmark:api` on localhost measured three dense requests at 414–449 ms including HTTP transfer. Health took 44–67 ms and completed before analysis in all three runs; the no-active-verification cancellation route took 1.5–3.4 ms and correctly returned 409. Evidence: `production/performance-api.jsonl`. This confirms responsiveness in this environment, not a universal latency guarantee.

`npm run evaluate` uses six variants of the same synthetic demo (two development, four holdout). On those cases PatchTrace has Top-1/Top-3/MRR of 1.0, coverage 1.0 and no abstention. Latest-eligible has Top-1 0, Top-3 1, MRR 0.5; deployed-candidate temporal ordering has Top-1 0, Top-3 0.5, MRR 0.25; file-overlap has Top-1 about 0.833, Top-3 1, MRR about 0.889. These figures illustrate the harness and supplied demo bias, not effectiveness. Holdout variants are not independent historical validation.

To evaluate independent data: `node scripts/evaluate-ranking.mjs cases.json`. The JSON is a nonempty array of `{ id, split: "development" | "holdout", synthetic: boolean, expectedShas: string[], bundle }`. SHAs must exactly match labeled bundle commit identities; unresolved labels and duplicate IDs fail. Low top-candidate confidence means abstention. Rank metrics include abstained cases; output explains this and lists failures. Establish labels/splits before tuning. External validation stays OPEN.

## Check evidence

Commands run from repository root; final stdout/stderr logs and exit-code records are under `production/`. Original sandbox failures are preserved separately from the reruns. No remote CI job was triggered, no package was published and no source repository was subjected to rollback verification.

Final command outcomes are recorded in `production/final-checks.json`, `production/final-package.log` and `production/final-pack.json`. These cover `npm ci --ignore-scripts`, `npm test`, `npm run smoke`, `npm run doctor -- --json`, `npm run security`, `npm run test:coverage`, `npm run test:container`, `npm pack --dry-run --json` and `npm run test:package`. Doctor returning exit 0 means local analysis readiness; its `productionReady` remains false. The live container command returns failure because the daemon is unavailable. A zero-advisory npm audit is time-bound registry metadata, not a source-security guarantee.

| Command | Exit | Final local result |
| --- | ---: | --- |
| `npm ci --ignore-scripts` | 0 | Reproducible dependency install; no lifecycle scripts. |
| `npm test` | 0 | 128 tests: 127 passed, 0 failed, 1 skipped (Windows absolute-symlink EPERM). |
| `npm run smoke` | 0 | Actual localhost auth/sample/analysis/fixture/report flow. |
| `npm run doctor -- --json` | 0 | Local analysis ready; `productionReady: false`; Docker daemon unavailable. |
| `npm run security` | 0 | Zero known lockfile advisories returned by npm on 2026-10-22. |
| `npm run test:coverage` | 0 | 87.22% lines, 73.75% branches, 90.91% functions across reported files; diagnostic only. |
| `npm run test:container` | 1 | BLOCKED: `container_daemon_unavailable`; no live isolation pass. |
| `npm pack --dry-run --json` | 0 | Curated archive listing; actual install tested separately. |
| `npm run test:package` | 0 | Real archive installed in a clean temporary consumer; installed CLI/fixture/assets passed. |
| `npm run benchmark` / `npm run benchmark:api` / `npm run evaluate` | 0 | Measurements/synthetic evaluation described above. |
| `git diff --check` / script syntax checks | 0 | No whitespace errors; new integration/package scripts parse. |

The clean consumer gate creates a real tarball, checks file exclusions, installs with scripts/audit disabled, exercises the installed command shim and deterministic CLI analysis, and checks bundled UI/worker assets. It emits a SHA-256 of the tested archive and removes temporary consumer files. No secrets/tests/production artifacts are included by the curated package list.

Changed files fall into these groups: `src/core/analysis.mjs`, `redaction.mjs`, `report.mjs` and new `evaluation.mjs`; new `src/analysis-service.mjs` and `analysis-worker.mjs`; `server.mjs` and `bin/patchtrace.mjs`; browser script/styles; five new benchmark/evaluation/container/package scripts; analysis/output/evaluation/HTTP regressions; package scripts/file list, CI and Docker context exclusions; and current API/architecture/bundle/readiness/implementation/TODO/README documentation with preserved historical defects. No runtime dependency was added. Local bundles/audits, caches and temporary files are now excluded from the Docker build context; the actual image build remains blocked here.

Browser evidence: `production/browser-safety.png` records the imported hostile strings before the layout fix; a DOM check found zero injected images, zero attacker links and only the application's one script element. `production/browser-layout-fixed.png` records the post-fix sample view. This is a manual browser spot check through the in-app browser, not automated E2E, outbound-network tracing or WCAG conformance. Import busy state and completion, selection and fixture mode were observed. Report downloads are integration-tested via CLI/API; a browser download/assistive-technology audit remains open.

## Live container gate scope

`npm run test:container` requires a working Docker/Podman runtime and an already-local image (default `patchtrace:ci`). Missing runtime/daemon/image fails, without automatic pulls or temp-copy fallback. CI builds the image and runs the gate on Ubuntu.

The implemented live test probes non-root identity, read-only root/source, an outside host sentinel, workspace writes, tmpfs exhaustion, network connection denial, stdout/stderr bounds, timeout, cancellation, a real Git rollback hypothesis, unchanged source and workspace/container cleanup. It is **not executed successfully here**. It does not yet close memory/PID exhaustion, hostile descendant-process, workspace-disk, disconnect, shutdown, Podman or VM review requirements. The Docker build/runtime CI job and full OS/Node matrix remain unexecuted from this session.

## Internal control mapping and release decision

This is a topic-level mapping to the frameworks named in the supplied pack, not a requirement-by-requirement assessment or certification:

| Control area | ASVS 5.0.0 topic | OWASP Top 10:2025 topic | Evidence / gap |
| --- | --- | --- | --- |
| Literal report/browser text | Encoding and sanitization | Injection | Output regressions and browser spot check; renderer matrix open. |
| Secret handling | Data protection | Cryptographic/data-protection failures | Canary/redaction tests; unknown secrets/raw data remain sensitive. |
| Local API boundary | Authentication, authorization, validation | Broken access control, authentication, misconfiguration | Existing HTTP suite preserved; no remote/multi-user deployment approval. |
| Worker budgets/fail closed | Validation and business logic | Insecure design, exceptional conditions | Work/timeout/admission tests; report/copy/disk/slow-client gaps remain. |
| Pinned CI/packed consumer | Configuration and dependencies | Software supply-chain/integrity failures | Full commit pins, audit, installed-tarball check; remote release/provenance unverified. |
| Sanitized errors and truthful status | Error handling/logging | Logging and exceptional conditions | Fixed error event, readiness distinction and dated evidence; no telemetry added. |

Required next release work: enforce workspace disk limits, execute/extend adversarial live container validation, run supported platform/image jobs, finish browser/accessibility checks, and obtain independently reviewed historical ranking data. Keep raw incident data private and verification limited to intentionally trusted commands until the hostile-code boundary is proven.

**Not production-ready**
