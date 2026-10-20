import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/patchtrace.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('../fixtures/sample-incident/manifest.json', import.meta.url));
const cwd = fileURLToPath(new URL('..', import.meta.url));

async function runCli(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cli, ...args], { cwd, timeout: 30_000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' };
  }
}

test('validates the sample bundle and reports invalid bundles with exit code 2', async (t) => {
  const valid = await runCli(['validate', fixture]);
  assert.equal(valid.code, 0);
  assert.match(valid.stdout, /Bundle is valid/);

  const directory = await mkdtemp(join(tmpdir(), 'patchtrace-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const invalidPath = join(directory, 'invalid.json');
  await writeFile(invalidPath, JSON.stringify({ title: 'missing fields' }), 'utf8');
  const invalid = await runCli(['validate', invalidPath]);
  assert.equal(invalid.code, 2);
  assert.match(invalid.stderr, /is invalid/);
});

test('analyzes a bundle into a deterministic JSON report', async () => {
  const result = await runCli(['analyze', fixture, '--json', '--generated-at', '2026-10-20T00:00:00Z']);
  assert.equal(result.code, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.analysis.suspects[0].sha, 'a81e7c2');
  assert.equal(report.redaction.applied, true);
  assert.equal(report.provenance.bundleSha256.length, 64);
  assert.equal(report.provenance.platform, process.platform);
  assert.match(report.provenance.nodeVersion, /^v\d+/);
});

test('uses exit code 2 for unreadable inputs and invalid report timestamps', async (t) => {
  const missing = await runCli(['validate', join(tmpdir(), 'patchtrace-does-not-exist.json')]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /Could not read/);

  const invalidTimestamp = await runCli(['analyze', fixture, '--json', '--generated-at', '2026-10-20']);
  assert.equal(invalidTimestamp.code, 2);
  assert.match(invalidTimestamp.stderr, /timezone/);

  const invalidCommand = await runCli(['verify', '--repo', '.', '--sha', 'abcdef', '--test-command', '["node"']);
  assert.equal(invalidCommand.code, 2);

  const missingRepo = await runCli(['verify', '--repo', join(tmpdir(), 'patchtrace-no-repo'), '--sha', 'abcdef', '--test-command', 'npm test']);
  assert.equal(missingRepo.code, 2);
  assert.match(missingRepo.stderr, /Verification could not|ENOENT|no such file|not found/i);
});

test('renders Markdown and CSV reports', async () => {
  const markdown = await runCli(['report', fixture, '--format', 'markdown', '--generated-at', '2026-10-20T00:00:00Z']);
  assert.equal(markdown.code, 0);
  assert.match(markdown.stdout, /# PatchTrace analysis/);
  assert.match(markdown.stdout, /a81e7c2/);

  const csv = await runCli(['report', fixture, '--format', 'csv']);
  assert.equal(csv.code, 0);
  assert.match(csv.stdout, /^rank,sha,message/);
});

test('doctor reports the local runtime and exits successfully', async () => {
  const result = await runCli(['doctor', '--json']);
  assert.equal(result.code, 0);
  const doctor = JSON.parse(result.stdout);
  assert.equal(doctor.ok, true);
  assert.ok(doctor.checks.every((check) => check.ok));
});

test('unknown commands and options fail with a usage-style exit code', async () => {
  const result = await runCli(['not-a-command']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /unknown command/);

  const option = await runCli(['doctor', '--not-an-option']);
  assert.equal(option.code, 2);
  assert.match(option.stderr, /Unknown option|unknown option/);
});
