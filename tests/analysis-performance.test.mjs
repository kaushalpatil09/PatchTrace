import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { analyzeIncident, scoreCommit } from '../src/core/analysis.mjs';
import { analyzeInWorker } from '../src/analysis-service.mjs';
import { benchmarkBundle } from '../scripts/benchmark-analysis.mjs';

const sample = JSON.parse(await readFile(new URL('../fixtures/sample-incident/manifest.json', import.meta.url)));

test('sparse corpus output matches hashes captured from the pre-index baseline', () => {
  for (const [shape, expected] of [
    [[10, 20, 2, false], 'ce292f38515f1f23c52f1b326a2d953649ca8443d1cd53cc5225e04b94639649'],
    [[100, 500, 5, false], 'a294378a7ac27408e5931cb486870a5564f9993f0f6df97b310e17b6f794fb66']
  ]) {
    const actual = createHash('sha256').update(JSON.stringify(analyzeIncident(benchmarkBundle(...shape)))).digest('hex');
    assert.equal(actual, expected);
  }
});

test('indexed overlap preserves per-test identity, order, duplicates and slash matching', () => {
  const input = benchmarkBundle(2, 0, 2);
  input.commits[0].changedFiles = ['src\\a.js', 'src/b.js', 'src/b.js'];
  input.tests = [
    { name: 'same', status: 'failed', relatedFiles: ['src/b.js', 'src/a.js'] },
    { name: 'unrelated', status: 'failed', relatedFiles: [] },
    { name: 'same', status: 'failed', relatedFiles: ['src/a.js'] },
    { name: 'pass', status: 'passed', relatedFiles: ['src/a.js'] }
  ];
  const suspect = analyzeIncident(input).suspects.find(item => item.sha === input.commits[0].sha);
  assert.equal(suspect.factors.testOverlap, 2 / 3);
  assert.deepEqual(suspect.signalDetails.testOverlap.relatedTests, ['same', 'same']);
  assert.deepEqual(suspect.evidence, scoreCommit(input.commits[0], input).evidence);
});

test('rejects combinatorial overlap and total path references before scoring', () => {
  assert.throws(() => analyzeIncident(benchmarkBundle(600, 2000, 50)), { code: 'analysis_limit' });
  assert.throws(() => analyzeIncident(benchmarkBundle(1, 100, 2500)), { code: 'analysis_limit' });
});

test('dense evidence details are bounded without changing full-count scoring', () => {
  const input = benchmarkBundle(2, 100, 50);
  const result = analyzeIncident(input);
  for (const suspect of result.suspects) {
    assert.equal(suspect.factors.testOverlap, 1);
    assert.equal(suspect.relatedTestCount, 100);
    assert.equal(suspect.relatedTestsTruncated, true);
    assert.equal(suspect.relatedTests.length, 20);
    assert.equal(suspect.signalDetails.testOverlap.relatedTests.length, 20);
    assert.match(suspect.evidence.find(item => item.kind === 'test-overlap').text, /80 more; details truncated/);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 100_000);
});

test('worker returns byte-equivalent analysis and enforces timeout and cancellation', async () => {
  assert.deepEqual(await analyzeInWorker(sample), analyzeIncident(sample));
  await assert.rejects(analyzeInWorker(sample, { timeoutMs: 1 }), { code: 'analysis_timeout' });
  const controller = new AbortController();
  const pending = analyzeInWorker(benchmarkBundle(), { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'analysis_cancelled' });
  await assert.rejects(analyzeInWorker(sample, { signal: controller.signal }), { code: 'analysis_cancelled' });
  await assert.rejects(analyzeInWorker(benchmarkBundle(600, 2000, 50)), { code: 'analysis_limit' });
});

test('worker rejects amplified output beyond its serialized result budget', async () => {
  const input = benchmarkBundle(1, 1, 1);
  input.tests[0].name = 'n'.repeat(4 * 1024 * 1024);
  await assert.rejects(analyzeInWorker(input), { code: 'analysis_limit' });
});
