import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { analyzeIncident, validateIncident } from '../src/core/analysis.mjs';
import { buildReport, renderCsv, renderMarkdown } from '../src/core/report.mjs';

function limitBundle() {
  const incidentStart = '2026-10-20T14:00:00Z';
  const commits = Array.from({ length: 2_000 }, (_, index) => ({
    sha: index.toString(16).padStart(8, '0'),
    timestamp: new Date(Date.parse(incidentStart) - (index + 1) * 60_000).toISOString(),
    message: `Change ${index}`,
    changedFiles: [`src/file-${index % 200}.js`, `tests/test-${index % 200}.test.js`],
    diffRisk: 0.5,
    dependencyImpact: 0.25
  }));
  return {
    schemaVersion: 1,
    title: 'Limit bundle',
    summary: 'Synthetic bundle at the documented collection limits.',
    environment: 'production',
    incidentStart,
    incidentEnd: '2026-10-20T14:15:00Z',
    candidateWindowMinutes: 3_000,
    incidentFiles: Array.from({ length: 200 }, (_, index) => `src/file-${index}.js`),
    commits,
    deployments: commits.map((commit) => ({
      commitSha: commit.sha,
      timestamp: new Date(Date.parse(incidentStart) - 30_000).toISOString(),
      environment: 'production'
    })),
    tests: Array.from({ length: 5_000 }, (_, index) => ({
      name: `limit test ${index}`,
      status: index % 2 === 0 ? 'passed' : 'failed',
      timestamp: '2026-10-20T14:10:00Z',
      relatedFiles: [`src/file-${index % 200}.js`],
      errorSignature: index % 2 === 0 ? undefined : 'synthetic failure'
    }))
  };
}

test('handles documented bundle collection limits without pathological runtime', () => {
  const bundle = limitBundle();
  const validation = validateIncident(bundle);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));

  const analysisStart = performance.now();
  const analysis = analyzeIncident(bundle);
  const analysisDuration = performance.now() - analysisStart;

  assert.equal(analysis.timeline.length, 6_500);
  assert.equal(analysis.suspects.length, 2_000);
  assert.ok(analysisDuration < 10_000, `analysis took ${Math.round(analysisDuration)} ms`);

  const report = buildReport({
    analysis,
    provenance: { bundleSha256: 'synthetic' },
    generatedAt: '2026-10-20T00:00:00Z'
  });
  const renderStart = performance.now();
  const markdown = renderMarkdown(report);
  const csv = renderCsv(analysis);
  const renderDuration = performance.now() - renderStart;

  assert.ok(markdown.includes('## Timeline'));
  assert.ok(markdown.includes('Limit bundle'));
  assert.ok(csv.startsWith('rank,sha,message'));
  assert.equal(csv.trim().split('\n').length, 2_001);
  assert.ok(renderDuration < 10_000, `report rendering took ${Math.round(renderDuration)} ms`);
});
