import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { analyzeIncident } from '../src/core/analysis.mjs';
import { createPatchTraceServer } from '../server.mjs';

const execFileAsync = promisify(execFile);

const fixture = JSON.parse(await readFile(new URL('../fixtures/sample-incident/manifest.json', import.meta.url)));
let app;
let base;
let cookie;

function rawRequest({ port, path = '/', method = 'GET', headers = {} }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path, method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    request.on('error', reject);
    request.end();
  });
}

before(async () => {
  app = createPatchTraceServer({ token: 'test-token', enableRealVerification: false, port: 0 });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
  const home = await fetch(`${base}/`);
  cookie = (home.headers.get('set-cookie') || '').split(';')[0];
});

after(async () => {
  await new Promise((resolve) => app.server.close(resolve));
});

test('rejects unauthenticated API requests', async () => {
  const response = await fetch(`${base}/api/sample`);
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error.code, 'unauthorized');
});

test('serves the sample with a session cookie', async () => {
  assert.match(cookie, /^patchtrace_session=/);
  const response = await fetch(`${base}/api/sample`, { headers: { cookie } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.commits.length, 3);
});

test('rejects cross-origin requests', async () => {
  const response = await fetch(`${base}/api/sample`, {
    headers: { cookie, origin: 'https://evil.example' }
  });
  assert.equal(response.status, 403);
});

test('rejects an unexpected Host header', async () => {
  const response = await rawRequest({
    port: app.server.address().port,
    path: '/api/health',
    headers: { host: 'evil.example' }
  });
  assert.equal(response.status, 403);
});

test('treats a malformed cookie as unauthenticated instead of crashing', async () => {
  const response = await rawRequest({
    port: app.server.address().port,
    path: '/api/sample',
    headers: { cookie: 'patchtrace_session=%' }
  });
  assert.equal(response.status, 401);
});

test('rejects non-JSON content types', async () => {
  const response = await fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'text/plain' },
    body: JSON.stringify(fixture)
  });
  assert.equal(response.status, 415);

  const patchLike = await fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json-patch+json' },
    body: JSON.stringify(fixture)
  });
  assert.equal(patchLike.status, 415);
});

test('rejects invalid JSON and invalid bundles with safe errors', async () => {
  const invalidJson = await fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: '{'
  });
  assert.equal(invalidJson.status, 400);
  assert.equal((await invalidJson.json()).error.code, 'invalid_json');

  const invalidBundle = await fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'missing fields' })
  });
  assert.equal(invalidBundle.status, 400);
  const body = await invalidBundle.json();
  assert.equal(body.error.code, 'invalid_bundle');
  assert.ok(body.error.details.length > 0);
});

test('rejects oversized declared bodies', async () => {
  const response = await rawRequest({
    port: app.server.address().port,
    path: '/api/analyze',
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/json',
      'content-length': String(6 * 1024 * 1024)
    }
  });
  assert.equal(response.status, 413);
});

test('analyzes a valid bundle and serves fixture verification', async () => {
  const analysisResponse = await fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(fixture)
  });
  assert.equal(analysisResponse.status, 200);
  const analysis = await analysisResponse.json();
  assert.equal(analysis.apiVersion, 1);
  assert.equal(analysis.suspects[0].sha, 'a81e7c2');

  const verificationResponse = await fetch(`${base}/api/verify`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ analysis, sha: 'a81e7c2' })
  });
  assert.equal(verificationResponse.status, 200);
  const verification = await verificationResponse.json();
  assert.equal(verification.status, 'complete');
  assert.equal(verification.source, 'fixture');
  assert.equal(verification.candidate.failed, 0);
});

test('fixture verification ignores fabricated client analysis results', async () => {
  const response = await fetch(`${base}/api/verify`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      analysis: {
        verification: {
          a81e7c2: {
            status: 'complete',
            message: 'fabricated result',
            baseline: { failed: 999, passed: 0 },
            candidate: { failed: 999, passed: 0 }
          }
        }
      },
      sha: 'a81e7c2'
    })
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.source, 'fixture');
  assert.equal(result.status, 'complete');
  assert.notEqual(result.message, 'fabricated result');
  assert.equal(result.candidate.failed, 0);
  assert.equal(result.candidate.passed, 43);
});

test('builds a redacted report JSON through the API', async () => {
  const response = await fetch(`${base}/api/report`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      analysis: analyzeIncident(fixture),
      verification: { status: 'complete', message: 'password=hunter2' },
      provenance: { source: 'test', note: 'token=abc123' }
    })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.schemaVersion, 1);
  assert.equal(body.apiVersion, 1);
  assert.equal(body.analysis.suspects[0].sha, 'a81e7c2');
  assert.ok(body.redaction.matches >= 2);
  assert.doesNotMatch(JSON.stringify(body), /hunter2|abc123/);
  assert.match(body.generatedAt, /T.*Z$/);
  assert.match(body.toolVersion, /^\d+\.\d+\.\d+/);

  const invalid = await fetch(`${base}/api/report`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ analysis: { incident: {}, suspects: 'not-an-array' } })
  });
  assert.equal(invalid.status, 400);

  const incomplete = await fetch(`${base}/api/report`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ analysis: { incident: {}, suspects: [], timeline: [] } })
  });
  assert.equal(incomplete.status, 400);
  const incompleteBody = await incomplete.json();
  assert.equal(incompleteBody.error.code, 'invalid_request');
  assert.ok(incompleteBody.error.details.some((detail) => detail.path === 'analysis.schemaVersion'));
});

test('server responses cannot be given a different apiVersion by fixture data', async () => {
  const response = await fetch(`${base}/api/verify`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      analysis: { verification: { abcdef: { status: 'complete', apiVersion: 999 } } },
      sha: 'abcdef'
    })
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).apiVersion, 1);
});

test('real repository verification is disabled by default', async () => {
  const response = await fetch(`${base}/api/verify`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      repoPath: process.cwd(),
      sha: 'a81e7c2',
      testCommand: ['node', '--version'],
      timeoutMs: 5_000
    })
  });
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.error.code, 'verify_disabled');
});

test('maps a missing repository to a safe invalid_repo error', async (t) => {
  const missingRepo = join(tmpdir(), `patchtrace-missing-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const realApp = createPatchTraceServer({ token: 'missing-repo-token', enableRealVerification: true, port: 0 });
  await new Promise((resolve) => realApp.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => realApp.server.close(resolve));
  });
  const response = await fetch(`http://127.0.0.1:${realApp.server.address().port}/api/verify`, {
    method: 'POST',
    headers: { authorization: 'Bearer missing-repo-token', 'content-type': 'application/json' },
    body: JSON.stringify({
      repoPath: missingRepo,
      sha: 'a81e7c2',
      testCommand: ['node', '--version'],
      timeoutMs: 5_000
    })
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, 'invalid_repo');
  assert.equal(body.error.message, 'Repository path could not be found.');
  assert.doesNotMatch(body.error.message, new RegExp(missingRepo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('health is available without a token but still host-checked', async () => {
  const response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.ready, true);
  assert.equal(body.git.available, true);
  assert.equal(body.tempWritable, true);
  assert.equal(body.realVerificationEnabled, false);
});

test('real verification runs through the API when explicitly enabled', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'patchtrace-api-real-'));
  const git = (args) => execFileAsync('git', ['-c', 'user.name=PatchTrace Test', '-c', 'user.email=patchtrace@example.test', ...args], { cwd: root });
  await git(['init', '-q']);
  await writeFile(join(root, 'state.txt'), 'good\n', 'utf8');
  await git(['add', 'state.txt']);
  await git(['commit', '-q', '-m', 'initial']);
  await writeFile(join(root, 'state.txt'), 'bad\n', 'utf8');
  await git(['add', 'state.txt']);
  await git(['commit', '-q', '-m', 'candidate']);
  const sha = (await git(['rev-parse', 'HEAD'])).stdout.trim();

  const realApp = createPatchTraceServer({ token: 'real-token', enableRealVerification: true, port: 0 });
  await new Promise((resolve) => realApp.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => realApp.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const realBase = `http://127.0.0.1:${realApp.server.address().port}`;
  const response = await fetch(`${realBase}/api/verify`, {
    method: 'POST',
    headers: { authorization: 'Bearer real-token', 'content-type': 'application/json' },
    body: JSON.stringify({
      repoPath: root,
      sha,
      testCommand: ['node', '-e', "const fs=require('node:fs'); const v=fs.readFileSync('state.txt','utf8').trim(); process.exit(v === 'good' ? 0 : 1)"],
      timeoutMs: 5_000
    })
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, 'passed');
  assert.equal(result.source, 'live');
  assert.equal(result.outcome, 'confirmed');
  assert.equal(result.sourceUnchanged, true);
  assert.equal((await readFile(join(root, 'state.txt'), 'utf8')).trim(), 'bad');
});

test('cancels an in-flight real verification through the API', async (t) => {
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const cancellationApp = createPatchTraceServer({
    token: 'cancel-token',
    enableRealVerification: true,
    runVerification: async ({ signal }) => {
      markStarted();
      await new Promise((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener('abort', resolve, { once: true });
      });
      return { status: 'cancelled', outcome: 'cancelled', reason: 'cancelled', sourceUnchanged: true };
    }
  });
  await new Promise((resolve) => cancellationApp.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => cancellationApp.server.close(resolve));
  });
  const cancelBase = `http://127.0.0.1:${cancellationApp.server.address().port}`;
  const headers = { authorization: 'Bearer cancel-token', 'content-type': 'application/json' };
  const cancel = () => fetch(`${cancelBase}/api/verify/cancel`, { method: 'POST', headers, body: '{}' });

  const idleCancel = await cancel();
  assert.equal(idleCancel.status, 409);
  assert.equal((await idleCancel.json()).error.code, 'no_verification_in_progress');

  const first = fetch(`${cancelBase}/api/verify`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      repoPath: '/unused',
      sha: 'abcdef',
      testCommand: ['node', '--version'],
      timeoutMs: 1_000
    })
  });
  await started;
  const accepted = await cancel();
  assert.equal(accepted.status, 202);
  assert.equal((await accepted.json()).cancelled, true);

  const result = await first;
  assert.equal(result.status, 200);
  assert.equal((await result.json()).outcome, 'cancelled');
});

test('rejects concurrent real verification runs', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const concurrentApp = createPatchTraceServer({
    token: 'concurrent-token',
    enableRealVerification: true,
    runVerification: async () => {
      calls += 1;
      await gate;
      return { status: 'passed', outcome: 'confirmed' };
    }
  });
  await new Promise((resolve) => concurrentApp.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    release();
    await new Promise((resolve) => concurrentApp.server.close(resolve));
  });
  const url = `http://127.0.0.1:${concurrentApp.server.address().port}/api/verify`;
  const request = () => fetch(url, {
    method: 'POST',
    headers: { authorization: 'Bearer concurrent-token', 'content-type': 'application/json' },
    body: JSON.stringify({
      repoPath: '/unused',
      sha: 'abcdef',
      testCommand: ['node', '--version'],
      timeoutMs: 1000
    })
  });

  const first = request();
  for (let attempt = 0; attempt < 100 && calls === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(calls, 1);
  const second = await request();
  assert.equal(second.status, 409);
  assert.equal((await second.json()).error.code, 'verification_in_progress');

  release();
  const firstResponse = await first;
  assert.equal(firstResponse.status, 200);
});
