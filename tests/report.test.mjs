import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyzeIncident } from '../src/core/analysis.mjs';
import { buildReport, renderCsv, renderMarkdown } from '../src/core/report.mjs';

const fixture = JSON.parse(await readFile(new URL('../fixtures/sample-incident/manifest.json', import.meta.url)));
const analysis = analyzeIncident(fixture);

test('builds a versioned report with analysis, verification, and provenance', () => {
  const report = buildReport({
    analysis,
    verification: { status: 'complete', outcome: 'confirmed', sourceUnchanged: true },
    provenance: { bundleSha256: 'abc123', repository: { head: 'deadbeef', branch: 'main', dirty: false } },
    generatedAt: '2026-10-20T00:00:00Z',
    toolVersion: '0.1.0'
  });
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.generatedAt, '2026-10-20T00:00:00Z');
  assert.equal(report.analysis.suspects[0].sha, 'a81e7c2');
  assert.deepEqual(report.analysis.suspects[1].whyNot, analysis.suspects[1].whyNot);
  assert.equal(report.analysis.suspects[0].evidence[0].source, 'deployment:a81e7c2');
});

test('renders an inspectable Markdown report with caveats and evidence', () => {
  const report = buildReport({
    analysis,
    provenance: { bundleSha256: 'abc123' },
    generatedAt: '2026-10-20T00:00:00Z'
  });
  const markdown = renderMarkdown(report);
  assert.match(markdown, /# PatchTrace analysis/);
  assert.match(markdown, /a81e7c2/);
  assert.match(markdown, /evidence, not a root-cause proof/);
  assert.match(markdown, /Deployed 9 minutes before/);
  assert.match(markdown, /## Timeline/);
  assert.match(markdown, /2026-10-20T11:30:00Z/);
  assert.match(markdown, /Commit 12fa0b1 recorded/);
  assert.match(markdown, /source: `deployment:a81e7c2`/);
  assert.match(markdown, /Why this ranks below the top suspect/);
  assert.match(markdown, /weaker file-overlap evidence/i);
  assert.match(markdown, /## Uncertainty and limits/);
  assert.match(markdown, /not a root-cause proof/);
  assert.match(markdown, /Bundle SHA-256/);
});

test('redacts likely secrets from report JSON without mutating the analysis', () => {
  const modified = structuredClone(analysis);
  modified.suspects[0].message = 'password=hunter2';
  modified.timeline[0].detail = 'token=abc123';
  const report = buildReport({
    analysis: modified,
    verification: { status: 'complete', message: 'Authorization: Bearer abcdefghijklmnop' },
    provenance: { note: 'https://user:secret@example.test/path' },
    generatedAt: '2026-10-20T00:00:00Z'
  });

  const json = JSON.stringify(report);
  assert.doesNotMatch(json, /hunter2|abc123|abcdefghijklmnop|user:secret/);
  assert.ok(report.redaction.matches >= 3);
  assert.equal(report.redaction.applied, true);
  assert.equal(modified.suspects[0].message, 'password=hunter2');
  assert.match(renderMarkdown(report), /Redaction: \d+ likely secret/);
});

test('redacts nested values under sensitive object keys', () => {
  const modified = structuredClone(analysis);
  modified.metadata = {
    nested: {
      password: 'nested-password-value',
      token: 'nested-token-value',
      secret: 'nested-secret-value',
      apiKey: 'nested-api-key-value',
      authorization: 'nested-authorization-value'
    }
  };
  const report = buildReport({
    analysis: modified,
    verification: { details: { nested: { password: 'verification-password-value' } } },
    provenance: { metadata: { secret: 'provenance-secret-value' } },
    generatedAt: '2026-10-20T00:00:00Z'
  });

  const json = JSON.stringify(report);
  assert.doesNotMatch(json, /nested-password-value|nested-token-value|nested-secret-value|nested-api-key-value|nested-authorization-value|verification-password-value|provenance-secret-value/);
  assert.equal(report.analysis.metadata.nested.password, '[redacted]');
  assert.equal(report.analysis.metadata.nested.token, '[redacted]');
  assert.equal(report.analysis.metadata.nested.secret, '[redacted]');
  assert.equal(report.analysis.metadata.nested.apiKey, '[redacted]');
  assert.equal(report.analysis.metadata.nested.authorization, '[redacted]');
  assert.ok(report.redaction.matches >= 7);
});

test('renders CSV and escapes commas and quotes', () => {
  const modified = structuredClone(analysis);
  modified.suspects[0].message = 'a message, with "quotes"';
  const csv = renderCsv(modified);
  assert.match(csv, /^rank,sha,message/);
  assert.match(csv, /"a message, with ""quotes"""/);
  assert.match(csv, /high/);
});

test('escapes HTML and formula-like cells in reports', () => {
  const modified = structuredClone(analysis);
  modified.incident.title = '<b>title</b>';
  modified.incident.environment = '<i>production</i>';
  modified.suspects[0].message = '=1+1';
  modified.suspects[0].evidence[0].source = '<source-ref>';
  modified.suspects[1].whyNot = ['<b>unsafe why-not</b>'];
  const markdown = renderMarkdown(buildReport({
    analysis: modified,
    provenance: {
      bundleSha256: '<sha>',
      repository: { head: 'deadbeef', branch: 'main```<script>alert(1)</script>', dirty: false },
      note: 'Authorization: Bearer abcdefghijklmnop'
    },
    generatedAt: '2026-10-20T00:00:00Z'
  }));
  assert.doesNotMatch(markdown, /<b>/);
  assert.doesNotMatch(markdown, /<script>/i);
  assert.doesNotMatch(markdown, /abcdefghijklmnop/);
  assert.match(markdown, /&lt;b&gt;title/);
  assert.match(markdown, /&lt;i&gt;production/);
  assert.match(markdown, /````json/);
  assert.match(markdown, /\[redacted\]/);
  assert.doesNotMatch(markdown, /<source-ref>|<b>unsafe why-not<\/b>/i);
  assert.match(markdown, /&lt;source-ref&gt;/);
  assert.match(markdown, /&lt;b&gt;unsafe why-not/);

  const csv = renderCsv(modified);
  assert.ok(csv.includes("'=1+1"));
  assert.ok(!csv.includes('\n=1+1'));

  modified.suspects[0].message = ' =1+1';
  assert.ok(renderCsv(modified).includes("' =1+1"));

  modified.suspects[0].message = 'password=hunter2';
  assert.doesNotMatch(renderCsv(modified), /hunter2/);
});
