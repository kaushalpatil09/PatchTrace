import { readFile } from 'node:fs/promises';
import { evaluateIncidents } from '../src/core/evaluation.mjs';

let cases;
if (process.argv[2]) {
  cases = JSON.parse(await readFile(process.argv[2], 'utf8'));
} else {
  const fixture = JSON.parse(await readFile(new URL('../fixtures/sample-incident/manifest.json', import.meta.url)));
  cases = [
    ['demo', 'development', {}],
    ['no-tests', 'development', { tests: [] }],
    ['no-deployments', 'holdout', { deployments: [] }],
    ['no-file-evidence', 'holdout', { incidentFiles: [] }],
    ['environment-mismatch', 'holdout', { environment: 'staging' }],
    ['post-incident-deployment', 'holdout', { deployments: fixture.deployments.map(d => ({ ...d, timestamp: '2026-10-21T00:00:00Z' })) }]
  ].map(([id, split, overrides]) => ({ id, split, synthetic: true, expectedShas: ['a81e7c2'],
    bundle: { ...fixture, ...overrides } }));
}
console.log(JSON.stringify(evaluateIncidents(cases), null, 2));
