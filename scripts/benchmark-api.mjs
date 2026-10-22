import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { createPatchTraceServer } from '../server.mjs';
import { benchmarkBundle } from './benchmark-analysis.mjs';

const app = createPatchTraceServer({ port: 0, token: 'synthetic-benchmark-only' });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;
const headers = { 'x-patchtrace-token': app.token, 'content-type': 'application/json' };
const body = JSON.stringify(benchmarkBundle());
try {
  for (let run = 0; run < 3; run++) {
    const start = performance.now();
    let completed = false;
    const analysis = fetch(`${base}/api/analyze`, { method: 'POST', headers, body }).then(async response => {
      assert.equal(response.status, 200);
      await response.arrayBuffer();
      completed = true;
      return performance.now() - start;
    });
    // Allow the POST to begin, then exercise independent health/control routes.
    await new Promise(resolve => setTimeout(resolve, 50));
    const healthStart = performance.now();
    const health = await fetch(`${base}/api/health`);
    await health.arrayBuffer();
    assert.equal(health.status, 200);
    const healthMs = performance.now() - healthStart;
    const healthBeforeAnalysisFinished = !completed;
    const controlStart = performance.now();
    const control = await fetch(`${base}/api/verify/cancel`, { method: 'POST', headers, body: '{}' });
    await control.arrayBuffer();
    assert.equal(control.status, 409);
    const controlMs = performance.now() - controlStart;
    const analysisMs = await analysis;
    console.log(JSON.stringify({ run, analysisMs, healthMs, controlMs, healthBeforeAnalysisFinished }));
  }
} finally {
  app.cancelAnalysis();
  await new Promise(resolve => app.server.close(resolve));
}
