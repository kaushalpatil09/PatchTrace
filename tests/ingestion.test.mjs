import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { buildIngestedBundle, ingestIncidentBundle, normalizeIncidentBundle } from '../src/core/ingestion.mjs';

const execFileAsync = promisify(execFile);

async function runGit(repoPath, args) {
  return execFileAsync('git', ['-c', 'user.name=PatchTrace Test', '-c', 'user.email=patchtrace@example.test', ...args], { cwd: repoPath });
}

async function createRepository() {
  const root = await mkdtemp(join(tmpdir(), 'patchtrace-ingestion-git-'));
  await runGit(root, ['init', '-q']);
  await writeFile(join(root, 'src.txt'), 'one\n', 'utf8');
  await runGit(root, ['add', 'src.txt']);
  await runGit(root, ['commit', '-q', '-m', 'initial change']);
  await writeFile(join(root, 'src.txt'), 'one\ntwo\n', 'utf8');
  await runGit(root, ['add', 'src.txt']);
  await runGit(root, ['commit', '-q', '-m', 'candidate change']);
  const sha = (await runGit(root, ['rev-parse', 'HEAD'])).stdout.trim();
  return { root, sha };
}

test('normalizes overrides and merges parser output without mutating the source', async () => {
  const input = { title: 'Import test', commits: [] };
  const result = await buildIngestedBundle(input, {
    incidentStart: '2026-10-20T14:09:00Z',
    environment: 'production',
    deploymentsCsv: 'commitSha,timestamp\na81e7c2,2026-10-20T14:00:00Z\n',
    junitXml: '<testsuite><testcase name="VAT-07" file="src/tax.ts"><failure message="bad tax"/></testcase></testsuite>'
  });

  assert.deepEqual(input, { title: 'Import test', commits: [] });
  assert.equal(result.bundle.schemaVersion, 1);
  assert.equal(result.bundle.deployments[0].environment, 'production');
  assert.equal(result.bundle.tests[0].timestamp, '2026-10-20T14:09:00Z');
  assert.equal(result.bundle.tests[0].relatedFiles[0], 'src/tax.ts');
  assert.equal(result.bundle.provenance.ingestion.parserVersion, '1');
  assert.equal(result.bundle.provenance.ingestion.artifacts.length, 2);
  assert.match(result.bundle.provenance.ingestion.artifacts[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(result.provenance.repository, undefined);
});

test('enriches imported bundles from the repository adapter', async (t) => {
  const { root, sha } = await createRepository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const incidentStart = new Date(Date.now() + 60_000).toISOString();
  const result = await buildIngestedBundle({
    title: 'Repository import',
    environment: 'production',
    incidentStart,
    candidateWindowMinutes: 60,
    commits: [],
    deployments: [{ commitSha: sha, timestamp: incidentStart, environment: 'production' }]
  }, { repoPath: root });

  assert.equal(result.bundle.commits.length, 2);
  const candidate = result.bundle.commits.find((commit) => commit.sha === sha);
  assert.deepEqual(candidate.changedFiles, ['src.txt']);
  assert.equal(candidate.diffRiskSource, 'derived:git');
  assert.equal(result.provenance.repository.head, sha);
});

test('validates the final merged bundle before returning it', async () => {
  assert.throws(() => normalizeIncidentBundle({ title: 'Invalid', deployments: 'nope' }, {
    deploymentsCsv: 'commitSha,timestamp\na81e7c2,2026-10-20T14:00:00Z\n'
  }), /deployments must be an array/);

  await assert.rejects(
    ingestIncidentBundle({ title: 'Missing incident fields', commits: [] }),
    /Invalid ingested incident bundle: schemaVersion|environment|incidentStart/
  );
});
