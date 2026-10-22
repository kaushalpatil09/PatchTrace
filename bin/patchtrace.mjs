#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { analyzeIncident, validateIncident } from '../src/core/analysis.mjs';
import { parseTestCommand } from '../src/core/command-line.mjs';
import { prepareContainerRuntime } from '../src/core/container-runner.mjs';
import { enrichIncidentFromRepository } from '../src/core/git-adapter.mjs';
import { buildIngestedBundle } from '../src/core/ingestion.mjs';
import { buildReport, renderCsv, renderMarkdown } from '../src/core/report.mjs';
import { runCommand, sweepStaleWorkspaces, verifyRollback } from '../src/core/verification.mjs';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const VERSION = packageJson.version || '0.1.0';
const MAX_INPUT_BYTES = 5 * 1024 * 1024;
const ISO_WITH_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

class CliError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

function usage() {
  return `PatchTrace ${VERSION}

Usage:
  patchtrace doctor [--json] [--strict-container]
  patchtrace validate <bundle.json> [--json]
  patchtrace ingest <bundle.json> --out <bundle.json> [--repo <path>] [--deployments <csv>] [--junit <xml>] [--incident-start <timestamp>] [--environment <name>]
  patchtrace analyze <bundle.json> [--repo <path>] [--json] [--out <file>] [--format human|json|markdown|csv]
  patchtrace verify --repo <path> --sha <sha> [--test-command <command|json>] [--timeout <ms>] [--json]
  patchtrace report <bundle.json> [--repo <path>] [--verification <json>] [--out <file>] [--format markdown|json|csv]

Bundle input:
  - reads a versioned JSON incident bundle; use "-" to read stdin
  - schema: docs/INCIDENT_BUNDLE.md

Verification:
  - default mode is a trusted-local temp-copy: best-effort only, not a security sandbox
  - set PATCHTRACE_VERIFY_ISOLATION=production to require the constrained Docker/Podman runner
  - production mode fails closed when its runtime or image is unavailable; it never falls back to temp-copy
  - human and JSON results report the requested/effective mode, boundary, and audit fields

Exit codes:
  0 success/confirmed   1 not confirmed   2 invalid input   3 timeout   4 command error
`;
}

async function readText(path) {
  if (path === '-') {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > MAX_INPUT_BYTES) {
        throw new CliError(`Input exceeds the ${Math.floor(MAX_INPUT_BYTES / (1024 * 1024))} MB limit.`, 2);
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  try {
    const info = await stat(path);
    if (info.isFile() && info.size > MAX_INPUT_BYTES) {
      throw new CliError(`Input exceeds the ${Math.floor(MAX_INPUT_BYTES / (1024 * 1024))} MB limit.`, 2);
    }
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`Could not read ${path}: ${error.message}`, 2);
  }
}

async function readBundle(path) {
  const text = await readText(path);
  let bundle;
  try {
    bundle = JSON.parse(text);
  } catch (error) {
    throw new CliError(`Bundle is not valid JSON: ${error.message}`, 2);
  }
  return { bundle, text };
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseInteger(value, label, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new CliError(`${label} must be an integer between ${min} and ${max}.`, 2);
  }
  return number;
}

function parseGeneratedAt(value) {
  if (!value) return new Date().toISOString();
  if (!ISO_WITH_ZONE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new CliError('--generated-at must be an ISO 8601 timestamp with a timezone.', 2);
  }
  return value;
}

async function output(value, outPath) {
  const text = value.endsWith('\n') ? value : `${value}\n`;
  if (!outPath) {
    process.stdout.write(text);
    return;
  }
  try {
    await writeFile(outPath, text, 'utf8');
  } catch (error) {
    throw new CliError(`Could not write ${outPath}: ${error.message}`, 1);
  }
}

function humanAnalysis(report) {
  const { analysis, provenance } = report;
  const lines = [];
  lines.push(`Incident: ${analysis.incident.title}`);
  lines.push(`Environment: ${analysis.incident.environment}`);
  lines.push(`Window: ${analysis.candidateWindowMinutes} minutes · ${analysis.excludedCandidateCount} excluded`);
  if (provenance?.repository) {
    lines.push(`Repository: ${provenance.repository.branch || 'detached'} ${provenance.repository.head} (${provenance.repository.dirty ? 'dirty' : 'clean'})`);
  }
  if (analysis.warnings.length) {
    lines.push('', 'Warnings:');
    for (const warning of analysis.warnings) lines.push(`  - ${warning}`);
  }
  lines.push('', 'Ranked candidates:');
  if (!analysis.suspects.length) {
    lines.push('  (none)');
  } else {
    analysis.suspects.forEach((suspect, index) => {
      lines.push(`  ${index + 1}. ${suspect.sha}  score=${suspect.score.toFixed(3)}  ${suspect.confidence}  coverage=${Math.round(suspect.coverage * 100)}%  ${suspect.message}`);
    });
    const top = analysis.suspects[0];
    lines.push('', `Why ${top.sha} ranks first:`);
    for (const item of top.evidence) lines.push(`  - ${item.text}`);
  }
  lines.push('', 'Evidence is not proof of root cause.');
  return lines.join('\n');
}

function verificationIsolationNotice(result) {
  if (result.isolation === 'container') {
    if (['container_runtime_unavailable', 'container_daemon_unavailable', 'container_image_unavailable'].includes(result.reason)) {
      return 'constrained Docker/Podman mode was requested but not established; production/container mode fails closed when its runtime or image is unavailable and never falls back to temp-copy.';
    }
    return 'constrained Docker/Podman container; production/container mode fails closed when its runtime or image is unavailable and never falls back to temp-copy.';
  }
  if (result.isolation === 'temp-copy') {
    return 'trusted-local temporary copy; best-effort boundary only, not a security sandbox, and the command may access the host filesystem or network.';
  }
  return 'isolation mode was not established.';
}

function humanVerification(result) {
  const lines = [];
  lines.push(`Verification: ${result.status} (${result.outcome})`);
  lines.push(`Isolation: ${result.isolation || 'unknown'} (requested ${result.isolationRequested || result.isolation || 'unknown'})`);
  if (result.isolationBoundary) lines.push(`Boundary type: ${result.isolationBoundary}`);
  lines.push(`Isolation boundary: ${result.isolationNotice || verificationIsolationNotice(result)}`);
  lines.push(`Reason: ${result.reason}`);
  if (result.message) lines.push(`Message: ${result.message}`);
  lines.push(`Source unchanged: ${result.sourceUnchanged ? 'yes' : 'no'}`);
  if (result.baseline) {
    const runs = Array.isArray(result.baselineRuns) ? result.baselineRuns.length : 1;
    lines.push(`Baseline: ${result.baseline.status} (exit ${result.baseline.exitCode ?? 'n/a'}, ${runs} run${runs === 1 ? '' : 's'})`);
  }
  if (result.revert) lines.push(`Revert: ${result.revert.status}`);
  if (result.candidate) lines.push(`Candidate: ${result.candidate.status} (exit ${result.candidate.exitCode ?? 'n/a'})`);
  if (result.durationMs !== null && result.durationMs !== undefined) lines.push(`Duration: ${result.durationMs} ms`);
  const redactions = (result.baselineRuns || []).reduce((total, run) => total + (run.redactions || 0), 0)
    + (result.revert?.redactions || 0)
    + (result.candidate?.redactions || 0);
  if (redactions) lines.push(`Redactions: ${redactions} likely secret(s) removed from command output`);
  if (result.cleanup?.removed === false && !result.cleanup.skipped) {
    lines.push(`Cleanup failed: ${result.cleanup.error || 'temporary workspace remains'}`);
  }
  if (result.baseline?.stdout?.trim()) lines.push('', 'Baseline stdout:', result.baseline.stdout.trim().slice(0, 2000));
  if (result.baseline?.stderr?.trim()) lines.push('', 'Baseline stderr:', result.baseline.stderr.trim().slice(0, 2000));
  if (result.candidate?.stdout?.trim()) lines.push('', 'Candidate stdout:', result.candidate.stdout.trim().slice(0, 2000));
  if (result.candidate?.stderr?.trim()) lines.push('', 'Candidate stderr:', result.candidate.stderr.trim().slice(0, 2000));
  return lines.join('\n');
}

async function commandDoctor(args) {
  const parsed = parseArgs({
    args,
    allowPositionals: false,
    options: {
      json: { type: 'boolean' },
      'strict-container': { type: 'boolean' },
      help: { type: 'boolean' }
    }
  });
  if (parsed.values.help) {
    process.stdout.write(usage());
    return 0;
  }
  const checks = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push({ name: 'node', ok: nodeMajor >= 22, detail: process.versions.node });
  const git = await runCommand(['git', '--version'], process.cwd(), 10_000);
  const gitVersion = git.stdout.match(/git version (\d+)\.(\d+)/i);
  const gitMajor = Number(gitVersion?.[1] ?? 0);
  const gitMinor = Number(gitVersion?.[2] ?? 0);
  const gitVersionOk = gitMajor > 2 || (gitMajor === 2 && gitMinor >= 31);
  checks.push({
    name: 'git',
    ok: git.status === 'passed' && gitVersionOk,
    detail: git.status === 'passed'
      ? `${git.stdout.trim()}${gitVersionOk ? '' : ' (Git 2.31 or newer is required)'}`
      : (git.stderr.trim() || git.error || 'git not found')
  });
  let tempOk = false;
  let tempDetail = '';
  try {
    const directory = await mkdtemp(join(tmpdir(), 'patchtrace-doctor-'));
    const probe = join(directory, 'probe.txt');
    await writeFile(probe, 'ok', 'utf8');
    tempOk = (await readFile(probe, 'utf8')) === 'ok';
    await rm(directory, { recursive: true, force: true });
    tempDetail = directory;
  } catch (error) {
    tempOk = false;
    tempDetail = error.message;
  }
  checks.push({ name: 'temporary workspace', ok: tempOk, detail: tempDetail });

  let container;
  try {
    const prepared = await prepareContainerRuntime({
      commandRunner: runCommand,
      cwd: process.cwd(),
      timeoutMs: 10_000
    });
    container = {
      ready: true,
      status: 'ready',
      runtimeReady: true,
      imageReady: true,
      runtime: prepared.runtime,
      image: prepared.image,
      version: prepared.version || null,
      detail: `${prepared.runtime} can inspect ${prepared.image}.`
    };
  } catch (error) {
    container = {
      ready: false,
      status: 'unavailable',
      runtimeReady: !['container_runtime_unavailable', 'container_daemon_unavailable'].includes(error.code),
      imageReady: false,
      runtime: error.details?.runtime ?? process.env.PATCHTRACE_CONTAINER_RUNTIME ?? null,
      image: error.details?.image ?? process.env.PATCHTRACE_VERIFY_IMAGE ?? 'patchtrace:local',
      code: error.code || 'container_unavailable',
      detail: error.message || 'No usable container runtime and verification image were found.'
    };
  }

  const localReady = checks.every((check) => check.ok);
  const containerRequired = Boolean(parsed.values['strict-container']
    || process.env.PATCHTRACE_VERIFY_ISOLATION === 'production');
  // Container verification is a separate capability during normal local
  // analysis, but a requested production gate must fail closed when it is not
  // ready. This keeps the default doctor useful without implying isolation.
  const productionReady = localReady && container.ready;
  const ok = localReady && (!containerRequired || container.ready);

  if (parsed.values.json) {
    printJson({ schemaVersion: 1, ok, productionReady, containerRequired, version: VERSION, checks, container });
  } else {
    for (const check of checks) {
      process.stdout.write(`${check.ok ? 'ok' : 'FAIL'}  ${check.name}: ${check.detail}\n`);
    }
    process.stdout.write(`${container.ready ? 'ok' : 'WARN'}  container runtime/image: ${container.detail}\n`);
    process.stdout.write(ok
      ? (container.ready ? 'doctor: ready\n' : 'doctor: ready for local analysis; container verification is unavailable\n')
      : containerRequired && !container.ready
        ? 'doctor: problems found (container verification is unavailable)\n'
        : 'doctor: problems found\n');
  }
  return ok ? 0 : 1;
}

async function commandValidate(args) {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: { json: { type: 'boolean' }, help: { type: 'boolean' } }
  });
  if (parsed.values.help || !parsed.positionals[0]) {
    process.stdout.write(usage());
    return parsed.values.help ? 0 : 2;
  }
  const { bundle } = await readBundle(parsed.positionals[0]);
  const result = validateIncident(bundle);
  if (parsed.values.json) {
    printJson({ schemaVersion: 1, valid: result.valid, errors: result.errors });
  } else if (result.valid) {
    process.stdout.write('Bundle is valid.\n');
  } else {
    process.stderr.write(`Bundle is invalid (${result.errors.length} error${result.errors.length === 1 ? '' : 's'}):\n`);
    for (const error of result.errors) process.stderr.write(`  ${error.path || 'bundle'}: ${error.message}\n`);
  }
  return result.valid ? 0 : 2;
}

async function readOptionalIngestInput(path, label) {
  if (!path) return undefined;
  try {
    return await readText(path);
  } catch (error) {
    if (error instanceof CliError) {
      throw new CliError(`Could not read --${label} input ${path}: ${error.message}`, error.exitCode);
    }
    throw error;
  }
}

async function commandIngest(args) {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      deployments: { type: 'string' },
      junit: { type: 'string' },
      'incident-start': { type: 'string' },
      environment: { type: 'string' },
      out: { type: 'string' },
      'max-commits': { type: 'string' },
      help: { type: 'boolean' }
    }
  });
  if (parsed.values.help || !parsed.positionals[0]) {
    process.stdout.write(usage());
    return parsed.values.help ? 0 : 2;
  }
  if (parsed.positionals.length > 1) {
    throw new CliError('ingest accepts exactly one bundle JSON input path.', 2);
  }
  if (!parsed.values.out) {
    throw new CliError('ingest requires --out <bundle.json> so the versioned bundle can be written locally.', 2);
  }

  const { bundle, text } = await readBundle(parsed.positionals[0]);
  const [deploymentsCsv, junitXml] = await Promise.all([
    readOptionalIngestInput(parsed.values.deployments, 'deployments'),
    readOptionalIngestInput(parsed.values.junit, 'junit')
  ]);
  const maxCommits = parsed.values['max-commits']
    ? parseInteger(parsed.values['max-commits'], '--max-commits', { min: 1, max: 500 })
    : undefined;

  let result;
  try {
    result = await buildIngestedBundle(bundle, {
      repoPath: parsed.values.repo,
      deploymentsCsv,
      junitXml,
      incidentStart: parsed.values['incident-start'],
      environment: parsed.values.environment,
      maxCommits,
      bundleText: text,
      bundleSourcePath: parsed.positionals[0],
      deploymentsSourcePath: parsed.values.deployments,
      junitSourcePath: parsed.values.junit
    });
  } catch (error) {
    throw new CliError(`Could not ingest bundle: ${error.message}`, error.code === 'invalid_bundle' ? 2 : 2);
  }

  try {
    await output(JSON.stringify(result.bundle, null, 2), parsed.values.out);
  } catch (error) {
    if (error instanceof CliError) {
      throw new CliError(`Could not write ingested bundle ${parsed.values.out}: ${error.message}`, error.exitCode);
    }
    throw error;
  }
  return 0;
}

async function prepareAnalysis(bundle, text, { repo, maxCommits }) {
  let input = bundle;
  const provenance = {
    bundleSha256: createHash('sha256').update(text).digest('hex'),
    toolVersion: VERSION,
    platform: process.platform,
    nodeVersion: process.version
  };
  if (repo) {
    try {
      const enriched = await enrichIncidentFromRepository(bundle, { repoPath: repo, maxCommits });
      input = enriched.input;
      Object.assign(provenance, enriched.provenance);
    } catch (error) {
      throw new CliError(`Repository enrichment failed: ${error.message}`, 2);
    }
  }
  const validation = validateIncident(input);
  if (!validation.valid) {
    const summary = validation.errors.slice(0, 8).map((error) => `${error.path || 'bundle'}: ${error.message}`).join('; ');
    throw new CliError(`Invalid incident bundle: ${summary}`, 2);
  }
  return { analysis: analyzeIncident(input), provenance };
}

async function commandAnalyze(args) {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      json: { type: 'boolean' },
      out: { type: 'string' },
      format: { type: 'string' },
      'max-commits': { type: 'string' },
      'generated-at': { type: 'string' },
      help: { type: 'boolean' }
    }
  });
  if (parsed.values.help || !parsed.positionals[0]) {
    process.stdout.write(usage());
    return parsed.values.help ? 0 : 2;
  }
  const maxCommits = parsed.values['max-commits']
    ? parseInteger(parsed.values['max-commits'], '--max-commits', { min: 1, max: 500 })
    : 200;
  const { bundle, text } = await readBundle(parsed.positionals[0]);
  const { analysis, provenance } = await prepareAnalysis(bundle, text, {
    repo: parsed.values.repo,
    maxCommits
  });
  const report = buildReport({
    analysis,
    provenance,
    generatedAt: parseGeneratedAt(parsed.values['generated-at']),
    toolVersion: VERSION
  });
  const format = parsed.values.json ? 'json' : (parsed.values.format || (parsed.values.out ? 'json' : 'human'));
  if (!['human', 'json', 'markdown', 'csv'].includes(format)) {
    throw new CliError('--format must be human, json, markdown, or csv.', 2);
  }
  const rendered = format === 'json' ? JSON.stringify(report, null, 2)
    : format === 'markdown' ? renderMarkdown(report)
      : format === 'csv' ? renderCsv(analysis)
        : humanAnalysis(report);
  await output(rendered, parsed.values.out);
  return 0;
}

function verificationExitCode(result) {
  if (result.status === 'passed') return 0;
  if (result.status === 'timeout') return 3;
  if (result.status === 'missing_history' || result.status === 'unsupported_layout') return 2;
  if (result.reason === 'dirty_worktree') return 2;
  if (['command_error', 'runner_error', 'revert_failed'].includes(result.reason)) return 4;
  return 1;
}

async function commandVerify(args) {
  const parsed = parseArgs({
    args,
    allowPositionals: false,
    options: {
      repo: { type: 'string' },
      sha: { type: 'string' },
      'test-command': { type: 'string' },
      timeout: { type: 'string' },
      mainline: { type: 'string' },
      json: { type: 'boolean' },
      out: { type: 'string' },
      help: { type: 'boolean' }
    }
  });
  if (parsed.values.help || !parsed.values.repo || !parsed.values.sha) {
    process.stdout.write(usage());
    return parsed.values.help ? 0 : 2;
  }
  const testCommand = (() => {
    try {
      return parseTestCommand(parsed.values['test-command'] || 'npm test');
    } catch (error) {
      throw new CliError(error.message, 2);
    }
  })();
  const timeoutMs = parsed.values.timeout
    ? parseInteger(parsed.values.timeout, '--timeout', { min: 1, max: 600_000 })
    : 30_000;
  const mainline = parsed.values.mainline
    ? parseInteger(parsed.values.mainline, '--mainline', { min: 1 })
    : undefined;

  const controller = new AbortController();
  const cancel = () => {
    if (controller.signal.aborted) return;
    process.stderr.write('\nCancelling verification and cleaning up the temporary copy...\n');
    controller.abort();
  };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  let result;
  try {
    result = await verifyRollback({
      repoPath: parsed.values.repo,
      candidateSha: parsed.values.sha,
      testCommand,
      timeoutMs,
      mainline,
      signal: controller.signal
    }).catch((error) => {
      throw new CliError(error.message, 2);
    });
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
  const presented = {
    ...result,
    isolationNotice: verificationIsolationNotice(result)
  };
  await output(parsed.values.json ? JSON.stringify(presented, null, 2) : humanVerification(presented), parsed.values.out);
  return verificationExitCode(result);
}

async function commandReport(args) {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      verification: { type: 'string' },
      out: { type: 'string' },
      format: { type: 'string' },
      'max-commits': { type: 'string' },
      'generated-at': { type: 'string' },
      help: { type: 'boolean' }
    }
  });
  if (parsed.values.help || !parsed.positionals[0]) {
    process.stdout.write(usage());
    return parsed.values.help ? 0 : 2;
  }
  const maxCommits = parsed.values['max-commits']
    ? parseInteger(parsed.values['max-commits'], '--max-commits', { min: 1, max: 500 })
    : 200;
  const { bundle, text } = await readBundle(parsed.positionals[0]);
  const { analysis, provenance } = await prepareAnalysis(bundle, text, {
    repo: parsed.values.repo,
    maxCommits
  });
  let verification = null;
  if (parsed.values.verification) {
    const textVerification = await readText(parsed.values.verification);
    try {
      verification = JSON.parse(textVerification);
    } catch (error) {
      throw new CliError(`Verification is not valid JSON: ${error.message}`, 2);
    }
    if (!verification || typeof verification !== 'object' || Array.isArray(verification)) {
      throw new CliError('Verification JSON must be an object.', 2);
    }
  }
  const report = buildReport({
    analysis,
    verification,
    provenance,
    generatedAt: parseGeneratedAt(parsed.values['generated-at']),
    toolVersion: VERSION
  });
  const format = parsed.values.format || 'markdown';
  if (!['markdown', 'json', 'csv'].includes(format)) {
    throw new CliError('--format must be markdown, json, or csv.', 2);
  }
  const rendered = format === 'json' ? JSON.stringify(report, null, 2)
    : format === 'csv' ? renderCsv(analysis)
      : renderMarkdown(report);
  await output(rendered, parsed.values.out);
  return 0;
}

async function main(argv) {
  const [command, ...args] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(usage());
    return 0;
  }
  if (command === '--version' || command === '-v' || command === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (command === 'verify') {
    await sweepStaleWorkspaces().catch(() => {});
  }
  switch (command) {
    case 'doctor': return commandDoctor(args);
    case 'validate': return commandValidate(args);
    case 'ingest': return commandIngest(args);
    case 'analyze': return commandAnalyze(args);
    case 'verify': return commandVerify(args);
    case 'report': return commandReport(args);
    default:
      process.stderr.write(`patchtrace: unknown command "${command}"\n\n${usage()}`);
      return 2;
  }
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write(`patchtrace: ${error.message}\n`);
  const parseArgumentError = typeof error?.code === 'string' && error.code.startsWith('ERR_PARSE_ARGS');
  process.exitCode = error instanceof CliError ? error.exitCode : parseArgumentError ? 2 : 1;
});
