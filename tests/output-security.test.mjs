import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyzeIncident } from '../src/core/analysis.mjs';
import { buildReport, renderMarkdown, renderCsv } from '../src/core/report.mjs';
import { redactAndScrubDeep, redactSecrets } from '../src/core/redaction.mjs';

const fixture = JSON.parse(await readFile(new URL('../fixtures/sample-incident/manifest.json', import.meta.url)));

test('Markdown fields cannot introduce images, links, HTML, fences or block structure', () => {
  const payload = '![pixel](https://attacker.example/pixel) [link](https://attacker.example) <img src=x> ` ```\r\n# heading\r- item\n| cell | \\![escape](x)';
  const analysis = analyzeIncident(fixture);
  analysis.incident.title = payload;
  analysis.incident.summary = payload;
  analysis.incident.environment = payload;
  analysis.warnings = [payload];
  analysis.timeline[0] = Object.fromEntries(Object.keys(analysis.timeline[0]).map(key => [key, payload]));
  analysis.suspects[0].message = payload;
  analysis.suspects[0].sha = payload;
  analysis.suspects[0].evidence = [{ text: payload, source: payload, origin: payload }];
  analysis.suspects[0].whyNot = [payload];
  const markdown = renderMarkdown(buildReport({ analysis,
    verification: { message: payload, testCommand: [payload] },
    provenance: { note: payload }, generatedAt: '2026-10-22T00:00:00Z' }));
  // Provenance is deliberately literal JSON in a dynamically sized code fence.
  const body = markdown.split('## Provenance')[0];
  assert.doesNotMatch(body, /!\[pixel\]|\[link\]\(|<img|\n# heading|\r/);
  assert.doesNotMatch(body, /```/);
  assert.ok(body.includes('attacker.example'));
});

test('compound secret fields and assignments redact recursively with diagnostic false positives preserved', () => {
  const names = ['secretKey', 'apiSecretKey', 'my_api_secret_key', 'STRIPE_SECRET_KEY',
    'client-secret-key', 'accessToken', 'customCredential', 'connectionString', 'privateKey'];
  for (const name of names) {
    const canary = 'CANARY-DO-NOT-LEAK-012345';
    const result = redactAndScrubDeep({ nested: [{ [name]: canary }], details: `${name}=${canary}` });
    assert.ok(!JSON.stringify(result.value).includes(canary), name);
    assert.ok(result.redactions >= 2, name);
  }
  const ordinary = { secretariat: 'diagnostic', tokenCount: 4, keyboard: 'input', key: 'src/main.js' };
  assert.deepEqual(redactAndScrubDeep(ordinary).value, ordinary);
});

test('secret canaries are absent from JSON, Markdown, CSV and verification report outputs', () => {
  const analysis = analyzeIncident(fixture);
  const secret = 'CANARY-EXPORT-0123456789';
  analysis.suspects[0].message = `API_SECRET_KEY=${secret}`;
  analysis.timeline[0].detail = `CLIENT_SECRET_KEY=${secret}`;
  const report = buildReport({ analysis, verification: { message: `STRIPE_SECRET_KEY=${secret}` },
    provenance: { apiSecretKey: secret } });
  for (const output of [JSON.stringify(report), renderMarkdown(report), renderCsv(analysis),
    redactSecrets(`API_SECRET_KEY=${secret}`).text]) assert.ok(!output.includes(secret));
});

test('standalone Markdown fields cannot introduce lists, rules, headings or indentation', () => {
  for (const payload of ['- item', '+ item', '= heading', '1. item', '    indented', '\tindented', '# heading', '---']) {
    const analysis = analyzeIncident(fixture);
    analysis.incident.summary = payload;
    const markdown = renderMarkdown(buildReport({ analysis }));
    assert.ok(!markdown.includes(`\n${payload}\n`), payload);
  }
});

test('CSV formulas behind invisible and direction controls receive an apostrophe', () => {
  for (const prefix of ['', ' ', '\t', '\r', '\u200b', '\u202e', '\ufeff']) {
    const analysis = analyzeIncident(fixture);
    analysis.suspects[0].message = `${prefix}=1+1`;
    assert.ok(renderCsv(analysis).includes(`'${prefix}=1+1`));
  }
});

test('provider credentials, JWT, bearer, connection URLs and private keys redact in plain text', () => {
  const secrets = [
    'ghp_abcdefghijklmnopqrstuvwxyz123456',
    'github_pat_abcdefghijklmnopqrstuvwxyz123456',
    'AKIA1234567890ABCDEF',
    'xoxb-1234567890123456',
    ['sk', 'live', 'abcdefghijklmnopqrstuvwxyz'].join('_'),
    'eyJabcdefghijk.abcdefghijklmnop.abcdefghijklmnop',
    'Bearer abcdefghijklmnop',
    'postgres://user:canary-password@localhost/database',
    '-----BEGIN PRIVATE KEY-----\ncanary-private-key\n-----END PRIVATE KEY-----'
  ];
  for (const secret of secrets) {
    const result = redactSecrets(secret);
    assert.ok(result.redactions > 0);
    assert.notEqual(result.text, secret);
    assert.ok(!result.text.includes('canary-'));
  }
  assert.equal(redactSecrets('tokenCount=4 secretariat=diagnostic src/main.js').redactions, 0);
});
