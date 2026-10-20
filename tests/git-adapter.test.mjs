import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { analyzeIncident } from '../src/core/analysis.mjs';
import { enrichIncidentFromRepository, readRepositoryCommits } from '../src/core/git-adapter.mjs';

const execFileAsync = promisify(execFile);

async function runGit(repoPath, args) {
  return execFileAsync('git', ['-c', 'user.name=PatchTrace Test', '-c', 'user.email=patchtrace@example.test', ...args], { cwd: repoPath });
}

async function createRepository() {
  const root = await mkdtemp(join(tmpdir(), 'patchtrace-git-'));
  await runGit(root, ['init', '-q']);
  await writeFile(join(root, 'src.txt'), 'one\n');
  await runGit(root, ['add', 'src.txt']);
  await runGit(root, ['commit', '-q', '-m', 'initial change']);
  await writeFile(join(root, 'src.txt'), 'one\ntwo\nthree\n');
  await writeFile(join(root, 'extra.txt'), 'extra\n');
  await runGit(root, ['add', 'src.txt', 'extra.txt']);
  await runGit(root, ['commit', '-q', '-m', 'candidate change']);
  const sha = (await runGit(root, ['rev-parse', 'HEAD'])).stdout.trim();
  return { root, sha };
}

test('reads commits with changed files and derived diff risk', async (t) => {
  const { root, sha } = await createRepository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const commits = await readRepositoryCommits({ repoPath: root, maxCommits: 10 });
  assert.equal(commits.length, 2);
  const candidate = commits.find((commit) => commit.sha === sha);
  assert.deepEqual(candidate.changedFiles.sort(), ['extra.txt', 'src.txt']);
  assert.ok(candidate.diffRisk > 0);
  assert.equal(candidate.diffRiskSource, 'derived:git');
});

test('enriches bundle commits from the repository and records provenance', async (t) => {
  const { root, sha } = await createRepository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const incidentStart = new Date(Date.now() + 60_000).toISOString();
  const input = {
    schemaVersion: 1,
    title: 'Repository enrichment',
    summary: 'test',
    environment: 'production',
    incidentStart,
    candidateWindowMinutes: 60,
    incidentFiles: ['src.txt'],
    commits: [{
      sha: sha.slice(0, 7),
      timestamp: incidentStart,
      message: 'candidate change',
      changedFiles: []
    }],
    deployments: [{ commitSha: sha, timestamp: incidentStart, environment: 'production' }],
    tests: [{ name: 'test', status: 'failed', relatedFiles: ['src.txt'] }]
  };

  const { input: enriched, provenance } = await enrichIncidentFromRepository(input, { repoPath: root, maxCommits: 10 });
  assert.ok(analyzeIncident(enriched).suspects[0].factors.temporal > 0);
  assert.deepEqual(enriched.commits[0].changedFiles.sort(), ['extra.txt', 'src.txt']);
  assert.equal(enriched.commits[0].diffRiskSource, 'derived:git');
  assert.match(provenance.repository.head, /^[0-9a-f]{40}$/);
  assert.equal(provenance.repository.dirty, false);
  assert.equal(provenance.enrichment.commitsFromBundle, 1);
  assert.equal(provenance.enrichment.matchedBundleCommits, 1);
  assert.equal(provenance.enrichment.ambiguousBundleCommits, 0);
  assert.equal(provenance.enrichment.unresolvedBundleCommits, 0);
  assert.deepEqual(provenance.enrichment.ambiguousBundleShas, []);
  assert.deepEqual(provenance.enrichment.unresolvedBundleShas, []);
  assert.equal(provenance.enrichment.truncated, false);

  const exact = await enrichIncidentFromRepository(input, { repoPath: root, maxCommits: 2 });
  assert.equal(exact.provenance.enrichment.truncated, false);

  const truncated = await enrichIncidentFromRepository(input, { repoPath: root, maxCommits: 1 });
  assert.equal(truncated.provenance.enrichment.truncated, true);
  assert.equal(truncated.provenance.enrichment.matchedBundleCommits, 1);

  const unresolved = await enrichIncidentFromRepository({
    ...input,
    commits: [{ ...input.commits[0], sha: 'ffffffff' }]
  }, { repoPath: root, maxCommits: 10 });
  assert.equal(unresolved.provenance.enrichment.matchedBundleCommits, 0);
  assert.equal(unresolved.provenance.enrichment.unresolvedBundleCommits, 1);
  assert.deepEqual(unresolved.provenance.enrichment.unresolvedBundleShas, ['ffffffff']);

  await assert.rejects(
    enrichIncidentFromRepository({ ...input, incidentStart: '2026-10-20T14:00:00' }, { repoPath: root }),
    /timezone/
  );
});
