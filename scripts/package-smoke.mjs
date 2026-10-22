import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../src/core/verification.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'patchtrace-package-'));
const run = async (argv, cwd) => {
  const result = await runCommand(argv, cwd, 60_000);
  assert.equal(result.status, 'passed', JSON.stringify(result));
  return result.stdout;
};
try {
  const [packed] = JSON.parse(await run(['npm', 'pack', '--json', '--pack-destination', temporary], repository));
  for (const file of packed.files) {
    assert.ok(!/(^|\/)(?:\.git|node_modules|tests|production)(\/|$)|\.env(?:\.|$)/.test(file.path), file.path);
  }
  const archive = join(temporary, packed.filename);
  const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
  const consumer = join(temporary, 'consumer');
  await mkdir(consumer);
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, name: 'patchtrace-consumer-smoke', version: '1.0.0' }));
  await run(['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund', archive], consumer);
  const installed = join(consumer, 'node_modules', 'patchtrace');
  const launcher = join(consumer, 'node_modules', '.bin', process.platform === 'win32' ? 'patchtrace.cmd' : 'patchtrace');
  const fixture = join(installed, 'fixtures', 'sample-incident', 'manifest.json');
  const validation = await run([launcher, 'validate', fixture], consumer);
  assert.match(validation, /Bundle is valid/);
  const report = JSON.parse(await run([process.execPath, join(installed, 'bin', 'patchtrace.mjs'), 'analyze', fixture,
    '--json', '--generated-at', '2026-10-22T00:00:00Z'], consumer));
  assert.equal(report.analysis.suspects[0].sha, 'a81e7c2');
  assert.equal(report.redaction.applied, true);
  await readFile(join(installed, 'public', 'index.html'));
  await readFile(join(installed, 'src', 'analysis-worker.mjs'));
  console.log(JSON.stringify({ package: packed.filename, sha256, files: packed.files.length,
    installedCli: 'passed', fixtureAnalysis: 'passed', assets: 'passed' }));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
