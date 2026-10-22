import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  analyzeIncident,
  assertValidIncident,
  buildTimeline,
  deriveDependencyImpact,
  parseDeploymentCsv,
  parseJunitXml,
  validateIncident
} from '../src/core/analysis.mjs';

const fixture = JSON.parse(await readFile(new URL('../fixtures/sample-incident/manifest.json', import.meta.url)));

test('rejects permissively parsed non-ISO dates, calendar rollover and invalid offsets without echoing input', () => {
  for (const value of ['API_SECRET_KEY=CANARY-ERROR-01234Z', 'Oct 20 2026 14:00:00Z',
    '2026-02-30T14:00:00Z', '2025-02-29T14:00:00Z', '2026-10-20T24:00:00Z',
    '2026-10-20T14:00:00+24:00', '2026-10-20T14:00:00+05:60']) {
    const result = validateIncident({ ...fixture, incidentStart: value });
    assert.equal(result.valid, false, value);
    assert.ok(!JSON.stringify(result.errors).includes('CANARY-ERROR'));
  }
  assert.equal(validateIncident({ ...fixture, incidentStart: '2024-02-29T14:00:00+05:30' }).valid, true);
});

test('does not give temporal credit to a deployment after the incident', () => {
  const input = {
    ...fixture,
    deployments: [{ commitSha: 'a81e7c2', timestamp: '2026-10-20T15:00:00Z', environment: 'production' }]
  };
  const suspect = analyzeIncident(input).suspects[0];
  assert.equal(suspect.factors.temporal, 0);
  assert.ok(suspect.evidence.some((item) => item.kind === 'post-incident-deployment'));
});

test('ignores deployments from another environment', () => {
  const input = {
    ...fixture,
    deployments: [{ commitSha: 'a81e7c2', timestamp: '2026-10-20T14:00:00Z', environment: 'staging' }]
  };
  const suspect = analyzeIncident(input).suspects[0];
  assert.equal(suspect.factors.temporal, 0);
  assert.ok(suspect.evidence.some((item) => item.kind === 'missing-deployment' && /production/.test(item.text)));
});

test('supports deployment commit lists and case-insensitive SHAs', () => {
  const input = {
    ...fixture,
    deployments: [{ commitShas: ['12FA0B1'], timestamp: '2026-10-20T12:00:00Z', environment: 'production' }]
  };
  const suspect = analyzeIncident(input).suspects.find((item) => item.sha === '12fa0b1');
  assert.ok(suspect.factors.temporal > 0);
  assert.ok(suspect.evidence.some((item) => item.kind === 'deployment'));
});

test('matches abbreviated and full deployment SHAs in either direction', () => {
  const shortSha = 'a81e7c2';
  const fullSha = `${shortSha}${'0'.repeat(33)}`;
  const shortCandidate = analyzeIncident({
    ...fixture,
    deployments: [{ commitSha: fullSha, timestamp: '2026-10-20T14:00:00Z', environment: 'production' }]
  }).suspects.find((suspect) => suspect.sha === shortSha);
  assert.ok(shortCandidate.factors.temporal > 0);

  const fullCandidate = analyzeIncident({
    ...fixture,
    commits: fixture.commits.map((commit) => commit.sha === shortSha ? { ...commit, sha: fullSha } : commit),
    deployments: [{ commitSha: shortSha, timestamp: '2026-10-20T14:00:00Z', environment: 'production' }]
  }).suspects.find((suspect) => suspect.sha === fullSha);
  assert.ok(fullCandidate.factors.temporal > 0);
});

test('ignores ambiguous deployment SHA prefixes instead of guessing', () => {
  const firstSha = `abcd${'1'.repeat(36)}`;
  const secondSha = `abcd${'2'.repeat(36)}`;
  const input = {
    ...fixture,
    commits: [
      { ...fixture.commits[0], sha: firstSha },
      { ...fixture.commits[1], sha: secondSha }
    ],
    deployments: [{ commitSha: 'ABCD', timestamp: '2026-10-20T14:00:00Z', environment: 'production' }]
  };

  const analysis = analyzeIncident(input);
  assert.equal(analysis.suspects.length, 2);
  for (const suspect of analysis.suspects) {
    assert.equal(suspect.factors.temporal, 0);
    assert.ok(suspect.evidence.some((item) => item.kind === 'missing-deployment'));
  }

  const shortCandidate = analyzeIncident({
    ...fixture,
    commits: [{ ...fixture.commits[0], sha: 'abcd' }],
    deployments: [
      { commitSha: firstSha, timestamp: '2026-10-20T13:59:00Z', environment: 'production' },
      { commitSha: secondSha, timestamp: '2026-10-20T14:00:00Z', environment: 'production' }
    ]
  }).suspects[0];
  assert.equal(shortCandidate.factors.temporal, 0);
  assert.ok(shortCandidate.evidence.some((item) => item.kind === 'missing-deployment'));
});

test('excludes commits outside the candidate window', () => {
  const input = {
    ...fixture,
    commits: [
      ...fixture.commits,
      {
        sha: 'fffffff',
        timestamp: '2026-10-20T14:30:00Z',
        message: 'Post-incident follow-up',
        changedFiles: ['src/tax.ts'],
        diffRisk: 1,
        dependencyImpact: 1
      }
    ]
  };
  const analysis = analyzeIncident(input);
  assert.equal(analysis.suspects.some((suspect) => suspect.sha === 'fffffff'), false);
  assert.equal(analysis.excludedCandidateCount, 1);
});

test('keeps incident-file overlap separate from test overlap', () => {
  const suspect = analyzeIncident(fixture).suspects[0];
  assert.equal(suspect.factors.fileOverlap, 0.5);
  assert.equal(suspect.factors.testOverlap, 1);
  assert.equal(suspect.contributions.fileOverlap, 0.125);
});

test('marks overlap signals missing when a candidate has no changedFiles evidence', () => {
  const input = structuredClone(fixture);
  delete input.commits[0].changedFiles;

  const suspect = analyzeIncident(input).suspects.find((item) => item.sha === input.commits[0].sha);
  assert.equal(suspect.signalAvailability.fileOverlap, false);
  assert.equal(suspect.signalAvailability.testOverlap, false);
  assert.ok(suspect.missingSignals.includes('fileOverlap'));
  assert.ok(suspect.missingSignals.includes('testOverlap'));
  assert.equal(suspect.signalSources.fileOverlap, 'missing');
  assert.equal(suspect.signalSources.testOverlap, 'missing');

  const fileEvidence = suspect.evidence.find((item) => item.kind === 'missing-file-overlap');
  const testEvidence = suspect.evidence.find((item) => item.kind === 'missing-test-overlap');
  assert.equal(fileEvidence.origin, 'missing');
  assert.match(fileEvidence.text, /changedFiles/);
  assert.equal(testEvidence.origin, 'missing');
  assert.match(testEvidence.text, /changedFiles/);
});

test('does not claim test-overlap availability when a failing test lacks relatedFiles', () => {
  const input = structuredClone(fixture);
  delete input.tests.find((test) => test.status === 'failed').relatedFiles;

  const suspect = analyzeIncident(input).suspects.find((item) => item.sha === 'a81e7c2');
  assert.equal(suspect.signalAvailability.fileOverlap, true);
  assert.equal(suspect.signalAvailability.testOverlap, false);
  assert.equal(suspect.missingSignals.includes('fileOverlap'), false);
  assert.ok(suspect.missingSignals.includes('testOverlap'));
  assert.equal(suspect.signalSources.fileOverlap, 'derived');
  assert.equal(suspect.signalSources.testOverlap, 'missing');

  const fileEvidence = suspect.evidence.find((item) => item.kind === 'file-overlap');
  const testEvidence = suspect.evidence.find((item) => item.kind === 'missing-test-overlap');
  assert.equal(fileEvidence.origin, 'derived');
  assert.equal(testEvidence.origin, 'missing');
  assert.match(testEvidence.text, /relatedFiles/);
});

test('treats explicit empty changedFiles and relatedFiles arrays as observed no-overlap', () => {
  const input = structuredClone(fixture);
  input.commits = [{ ...input.commits[0], changedFiles: [] }];
  input.tests = [{
    name: 'untagged failure',
    status: 'failed',
    timestamp: '2026-10-20T14:10:00Z',
    relatedFiles: [],
    errorSignature: 'failure with no related files'
  }];

  const suspect = analyzeIncident(input).suspects[0];
  assert.equal(suspect.signalAvailability.fileOverlap, true);
  assert.equal(suspect.signalAvailability.testOverlap, true);
  assert.equal(suspect.factors.fileOverlap, 0);
  assert.equal(suspect.factors.testOverlap, 0);
  assert.equal(suspect.missingSignals.includes('fileOverlap'), false);
  assert.equal(suspect.missingSignals.includes('testOverlap'), false);
  assert.equal(suspect.signalSources.fileOverlap, 'derived');
  assert.equal(suspect.signalSources.testOverlap, 'derived');
  assert.equal(suspect.signalDetails.fileOverlap.state, 'observed_no_overlap');
  assert.equal(suspect.signalDetails.testOverlap.state, 'observed_no_overlap');

  const fileEvidence = suspect.evidence.find((item) => item.kind === 'no-file-overlap');
  const testEvidence = suspect.evidence.find((item) => item.kind === 'no-test-overlap');
  assert.equal(fileEvidence.origin, 'derived');
  assert.match(fileEvidence.text, /No changed-file overlap/);
  assert.equal(testEvidence.origin, 'derived');
  assert.match(testEvidence.text, /No failing test/);
});

test('reports coverage, missing signals, contributions, and provided sources', () => {
  const suspect = analyzeIncident(fixture).suspects[0];
  assert.equal(suspect.coverage, 1);
  assert.deepEqual(suspect.missingSignals, []);
  assert.equal(suspect.signalSources.diffRisk, 'provided');
  assert.equal(suspect.signalSources.dependencyImpact, 'provided');
  assert.equal(suspect.confidence, 'high');
  assert.equal(suspect.contributions.temporal, 0.3 * suspect.factors.temporal);
});

test('derives dependency impact across common ecosystems with inspectable evidence', () => {
  const changedFiles = [
    'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
    'requirements-dev.txt', 'pyproject.toml', 'poetry.lock',
    'go.mod', 'go.sum', 'Cargo.toml', 'Cargo.lock',
    'Gemfile', 'Gemfile.lock', 'pom.xml', 'build.gradle', 'gradle.lockfile'
  ];
  const diffStats = changedFiles.map((path, index) => ({
    path,
    additions: index + 1,
    deletions: index % 2,
    changedLines: index + 1 + (index % 2)
  }));
  const derived = deriveDependencyImpact({ changedFiles, diffStats });

  assert.equal(derived.available, true);
  assert.equal(derived.source, 'derived:dependency-files');
  assert.ok(derived.value > 0 && derived.value <= 1);
  assert.deepEqual(derived.details.ecosystems, ['node', 'python', 'go', 'rust', 'ruby', 'maven', 'gradle']);
  assert.equal(derived.details.dependencyFileCount, changedFiles.length);
  assert.ok(derived.details.dependencyDiffLines > 0);
  assert.match(derived.details.formula, /manifestSignal/);

  const input = structuredClone(fixture);
  const candidate = input.commits[0];
  delete candidate.dependencyImpact;
  candidate.changedFiles = ['package.json', 'package-lock.json'];
  candidate.diffStats = [
    { path: 'package.json', additions: 2, deletions: 1 },
    { path: 'package-lock.json', additions: 4, deletions: 2 }
  ];
  const suspect = analyzeIncident(input).suspects.find((item) => item.sha === candidate.sha);
  assert.equal(suspect.signalSources.dependencyImpact, 'derived');
  assert.ok(suspect.factors.dependencyImpact > 0);
  assert.equal(suspect.dependencyImpactDetails.dependencyFileCount, 2);
  assert.ok(suspect.evidence.some((item) => item.kind === 'dependency-impact'
    && item.origin === 'derived'
    && /changed dependency files/.test(item.text)
    && item.details.dependencyFiles.includes('package.json')));
});

test('keeps explicitly supplied dependency impact distinct from derivation', () => {
  const input = structuredClone(fixture);
  const candidate = input.commits[0];
  candidate.dependencyImpact = 0.17;
  delete candidate.dependencyImpactSource;
  candidate.changedFiles = ['package.json', 'package-lock.json'];
  candidate.diffStats = [{ path: 'package.json', additions: 200, deletions: 10 }];

  const suspect = analyzeIncident(input).suspects.find((item) => item.sha === candidate.sha);
  assert.equal(suspect.factors.dependencyImpact, 0.17);
  assert.equal(suspect.signalSources.dependencyImpact, 'provided');
  assert.equal(suspect.evidence.find((item) => item.kind === 'dependency-impact').origin, 'provided');
});

test('adds deterministic why-not reasons relative to the top suspect', () => {
  const analysis = analyzeIncident(fixture);
  const [top, second, third] = analysis.suspects;

  assert.deepEqual(top.whyNot, []);
  assert.ok(second.whyNot.some((reason) => /weaker file-overlap evidence/i.test(reason)));
  assert.ok(second.whyNot.some((reason) => /weaker test-overlap evidence/i.test(reason)));
  assert.ok(third.whyNot.some((reason) => /missing temporal evidence/i.test(reason)));
  assert.ok(analysis.suspects.every((suspect) => suspect.whyNot.length <= 5));
  assert.doesNotMatch(analysis.suspects.flatMap((suspect) => suspect.whyNot).join(' '), /probability|likely|chance/i);

  const single = analyzeIncident({ ...fixture, commits: [fixture.commits[0]] });
  assert.equal(single.suspects.length, 1);
  assert.deepEqual(single.suspects[0].whyNot, []);

  const empty = analyzeIncident({ ...fixture, commits: [] });
  assert.deepEqual(empty.suspects, []);
});

test('returns a warning instead of a suspect when no commits are in range', () => {
  const analysis = analyzeIncident({ ...fixture, commits: [] });
  assert.equal(analysis.suspects.length, 0);
  assert.equal(analysis.warnings.length, 1);
});

test('rejects timestamps without a timezone', () => {
  const input = {
    ...fixture,
    commits: [{ ...fixture.commits[0], timestamp: '2026-10-20T13:55:00' }]
  };
  assert.throws(() => analyzeIncident(input), /timezone/);
});

test('validates bundle shape and reports field paths', () => {
  const result = validateIncident({ title: 'only a title', commits: 'nope' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.path === 'commits'));
  assert.throws(() => assertValidIncident({}), /Invalid incident bundle/);
});

test('parses self-closing, skipped, quoted, namespaced, and entity-encoded JUnit cases', () => {
  const xml = `
    <testsuite xmlns:j="urn:test">
      <testcase name="passes &amp; stays passing" file="src/a.ts"/>
      <testcase name='skipped test'><skipped/></testcase>
      <testcase name="fails"><failure message='bad &lt;value&gt;'/></testcase>
      <j:testcase name="namespaced" file="src/b.ts"/>
    </testsuite>`;
  const results = parseJunitXml(xml);
  assert.deepEqual(results.map((result) => result.status), ['passed', 'skipped', 'failed', 'passed']);
  assert.equal(results[0].name, 'passes & stays passing');
  assert.equal(results[2].errorSignature, 'bad <value>');
});

test('does not fabricate timeline events for failed tests without timestamps', () => {
  const input = {
    incidentStart: '2026-10-20T14:00:00Z',
    commits: [],
    deployments: [],
    tests: [
      { name: 'untimed failure', status: 'failed', relatedFiles: [] },
      { name: 'timed failure', status: 'failed', timestamp: '2026-10-20T14:10:00Z', relatedFiles: [] }
    ],
    incidentEvents: []
  };
  const timeline = buildTimeline(input);

  assert.equal(timeline.some((event) => event.title === 'untimed failure failed'), false);
  assert.equal(timeline.some((event) => event.title === 'timed failure failed'), true);
  assert.ok(timeline.every((event) => typeof event.timestamp === 'string'));

  const analysis = analyzeIncident({
    ...fixture,
    tests: input.tests
  });
  assert.ok(analysis.warnings.some((warning) => /lack a source timestamp.*not placed on the timeline.*no timestamp was inferred/i.test(warning)));
});

test('rejects malformed JUnit XML', () => {
  assert.throws(() => parseJunitXml('<testcase name="unterminated"'), /unterminated/i);
  assert.throws(() => parseJunitXml('<testcase name="x">'), /missing <\/testcase>/);
  assert.throws(() => parseJunitXml('<testcase name="x"><testcase name="y"/></testcase>'), /nested/);
  assert.throws(() => parseJunitXml('<testsuite><testcase name="x"></testsuite></testcase>'), /mismatched/i);
});

test('bounds JUnit input, tag count, and nesting depth', () => {
  assert.throws(() => parseJunitXml('x'.repeat(1_000_001)), /exceeds|limit/i);
  assert.throws(() => parseJunitXml(Array.from({ length: 10_001 }, () => '<testcase name="x"/>').join('')), /tag limit/i);
  assert.throws(() => parseJunitXml(`${'<testsuite>'.repeat(257)}<testcase name="x"/>${'</testsuite>'.repeat(256)}`), /depth|missing|mismatched/i);
});

test('parses BOM, CRLF, quoted commas, and single-row CSV data', () => {
  const csv = '\uFEFFcommitSha,timestamp,environment\r\na81e7c2,2026-10-20T14:00:00Z,"production,eu"\r\n';
  assert.deepEqual(parseDeploymentCsv(csv), [{
    commitSha: 'a81e7c2',
    timestamp: '2026-10-20T14:00:00Z',
    environment: 'production,eu'
  }]);
});

test('rejects deployment CSV without required headers or timezone', () => {
  assert.throws(() => parseDeploymentCsv('sha,environment\na,production'), /required header/);
  assert.throws(() => parseDeploymentCsv('commitSha,timestamp\na81e7c2,2026-10-20T14:00:00'), /timezone/);
  assert.throws(() => parseDeploymentCsv('commitSha,timestamp\nnot-a-sha,2026-10-20T14:00:00Z'), /hexadecimal/);
  assert.throws(() => parseDeploymentCsv('commitSha,timestamp\na81e7c2,2026-10-20T14:00:00Z\nbad"quote,2026-10-20T14:00:00Z'), /quote inside/);
});

test('rejects invalid SHAs, reversed incident windows, duplicate commits, and bad verification containers', () => {
  const invalidSha = validateIncident({
    ...fixture,
    commits: [{ ...fixture.commits[0], sha: 'not-a-sha' }]
  });
  assert.equal(invalidSha.valid, false);
  assert.ok(invalidSha.errors.some((error) => error.path === 'commits[0].sha'));

  const reversed = validateIncident({ ...fixture, incidentEnd: '2026-10-20T13:00:00Z' });
  assert.equal(reversed.valid, false);
  assert.ok(reversed.errors.some((error) => error.path === 'incidentEnd' && /after incidentStart/.test(error.message)));

  const duplicate = validateIncident({ ...fixture, commits: [fixture.commits[0], fixture.commits[0]] });
  assert.equal(duplicate.valid, false);
  assert.ok(duplicate.errors.some((error) => /Duplicate commit SHA/.test(error.message)));

  const badVerification = validateIncident({ ...fixture, verification: [] });
  assert.equal(badVerification.valid, false);
  assert.ok(badVerification.errors.some((error) => error.path === 'verification'));

  const badVerificationKey = validateIncident({ ...fixture, verification: { HEAD: {} } });
  assert.equal(badVerificationKey.valid, false);
  assert.ok(badVerificationKey.errors.some((error) => /Verification key/.test(error.message)));

  const badVerificationValue = validateIncident({ ...fixture, verification: { 'a81e7c2': 'yes' } });
  assert.equal(badVerificationValue.valid, false);
  assert.ok(badVerificationValue.errors.some((error) => /Verification fixture/.test(error.message)));

  const badEvent = validateIncident({
    ...fixture,
    incidentEvents: [{ kind: 'note', title: 'note', timestamp: '2026-10-20T14:00:00Z', commitSha: 'HEAD' }]
  });
  assert.equal(badEvent.valid, false);
  assert.ok(badEvent.errors.some((error) => error.path === 'incidentEvents[0].commitSha'));
});

test('treats derived risk signals as derived evidence and normalizes duplicate incident paths', () => {
  const input = structuredClone(fixture);
  input.incidentFiles = ['src/tax.ts', 'src\\tax.ts'];
  input.commits = input.commits.map((commit) => commit.sha === 'a81e7c2'
    ? { ...commit, diffRiskSource: 'derived:git', dependencyImpactSource: 'derived:package-graph' }
    : commit);
  const suspect = analyzeIncident(input).suspects[0];
  assert.equal(suspect.factors.fileOverlap, 1);
  assert.equal(suspect.signalSources.diffRisk, 'derived');
  assert.equal(suspect.signalSources.dependencyImpact, 'derived');
  assert.ok(suspect.evidence.some((item) => item.kind === 'diff-risk' && item.origin === 'derived'));
  assert.ok(suspect.evidence.some((item) => item.kind === 'dependency-impact' && item.origin === 'derived'));
});

test('does not throw on out-of-range XML character references', () => {
  const results = parseJunitXml('<testcase name="x"><failure message="&#x110000;"/></testcase>');
  assert.equal(results[0].status, 'failed');
  assert.match(results[0].errorSignature, /110000/);
});

test('rejects oversized bundle collections before scoring', () => {
  const commits = Array.from({ length: 2001 }, (_, index) => ({
    ...fixture.commits[0],
    sha: index.toString(16).padStart(7, '0')
  }));
  const validation = validateIncident({ ...fixture, commits });
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.path === 'commits' && /at most/.test(error.message)));
});
