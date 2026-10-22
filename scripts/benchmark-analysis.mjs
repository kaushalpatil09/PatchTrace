import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { analyzeIncident } from '../src/core/analysis.mjs';

export function benchmarkBundle(commits = 400, tests = 2000, paths = 50, dense = true) {
  const files = (offset) => Array.from({ length: paths }, (_, i) => `src/file-${dense ? i : (offset + i) % 10000}.js`);
  return {
    schemaVersion: 1, title: 'Synthetic performance corpus', environment: 'production',
    incidentStart: '2026-10-22T12:00:00Z', incidentFiles: ['src/file-0.js'],
    commits: Array.from({ length: commits }, (_, i) => ({ sha: i.toString(16).padStart(8, '0'),
      timestamp: '2026-10-22T11:00:00Z', message: `Synthetic change ${i}`, changedFiles: files(i * paths) })),
    tests: Array.from({ length: tests }, (_, i) => ({ name: `synthetic test ${i}`, status: 'failed',
      relatedFiles: files(i * paths) }))
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify({ node: process.version, platform: process.platform, cpu: cpus()[0]?.model }));
  for (const [name, c, t, p, dense] of [
    ['small', 10, 20, 2, false], ['typical', 100, 500, 5, false],
    ['large', 400, 2000, 50, false], ['dense', 400, 2000, 50, true]
  ]) {
    const input = benchmarkBundle(c, t, p, dense);
    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    await new Promise(resolve => setTimeout(resolve, 20));
    const times = [];
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      const result = analyzeIncident(input);
      times.push(performance.now() - start);
      if (result.suspects.length !== c) throw new Error('Unexpected candidate count');
    }
    await new Promise(resolve => setTimeout(resolve, 20));
    delay.disable();
    times.sort((a, b) => a - b);
    console.log(JSON.stringify({ name, commits: c, tests: t, paths: p,
      bytes: Buffer.byteLength(JSON.stringify(input)), medianMs: times[1], maxMs: times[2],
      maxEventLoopDelayMs: delay.max / 1e6, rssBytes: process.memoryUsage().rss }));
  }
}
