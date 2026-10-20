import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyzeIncident, parseDeploymentCsv, parseJunitXml, verifyFixture } from '../src/core/analysis.mjs';

const fixture = JSON.parse(await readFile(new URL('../fixtures/sample-incident/manifest.json', import.meta.url)));

test('ranks the deployed VAT regression first with inspectable evidence', () => {
  const analysis = analyzeIncident(fixture);
  assert.equal(analysis.suspects[0].sha, 'a81e7c2');
  assert.equal(analysis.suspects[0].confidence, 'high');
  assert.match(analysis.suspects[0].evidence.map((item) => item.text).join(' '), /VAT-07/);
  assert.equal(analysis.timeline[0].kind, 'commit');
  assert.equal(analysis.timeline.at(-1).kind, 'incident');
});

test('does not manufacture high confidence without deployment or overlap evidence', () => {
  const sparse = {
    ...fixture,
    incidentFiles: ['src/unknown.ts'],
    deployments: [],
    tests: [],
    commits: [{ ...fixture.commits[0], diffRisk: 0.1, dependencyImpact: 0 }]
  };
  const analysis = analyzeIncident(sparse);
  assert.equal(analysis.suspects[0].confidence, 'low');
  assert.equal(analysis.warnings.length, 1);
});

test('parses deployment CSV into normalized deployment records', () => {
  const deployments = parseDeploymentCsv('commitSha,timestamp,environment\na81e7c2,2026-10-20T14:00:00Z,production');
  assert.deepEqual(deployments, [{ commitSha: 'a81e7c2', timestamp: '2026-10-20T14:00:00Z', environment: 'production' }]);
});

test('parses JUnit failures and passes', () => {
  const results = parseJunitXml('<testsuite><testcase name="VAT-07" file="src/tax.ts"><failure message="bad tax"/></testcase><testcase name="OK" file="src/checkout.ts"></testcase></testsuite>');
  assert.deepEqual(results.map((result) => result.status), ['failed', 'passed']);
  assert.equal(results[0].errorSignature, 'bad tax');
});

test('returns fixture verification without mutating analysis input', () => {
  const analysis = analyzeIncident(fixture);
  const before = JSON.stringify(analysis);
  const result = verifyFixture(analysis, 'a81e7c2');
  assert.equal(result.candidate.failed, 0);
  assert.equal(JSON.stringify(analysis), before);
});
