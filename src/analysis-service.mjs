import { Worker } from 'node:worker_threads';

export function analyzeInWorker(input, { signal, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const fail = (code, message) => Object.assign(new Error(message), { code });
    if (signal?.aborted) return reject(fail('analysis_cancelled', 'Analysis was cancelled.'));
    const worker = new Worker(new URL('./analysis-worker.mjs', import.meta.url), {
      workerData: input, resourceLimits: { maxOldGenerationSizeMb: 128 }
    });
    let settled = false;
    const finish = async (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      await worker.terminate();
      if (error) reject(error); else resolve(result);
    };
    const abort = () => void finish(fail('analysis_cancelled', 'Analysis was cancelled.'));
    const timer = setTimeout(() => void finish(fail('analysis_timeout', 'Analysis exceeded the 5 second worker budget. Narrow the bundle.')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', ({ result, error }) => void finish(error ? fail(error.code, error.message) : null,
      error ? undefined : JSON.parse(result)));
    worker.once('error', () => void finish(fail('analysis_failed', 'Analysis worker failed or exceeded its memory budget.')));
    worker.once('exit', () => {
      if (!settled) void finish(fail('analysis_failed', 'Analysis worker exited without a result.'));
    });
  });
}
