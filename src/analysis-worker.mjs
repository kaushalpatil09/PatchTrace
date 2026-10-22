import { parentPort, workerData } from 'node:worker_threads';
import { analyzeIncident } from './core/analysis.mjs';

try {
  const result = JSON.stringify(analyzeIncident(workerData));
  if (Buffer.byteLength(result) > 16 * 1024 * 1024) {
    const error = new Error('Analysis output exceeds the 16 MiB budget. Narrow the bundle.');
    error.code = 'analysis_limit';
    throw error;
  }
  parentPort.postMessage({ result });
} catch (error) {
  parentPort.postMessage({ error: { code: error.code ?? 'analysis_failed',
    message: error.code === 'analysis_limit' ? error.message : 'Analysis could not be completed.' } });
}
