import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand, verifyRollback } from '../src/core/verification.mjs';
import { prepareContainerRuntime, createContainerCommandRunner } from '../src/core/container-runner.mjs';

// Explicit command: missing runtime/image is a failure, never a skipped success.
const runtime = await prepareContainerRuntime({ runtime: process.env.PATCHTRACE_CONTAINER_RUNTIME || 'docker',
  image: process.env.PATCHTRACE_VERIFY_IMAGE || 'patchtrace:ci', commandRunner: runCommand });
const root = await mkdtemp(join(tmpdir(), 'patchtrace-live-'));
try {
  const source = join(root, 'source');
  const workspace = join(root, 'workspace');
  await mkdir(source); await mkdir(workspace); await chmod(workspace, 0o777);
  await writeFile(join(root, 'outside-sentinel'), 'HOST-SENTINEL');
  await writeFile(join(source, 'sentinel'), 'SOURCE-SENTINEL');
  const run = createContainerCommandRunner({ ...runtime, sourcePath: source, workspacePath: workspace, commandRunner: runCommand });
  const probe = await run(['node', '-e', `
    const fs = require('node:fs'); const assert = require('node:assert/strict');
    assert.notEqual(process.getuid(), 0);
    assert.throws(() => fs.writeFileSync('/root-write-probe', 'x'));
    assert.throws(() => fs.writeFileSync('/patchtrace/source/sentinel', 'changed'));
    assert.throws(() => fs.readFileSync(${JSON.stringify(join(root, 'outside-sentinel'))}));
    fs.writeFileSync('workspace-probe', 'ok');
    assert.throws(() => fs.writeFileSync('/tmp/too-large', Buffer.alloc(70 * 1024 * 1024)));
    console.log('filesystem and tmpfs probes passed');
    const socket = require('node:net').connect({ host: '1.1.1.1', port: 443 });
    socket.setTimeout(1000);
    socket.on('connect', () => { console.error('network escape'); process.exit(1); });
    socket.on('error', () => console.log('network probe denied'));
    socket.on('timeout', () => { socket.destroy(); console.log('network probe timed out'); });
  `], workspace, 20_000);
  assert.equal(probe.status, 'passed', JSON.stringify(probe));
  assert.equal(await readFile(join(source, 'sentinel'), 'utf8'), 'SOURCE-SENTINEL');
  const output = await run(['node', '-e', "process.stdout.write('x'.repeat(400000)); process.stderr.write('y'.repeat(400000))"], workspace, 20_000);
  assert.equal(output.status, 'passed');
  assert.ok(output.stdout.length < 300_000 && output.stderr.length < 300_000);
  const timeout = await run(['node', '-e', 'while(true) {}'], workspace, 3000);
  assert.equal(timeout.status, 'timeout');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const cancelled = await run(['node', '-e', 'setInterval(()=>{},1000)'], workspace, 20_000, { signal: controller.signal });
    assert.equal(cancelled.status, 'cancelled');
  } finally { clearTimeout(timer); }

  const git = async args => {
    const result = await runCommand(['git', '-c', 'user.name=PatchTrace Integration', '-c', 'user.email=test@example.invalid', ...args], source, 10_000);
    assert.equal(result.status, 'passed', JSON.stringify(result));
    return result.stdout.trim();
  };
  await git(['init', '-q']);
  await writeFile(join(source, 'state.txt'), 'good');
  await git(['add', '.']); await git(['commit', '-qm', 'good']);
  await writeFile(join(source, 'state.txt'), 'bad');
  await git(['commit', '-qam', 'regression']);
  const sha = await git(['rev-parse', 'HEAD']);
  const result = await verifyRollback({ repoPath: source, candidateSha: sha, isolation: 'production',
    containerRuntime: runtime.runtime, containerImage: runtime.image, timeoutMs: 20_000,
    testCommand: ['node', '-e', "process.exit(require('node:fs').readFileSync('state.txt','utf8')==='good'?0:1)"] });
  assert.equal(result.outcome, 'confirmed', JSON.stringify(result));
  assert.equal(result.sourceUnchanged, true);
  assert.equal(result.cleanup.removed, true);
  assert.equal(await git(['rev-parse', 'HEAD']), sha);
  assert.equal(await readFile(join(source, 'state.txt'), 'utf8'), 'bad');
  const leftovers = await runCommand([runtime.runtime, 'ps', '-aq', '--filter', `name=patchtrace-verify-${process.pid}-`], root, 10_000);
  assert.equal(leftovers.status, 'passed');
  assert.equal(leftovers.stdout.trim(), '', 'Verification containers must be removed');
  console.log('Live container integration passed: non-root, filesystem, network, tmpfs, output, timeout, cancellation, rollback, source integrity, cleanup.');
} finally {
  await rm(root, { recursive: true, force: true });
}
