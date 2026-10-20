import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  isPathOutside,
  redactSecrets,
  resolveCommand,
  runCommand,
  sweepStaleWorkspaces,
  verifyRollback
} from '../src/core/verification.mjs';

const execFileAsync = promisify(execFile);

async function runGit(repoPath, args) {
  return execFileAsync('git', ['-c', 'user.name=PatchTrace Test', '-c', 'user.email=patchtrace@example.test', ...args], { cwd: repoPath });
}

async function createRepository({ candidateState = 'bad', finalState = candidateState } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'patchtrace-test-'));
  await runGit(root, ['init', '-q']);
  await writeFile(join(root, 'state.txt'), 'good\n');
  await runGit(root, ['add', 'state.txt']);
  await runGit(root, ['commit', '-q', '-m', 'initial passing state']);
  await writeFile(join(root, 'state.txt'), `${candidateState}\n`);
  await runGit(root, ['add', 'state.txt']);
  const commit = await runGit(root, ['commit', '-q', '-m', 'candidate regression']);
  const sha = (await runGit(root, ['rev-parse', 'HEAD'])).stdout.trim();
  if (finalState !== candidateState) {
    await writeFile(join(root, 'state.txt'), `${finalState}\n`);
    await runGit(root, ['add', 'state.txt']);
    await runGit(root, ['commit', '-q', '-m', 'follow-up change']);
  }
  return { root, sha, commitOutput: commit.stdout };
}

const stateCommand = ['node', '-e', "const fs=require('node:fs'); const value=fs.readFileSync('state.txt','utf8').trim(); console.log(value); process.exit(value === 'good' ? 0 : 1)"];
const alwaysFailCommand = ['node', '-e', "console.error('persistent failure'); process.exit(1)"];

test('verifies a rollback in a temporary copy and preserves the source repository', async (t) => {
  const { root, sha } = await createRepository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = await readFile(join(root, 'state.txt'), 'utf8');
  const result = await verifyRollback({ repoPath: root, candidateSha: sha, testCommand: stateCommand, timeoutMs: 5_000 });

  assert.equal(result.status, 'passed');
  assert.equal(result.reason, 'rollback_removed_failure');
  assert.equal(result.baseline.status, 'failed');
  assert.equal(result.candidate.status, 'passed');
  assert.match(result.baseline.stdout, /bad/);
  assert.match(result.candidate.stdout, /good/);
  assert.equal(result.sourceUnchanged, true);
  assert.equal(await readFile(join(root, 'state.txt'), 'utf8'), before);
});

test('reports when the rollback does not remove the failure', async (t) => {
  const { root, sha } = await createRepository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await verifyRollback({ repoPath: root, candidateSha: sha, testCommand: alwaysFailCommand, timeoutMs: 5_000 });

  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'failure_persisted');
  assert.equal(result.baseline.status, 'failed');
  assert.equal(result.candidate.status, 'failed');
  assert.equal(result.sourceUnchanged, true);
});

test('reports a baseline timeout and does not run the candidate phase', async (t) => {
  const { root, sha } = await createRepository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await verifyRollback({
    repoPath: root,
    candidateSha: sha,
    testCommand: ['node', '-e', 'setTimeout(() => {}, 10000)'],
    timeoutMs: 50
  });

  assert.equal(result.status, 'timeout');
  assert.equal(result.reason, 'test_timeout');
  assert.equal(result.baseline.status, 'timeout');
  assert.equal(result.candidate, null);
  assert.equal(result.sourceUnchanged, true);
});

test('rejects linked worktrees before copying or running anything', async (t) => {
  const { root, sha } = await createRepository();
  const worktreeParent = await mkdtemp(join(tmpdir(), 'patchtrace-worktree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(worktreeParent, { recursive: true, force: true }));
  const linked = join(worktreeParent, 'linked');
  await runGit(root, ['worktree', 'add', '-q', '-b', 'linked-branch', linked]);
  const statusBefore = (await runGit(root, ['status', '--porcelain'])).stdout;

  const result = await verifyRollback({
    repoPath: linked,
    candidateSha: sha,
    testCommand: stateCommand,
    timeoutMs: 5_000
  });

  assert.equal(result.status, 'unsupported_layout');
  assert.equal(result.reason, 'unsupported_worktree');
  assert.equal(result.outcome, 'invalid_repo');
  assert.equal(result.sourceUnchanged, true);
  assert.equal(result.baseline, null);
  assert.equal(result.candidate, null);
  assert.equal((await runGit(root, ['status', '--porcelain'])).stdout, statusBefore);
});

test('fails closed for an absolute link into source Git metadata', async (t) => {
  const { root, sha } = await createRepository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const metadataPath = join(root, '.git', 'config');
  const linkPath = join(root, 'metadata-link');
  try {
    if (process.platform === 'win32') {
      await symlink(metadataPath, linkPath, 'file');
    } else {
      await symlink(metadataPath, linkPath);
    }
  } catch (error) {
    if (process.platform === 'win32' && ['EACCES', 'EPERM', 'UNKNOWN'].includes(error.code)) {
      t.skip(`absolute symlinks are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  if (!(await lstat(linkPath)).isSymbolicLink()) {
    t.skip('the platform did not create a symbolic link');
    return;
  }
  await runGit(root, ['add', 'metadata-link']);
  await runGit(root, ['commit', '-q', '-m', 'absolute metadata link']);

  const before = await readFile(metadataPath, 'utf8');
  const result = await verifyRollback({
    repoPath: root,
    candidateSha: sha,
    testCommand: [
      process.execPath,
      '-e',
      "require('node:fs').appendFileSync('metadata-link', 'patchtrace-source-integrity-test'); process.exit(1)"
    ],
    timeoutMs: 5_000,
    baselineRuns: 1
  });

  assert.equal(result.status, 'unsupported_layout');
  assert.equal(result.outcome, 'invalid_repo');
  assert.equal(result.reason, 'absolute_symlink');
  assert.equal(result.baseline, null);
  assert.equal(result.candidate, null);
  assert.equal(result.sourceUnchanged, true);
  assert.equal(await readFile(metadataPath, 'utf8'), before);
});

test('detects parent and cross-drive path escapes', () => {
  const root = process.platform === 'win32' ? 'C:\\repo' : '/repo';
  assert.equal(isPathOutside(root, join(root, 'src', 'app.js')), false);
  assert.equal(isPathOutside(root, join(root, '..', 'other')), true);
  if (process.platform === 'win32') {
    assert.equal(isPathOutside(root, 'D:\\secret.txt'), true);
  } else {
    assert.equal(isPathOutside(root, '/etc/passwd'), true);
  }
});

test('resolves and runs npm through the Windows command wrapper', async () => {
  if (process.platform === 'win32') {
    assert.match(resolveCommand('npm'), /\.(cmd|bat)$/i);
  }
  const result = await runCommand(['npm', '--version'], process.cwd(), 15_000);
  assert.equal(result.status, 'passed');
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
});

test('rejects a dirty source worktree before copying or running tests', async (t) => {
  const { root, sha } = await createRepository();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'uncommitted.txt'), 'not committed\n');
  const result = await verifyRollback({
    repoPath: root,
    candidateSha: sha,
    testCommand: stateCommand,
    timeoutMs: 5_000
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.outcome, 'invalid_repo');
  assert.equal(result.reason, 'dirty_worktree');
  assert.equal(result.sourceDirty, true);
  assert.equal(result.sourceUnchanged, true);
  assert.equal(result.baseline, null);
  assert.equal(result.candidate, null);
  assert.equal(result.cleanup.removed, false);
  assert.equal(result.cleanup.skipped, true);
});

test('does not run a revert when the baseline already passes', async (t) => {
  const { root, sha } = await createRepository();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'state.txt'), 'good\n');
  await runGit(root, ['add', 'state.txt']);
  await runGit(root, ['commit', '-q', '-m', 'restore passing state']);

  const result = await verifyRollback({
    repoPath: root,
    candidateSha: sha,
    testCommand: stateCommand,
    timeoutMs: 5_000
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.outcome, 'inconclusive');
  assert.equal(result.reason, 'baseline_did_not_fail');
  assert.equal(result.baseline.status, 'passed');
  assert.equal(result.candidate, null);
  assert.equal(result.revert, null);
  assert.equal(result.sourceUnchanged, true);
});

test('reports a candidate that is missing from reachable history', async (t) => {
  const { root } = await createRepository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await verifyRollback({
    repoPath: root,
    candidateSha: '0000000000000000000000000000000000000000',
    testCommand: stateCommand
  });

  assert.equal(result.status, 'missing_history');
  assert.equal(result.reason, 'candidate_missing_or_unreachable');
  assert.equal(result.baseline, null);
  assert.equal(result.candidate, null);
  assert.equal(result.sourceUnchanged, true);
});

test('rejects a repository with no HEAD commit before copying', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'patchtrace-empty-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await runGit(root, ['init', '-q']);
  const result = await verifyRollback({
    repoPath: root,
    candidateSha: 'abcdef',
    testCommand: stateCommand
  });
  assert.equal(result.status, 'missing_history');
  assert.equal(result.outcome, 'invalid_repo');
  assert.equal(result.reason, 'not_a_git_repository');
  assert.equal(result.sourceUnchanged, false);
});

test('rejects a temporary root inside the source repository', async (t) => {
  const { root, sha } = await createRepository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const inside = await mkdtemp(join(root, 'tmp-'));
  await assert.rejects(
    verifyRollback({ repoPath: root, candidateSha: sha, testCommand: stateCommand, tempRoot: inside }),
    /inside repoPath/
  );
});

test('redacts likely secrets from command output', async (t) => {
  const result = await runCommand([
    process.execPath,
    '-e',
    "console.log('password=hunter2'); console.log('Authorization: Bearer abcdefghijklmnop'); console.log('ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');"
  ], process.cwd(), 5_000);
  assert.equal(result.status, 'passed');
  assert.doesNotMatch(result.stdout, /hunter2|abcdefghijklmnop|ghp_/);
  assert.match(result.stdout, /\[redacted/);
  assert.ok(result.redactions >= 2);

  const privateKey = redactSecrets('-----BEGIN RSA PRIVATE KEY-----\nnot-a-real-key\n-----END RSA PRIVATE KEY-----');
  assert.equal(privateKey.redactions, 1);
  assert.doesNotMatch(privateKey.text, /not-a-real-key/);
});

test('sweeps only old, marked temporary workspaces', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'patchtrace-sweep-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const now = Date.now();
  const oldWorkspace = join(root, 'patchtrace-old');
  const recentWorkspace = join(root, 'patchtrace-recent');
  const unmarkedWorkspace = join(root, 'patchtrace-unmarked');
  await mkdir(oldWorkspace);
  await mkdir(recentWorkspace);
  await mkdir(unmarkedWorkspace);
  await writeFile(join(oldWorkspace, '.patchtrace-workspace'), '{}');
  await writeFile(join(recentWorkspace, '.patchtrace-workspace'), '{}');
  await utimes(join(oldWorkspace, '.patchtrace-workspace'), new Date(now - 60_000), new Date(now - 60_000));
  await utimes(join(recentWorkspace, '.patchtrace-workspace'), new Date(now), new Date(now));
  await utimes(unmarkedWorkspace, new Date(now - 60_000), new Date(now - 60_000));

  const result = await sweepStaleWorkspaces({ tempRoot: root, maxAgeMs: 1_000, now });
  assert.deepEqual(result.removed, ['patchtrace-old']);
  assert.equal(await stat(join(recentWorkspace, '.patchtrace-workspace')).then(() => true, () => false), true);
  assert.equal(await stat(unmarkedWorkspace).then(() => true, () => false), true);
  assert.equal(await stat(oldWorkspace).then(() => true, () => false), false);
});

test('runs the baseline twice and reports an unstable baseline', async (t) => {
  const { root, sha } = await createRepository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const flakyCommand = [
    process.execPath,
    '-e',
    "const fs=require('node:fs'); const marker='.baseline-run'; const n=fs.existsSync(marker)?Number(fs.readFileSync(marker,'utf8')):0; fs.writeFileSync(marker,String(n+1)); process.exit(n===0?1:0);"
  ];
  const result = await verifyRollback({ repoPath: root, candidateSha: sha, testCommand: flakyCommand, timeoutMs: 5_000 });

  assert.equal(result.status, 'failed');
  assert.equal(result.outcome, 'inconclusive');
  assert.equal(result.reason, 'flaky_baseline');
  assert.equal(result.baselineRuns.length, 2);
  assert.deepEqual(result.baselineRuns.map((run) => run.status), ['failed', 'passed']);
  assert.equal(result.candidate, null);
  assert.equal(result.sourceUnchanged, true);
});

test('cancels a run, terminates the child, and cleans up the temporary copy', async (t) => {
  const { root, sha } = await createRepository();
  const marker = join(tmpdir(), `patchtrace-cancel-marker-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(marker, { force: true }));
  const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); setTimeout(() => {}, 30000);`;
  const controller = new AbortController();
  const pending = verifyRollback({
    repoPath: root,
    candidateSha: sha,
    testCommand: [process.execPath, '-e', script],
    timeoutMs: 60_000,
    signal: controller.signal
  });
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (await stat(marker).then(() => true, () => false)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  controller.abort();
  const result = await pending;

  assert.equal(result.status, 'cancelled');
  assert.equal(result.outcome, 'cancelled');
  assert.equal(result.reason, 'cancelled');
  assert.equal(result.baseline.status, 'cancelled');
  assert.equal(result.sourceUnchanged, true);
  assert.equal(result.cleanup.removed, true);
  assert.equal(result.candidate, null);
});
