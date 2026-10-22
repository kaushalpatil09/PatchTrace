import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateIncidents } from '../src/core/evaluation.mjs';
import { benchmarkBundle } from '../scripts/benchmark-analysis.mjs';

test('evaluation computes known ranks, holdout metrics, abstention and failure cases', () => {
  const bundle = benchmarkBundle(4, 0, 1);
  const cases = [0, 1, 3].map((index, i) => ({ id: `case-${i}`, split: i ? 'holdout' : 'development',
    synthetic: true, expectedShas: [bundle.commits[index].sha], bundle }));
  const result = evaluateIncidents(cases);
  assert.equal(result.externalValidation, 'OPEN');
  assert.equal(result.all.methods.patchtrace.top1, 1 / 3);
  assert.equal(result.all.methods.patchtrace.top3, 2 / 3);
  assert.equal(result.all.methods.patchtrace.mrr, (1 + 1 / 2 + 1 / 4) / 3);
  assert.equal(result.all.coverage, 0);
  assert.equal(result.all.abstentionRate, 1);
  assert.equal(result.holdout.size, 2);
  assert.equal(result.holdout.methods.deployedCommit.mrr, 0);
  assert.deepEqual(result.failureCases, ['case-1', 'case-2']);
  assert.deepEqual(evaluateIncidents(cases), result);
});

test('evaluation rejects absent labels and duplicate case IDs', () => {
  assert.throws(() => evaluateIncidents([]));
  const item = { id: 'one', split: 'holdout', synthetic: true, expectedShas: ['ffff'], bundle: benchmarkBundle(1, 0, 1) };
  assert.throws(() => evaluateIncidents([item]), /Expected SHAs/);
  item.expectedShas = ['00000000'];
  assert.throws(() => evaluateIncidents([item, item]), /unique id/);
});
