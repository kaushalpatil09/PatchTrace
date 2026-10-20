import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['server.mjs'], {
  env: { ...process.env, PORT: '0' },
  stdio: ['ignore', 'pipe', 'pipe']
});

let stdout = '';
const timeout = setTimeout(() => {
  child.kill('SIGTERM');
  console.error('smoke timeout');
  process.exit(1);
}, 10_000);

function waitForServer() {
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/PatchTrace listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) resolve(Number(match[1]));
    });
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (!stdout.includes('PatchTrace listening')) {
        reject(new Error(`server exited before listening (code ${code})`));
      }
    });
  });
}

try {
  const port = await waitForServer();
  const base = `http://127.0.0.1:${port}`;

  const home = await fetch(`${base}/`);
  if (!home.ok) throw new Error(`home returned ${home.status}`);
  const cookie = (home.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie.startsWith('patchtrace_session=')) throw new Error('missing session cookie');

  const unauthorized = await fetch(`${base}/api/sample`);
  if (unauthorized.status !== 401) throw new Error(`unauthenticated sample returned ${unauthorized.status}`);

  const sample = await fetch(`${base}/api/sample`, { headers: { cookie } });
  const fixture = await sample.json();
  if (!sample.ok || fixture.commits.length !== 3) {
    throw new Error(`unexpected sample response: home=${home.status} sample=${sample.status}`);
  }

  const plainText = await fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'text/plain' },
    body: JSON.stringify(fixture)
  });
  if (plainText.status !== 415) throw new Error(`text/plain analyze returned ${plainText.status}`);

  const analysisResponse = await fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(fixture)
  });
  const analysis = await analysisResponse.json();
  if (!analysisResponse.ok || analysis.suspects[0]?.sha !== 'a81e7c2') {
    throw new Error(`unexpected analysis response: ${analysisResponse.status}`);
  }

  const verificationResponse = await fetch(`${base}/api/verify`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ analysis, sha: 'a81e7c2' })
  });
  const verification = await verificationResponse.json();
  if (!verificationResponse.ok || verification.status !== 'complete') {
    throw new Error(`unexpected verification response: ${verificationResponse.status}`);
  }

  const reportResponse = await fetch(`${base}/api/report`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      analysis,
      verification,
      provenance: { source: 'smoke', note: 'token=smoke-secret' }
    })
  });
  const report = await reportResponse.json();
  if (!reportResponse.ok || report.schemaVersion !== 1 || report.redaction?.matches < 1
    || JSON.stringify(report).includes('smoke-secret')) {
    throw new Error(`unexpected report response: ${reportResponse.status}`);
  }

  console.log('smoke ok: auth, sample API, analysis, fixture verification, and redacted report export are available');
} finally {
  clearTimeout(timeout);
  child.kill('SIGTERM');
}
