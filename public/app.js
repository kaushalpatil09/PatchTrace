const state = {
  input: null,
  analysis: null,
  selectedSha: null,
  loading: false,
  realVerificationEnabled: false,
  bundleLabel: null,
  bundleSha256: null,
  verification: null,
  verificationInFlight: false,
  activeVerificationSha: null
};

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
}[character]));
const formatDate = (value) => new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  timeZone: 'UTC'
}).format(new Date(value));
const formatClock = (value) => new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'UTC'
}).format(new Date(value));
const percent = (value) => `${Math.round((Number(value) || 0) * 100)}%`;
const rankLabel = (index) => String(index + 1).padStart(2, '0');
const truncate = (value, length = 4000) => {
  const text = String(value ?? '');
  return text.length > length ? `${text.slice(0, length)}\n[truncated]` : text;
};

function setStatus(message, kind = '') {
  const status = $('#status');
  status.textContent = message;
  status.dataset.kind = kind;
  status.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
}

async function responseError(response, fallback) {
  if (response.status === 401) return 'Session expired. Reload the page to start a new local session.';
  try {
    const body = await response.json();
    const details = body?.error?.details;
    const detailText = Array.isArray(details)
      ? details.slice(0, 6).map((detail) => `${detail.path || 'bundle'}: ${detail.message}`).join('; ')
      : '';
    return [body?.error?.message || body?.message || fallback, detailText].filter(Boolean).join(' — ');
  } catch {
    return fallback;
  }
}

async function sha256(text) {
  try {
    const data = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

async function analyzeBundle(bundle, label, text = '') {
  const response = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(bundle)
  });
  if (!response.ok) throw new Error(await responseError(response, 'Analysis failed.'));
  state.input = bundle;
  state.bundleLabel = label;
  state.bundleSha256 = text ? await sha256(text) : null;
  state.analysis = await response.json();
  state.selectedSha = state.analysis.suspects[0]?.sha ?? null;
  resetVerification();
  render();
  $('#workspace')?.focus({ preventScroll: true });
  setStatus(`${label} analyzed. Every ranking signal is inspectable below.`);
}

async function loadSample() {
  if (state.loading) return;
  state.loading = true;
  const button = $('#load-sample');
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  setStatus('Loading deterministic incident fixture…');
  try {
    const response = await fetch('/api/sample');
    if (!response.ok) throw new Error(await responseError(response, 'Could not load sample fixture.'));
    const text = await response.text();
    let bundle;
    try {
      bundle = JSON.parse(text);
    } catch {
      throw new Error('The sample fixture is not valid JSON.');
    }
    await analyzeBundle(bundle, 'Sample incident', text);
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    state.loading = false;
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

async function loadBundleFile(file) {
  if (!file || state.loading) return;
  state.loading = true;
  const button = $('#load-bundle');
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  setStatus(`Reading ${file.name}…`);
  try {
    const text = await file.text();
    let bundle;
    try {
      bundle = JSON.parse(text);
    } catch (error) {
      throw new Error(`Bundle is not valid JSON: ${error.message}`);
    }
    await analyzeBundle(bundle, file.name, text);
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    state.loading = false;
    button.disabled = false;
    button.removeAttribute('aria-busy');
    $('#bundle-file').value = '';
  }
}

function render() {
  const { incident, timeline, suspects, warnings, candidateWindowMinutes, excludedCandidateCount } = state.analysis;
  $('#workspace').classList.remove('hidden');
  $('#workspace').setAttribute('aria-hidden', 'false');
  $('#incident-title').textContent = incident.title;
  $('#incident-summary').textContent = incident.summary || 'No summary provided.';
  $('#environment').textContent = incident.environment;
  $('#download-analysis').disabled = false;
  $('#analysis-meta').textContent = [
    `Window: ${candidateWindowMinutes} minutes`,
    `${excludedCandidateCount} commit${excludedCandidateCount === 1 ? '' : 's'} excluded`,
    `${suspects.length} ranked candidate${suspects.length === 1 ? '' : 's'}`
  ].join(' · ');

  $('#timeline').innerHTML = timeline.map((event) => `
    <div class="timeline-item" role="listitem">
      <div class="timeline-time"><span class="timeline-date">${escapeHtml(formatDate(event.timestamp))}</span><span class="timeline-clock">${escapeHtml(formatClock(event.timestamp))}</span><span class="timeline-zone">UTC</span></div>
      <div class="timeline-node"></div>
      <div class="timeline-content">
        <div class="timeline-title">${escapeHtml(event.title)}</div>
        <div class="timeline-detail">${escapeHtml(event.detail)}</div>
        <div class="timeline-meta">${escapeHtml(event.phase)} · ${escapeHtml(event.source)}</div>
      </div>
    </div>`).join('');

  $('#suspects').innerHTML = suspects.map((suspect, index) => `
    <div role="listitem">
      <button type="button" class="suspect ${suspect.sha === state.selectedSha ? 'selected' : ''}"
        data-sha="${escapeHtml(suspect.sha)}" aria-pressed="${suspect.sha === state.selectedSha}"
        aria-label="Inspect suspect ${escapeHtml(suspect.sha)}: ${escapeHtml(suspect.message)}">
        <span class="rank" aria-hidden="true">${rankLabel(index)}</span>
        <span class="suspect-main">
          <span class="commit-sha">${escapeHtml(suspect.sha)}</span>
          <span class="commit-message">${escapeHtml(suspect.message)}</span>
          <span class="commit-files">${escapeHtml((suspect.changedFiles || []).join(' · '))}</span>
        </span>
        <span class="score">
          <span class="score-value">${Number(suspect.score).toFixed(2)}</span>
          <span class="confidence ${escapeHtml(suspect.confidence)}">${escapeHtml(suspect.confidence)}</span>
          <span class="coverage">${percent(suspect.coverage)} coverage</span>
        </span>
      </button>
    </div>`).join('');

  document.querySelectorAll('.suspect').forEach((element) => {
    element.addEventListener('click', () => {
      state.selectedSha = element.dataset.sha;
      resetVerification();
      render();
      [...document.querySelectorAll('.suspect')]
        .find((candidate) => candidate.dataset.sha === state.selectedSha)
        ?.focus({ preventScroll: true });
      setStatus('Showing evidence for the selected candidate.');
    });
  });

  if (!suspects.length) {
    $('#detail-panel').innerHTML = `
      <div class="eyebrow">NO CANDIDATES</div>
      <h3 id="detail-heading">No candidate commits</h3>
      <p class="muted">No commit fell inside the analysis window. Widen the window or check the incident timestamps.</p>`;
    if (warnings.length) {
      $('#detail-panel').insertAdjacentHTML('beforeend', `
        <div class="warning-list">
          ${warnings.map((warning) => `<div class="warning">${escapeHtml(warning)}</div>`).join('')}
        </div>`);
    }
    return;
  }

  const selected = suspects.find((suspect) => suspect.sha === state.selectedSha) ?? suspects[0];
  renderDetails(selected);
  if (warnings.length) {
    $('#detail-panel').insertAdjacentHTML('beforeend', `
      <div class="warning-list">
        ${warnings.map((warning) => `<div class="warning">${escapeHtml(warning)}</div>`).join('')}
      </div>`);
  }
}

function resetVerification() {
  if (state.verificationInFlight) void requestVerificationCancellation(null, false);
  state.verification = null;
  state.activeVerificationSha = null;
  const panel = $('#verification-panel');
  panel.classList.add('hidden');
  panel.innerHTML = '';
}

async function requestVerificationCancellation(button = null, announce = true) {
  if (button) {
    button.disabled = true;
    button.textContent = 'Cancelling…';
  }
  try {
    const response = await fetch('/api/verify/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    if (!response.ok) throw new Error(await responseError(response, 'Cancellation was not accepted.'));
    if (announce) setStatus('Cancellation requested. Waiting for the process tree and temporary copy to be cleaned up.');
  } catch (error) {
    if (announce) setStatus(error.message || 'Verification could not be cancelled.', 'error');
    if (button) {
      button.disabled = false;
      button.textContent = 'Cancel verification';
    }
  }
}

function renderDetails(suspect) {
  if (!suspect) return;
  const weights = state.analysis.weights || {};
  const factors = [
    ['temporal', 'Temporal'],
    ['fileOverlap', 'Incident-file overlap'],
    ['testOverlap', 'Test overlap'],
    ['diffRisk', 'Diff risk'],
    ['dependencyImpact', 'Dependency impact']
  ];
  const missing = new Set(suspect.missingSignals || []);
  const sources = suspect.signalSources || {};
  const hasFixtureVerification = Boolean(state.analysis.verification?.[suspect.sha]);
  const evidence = Array.isArray(suspect.evidence) ? suspect.evidence : [];
  const whyNot = Array.isArray(suspect.whyNot) ? suspect.whyNot.slice(0, 5) : [];

  $('#detail-panel').innerHTML = `
    <div class="eyebrow">SELECTED CANDIDATE</div>
    <div class="detail-header">
      <div class="commit-sha">${escapeHtml(suspect.sha)}</div>
      <div class="confidence ${escapeHtml(suspect.confidence)}">${escapeHtml(suspect.confidence)} confidence</div>
    </div>
    <h3 id="detail-heading" class="detail-message">${escapeHtml(suspect.message)}</h3>
    <div class="coverage-line">
      <strong>${percent(suspect.coverage)}</strong> evidence coverage
      ${(suspect.missingSignals || []).length
        ? `· missing: ${escapeHtml(suspect.missingSignals.join(', '))}`
        : '· all five signals available'}
    </div>

    <div class="eyebrow">SCORE BREAKDOWN</div>
    <div class="factor-grid">
      ${factors.map(([key, label]) => `
        <div class="factor ${missing.has(key) ? 'factor-missing' : ''}">
          <div class="factor-label">${escapeHtml(label)}</div>
          <div class="factor-value">${percent(suspect.factors[key])}</div>
          <div class="factor-meta">
            ${weights[key] ? `${Math.round(weights[key] * 100)}% weight` : 'derived'}
            · +${Number(suspect.contributions?.[key] || 0).toFixed(3)}
            ${sources[key] === 'provided' ? '· provided' : ''}
            ${missing.has(key) ? '· missing' : ''}
          </div>
        </div>`).join('')}
    </div>

    <div class="eyebrow">EVIDENCE</div>
    <div class="evidence-list">
      ${evidence.map((item) => `
        <div class="evidence">
          <span>${escapeHtml(item.text)} <span class="evidence-source">source ref: ${escapeHtml(item.source || 'unavailable')}</span></span>
          <span class="evidence-origin ${escapeHtml(item.origin)}">${escapeHtml(item.origin)}</span>
        </div>`).join('')}
    </div>

    ${whyNot.length ? `
      <div class="eyebrow">WHY NOT THE TOP SUSPECT</div>
      <div class="warning-list">
        ${whyNot.map((reason) => `<div class="warning">${escapeHtml(reason)}</div>`).join('')}
      </div>` : ''}

    <button id="verify-button" class="verify-button" type="button" ${hasFixtureVerification ? '' : 'disabled'}>
      ${hasFixtureVerification ? 'Run sample verification (fixture)' : 'No fixture verification for this candidate'}
    </button>
    <p class="verify-note">Fixture verification reads deterministic demo data. It does not execute a repository.</p>

    ${state.realVerificationEnabled ? `
      <div class="real-verify-block">
        <div class="eyebrow">REAL REPOSITORY VERIFICATION</div>
         <p class="muted small">The server reports the effective boundary for each run. Trusted-local temp-copy mode is not a sandbox; constrained Docker/Podman mode is required when a stronger boundary is configured and fails closed if it cannot be established.</p>
         <label class="field" for="repo-path">Repository path
           <input id="repo-path" name="repo-path" type="text" placeholder="D:\\path\\to\\repository" autocomplete="off" spellcheck="false">
         </label>
         <label class="field" for="test-command">Test command
           <input id="test-command" name="test-command" type="text" value="npm test" autocomplete="off" spellcheck="false">
         </label>
         <label class="field" for="verify-timeout">Per-run timeout (ms)
           <input id="verify-timeout" name="verify-timeout" type="number" min="1" max="600000" value="30000">
         </label>
        <button id="real-verify-button" class="verify-button secondary" type="button">Run real verification</button>
        <p id="real-verify-error" class="warning hidden" role="alert"></p>
      </div>` : ''}`;

  const verifyButton = $('#verify-button');
  if (verifyButton) verifyButton.addEventListener('click', () => verifyFixture(suspect.sha));
  const realVerifyButton = $('#real-verify-button');
  if (realVerifyButton) realVerifyButton.addEventListener('click', () => verifyReal(suspect.sha));
}

async function verifyFixture(sha) {
  const panel = $('#verification-panel');
  const button = $('#verify-button');
  state.verification = null;
  panel.classList.remove('hidden');
  if (button) {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
  }
  panel.innerHTML = `
    <div class="eyebrow">SAMPLE VERIFICATION</div>
    <h3 id="verification-heading">Reading fixture verification…</h3>
    <p class="muted">The demo compares stored baseline and candidate results. No repository is executed.</p>`;
  try {
    const response = await fetch('/api/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ analysis: state.analysis, sha })
    });
    if (!response.ok) throw new Error(await responseError(response, 'Verification failed.'));
    const result = await response.json();
    if (result.status !== 'complete') throw new Error(result.message || 'Fixture verification is not available for this candidate.');
    renderVerificationResult(result, panel);
  } catch (error) {
    panel.innerHTML = `
      <div class="eyebrow">SAMPLE VERIFICATION UNAVAILABLE</div>
      <p class="warning" role="alert">${escapeHtml(error.message || 'Verification could not be completed.')}</p>`;
  } finally {
    if (button) {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  }
}

function parseClientCommand(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) throw new Error('Test command must not be empty.');
  if (trimmed.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error('Test command JSON must be a valid argv array.');
    }
    if (!Array.isArray(parsed) || !parsed.length
      || parsed.some((part) => typeof part !== 'string' || !part || part.includes('\0'))) {
      throw new Error('Test command JSON must be a non-empty array of strings without empty or null-containing arguments.');
    }
    return parsed;
  }
  const args = [];
  let current = '';
  let tokenStarted = false;
  let quote = null;
  let escaped = false;
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (escaped) {
      current += character;
      tokenStarted = true;
      escaped = false;
      continue;
    }
    if (quote === '"' && character === '\\'
      && (trimmed[index + 1] === '"' || trimmed[index + 1] === '\\')) {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else {
        current += character;
        tokenStarted = true;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (tokenStarted) {
        if (!current) throw new Error('Test command arguments must not be empty.');
        args.push(current);
        current = '';
        tokenStarted = false;
      }
      continue;
    }
    current += character;
    tokenStarted = true;
  }
  if (escaped) {
    current += '\\';
    tokenStarted = true;
  }
  if (quote) throw new Error('Test command has an unterminated quote.');
  if (tokenStarted) {
    if (!current) throw new Error('Test command arguments must not be empty.');
    args.push(current);
  }
  if (!args.length) throw new Error('Test command must not be empty.');
  if (args.some((argument) => argument.includes('\0'))) {
    throw new Error('Test command arguments must not contain null bytes.');
  }
  return args;
}

async function verifyReal(sha) {
  const panel = $('#verification-panel');
  const errorBox = $('#real-verify-error');
  const button = $('#real-verify-button');
  const requestId = (state.verificationRequestId || 0) + 1;
  state.verificationRequestId = requestId;
  state.activeVerificationSha = sha;
  state.verification = null;
  let elapsedTimer;
  try {
    errorBox.classList.add('hidden');
    const repoPath = $('#repo-path').value.trim();
    if (!repoPath) throw new Error('Repository path is required.');
    const testCommand = parseClientCommand($('#test-command').value);
    const timeoutMs = Number($('#verify-timeout').value);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) {
      throw new Error('Timeout must be an integer between 1 and 600000 ms.');
    }
    if (state.activeVerificationSha !== sha) return;

    panel.classList.remove('hidden');
    if (button) {
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
    }
    state.verificationInFlight = true;
    const startedAt = Date.now();
    panel.innerHTML = `
      <div class="eyebrow">REAL VERIFICATION</div>
      <h3 id="verification-heading">Copying and testing…</h3>
      <p class="muted">The source repository is not used as the command working directory. The temporary copy is removed when the run finishes.</p>
      <p id="verification-elapsed" class="muted small" aria-live="off">Elapsed: 0s</p>
      <button id="cancel-verification" class="verify-button secondary" type="button">Cancel verification</button>`;
    elapsedTimer = setInterval(() => {
      const elapsed = $('#verification-elapsed');
      if (elapsed) elapsed.textContent = `Elapsed: ${Math.floor((Date.now() - startedAt) / 1000)}s`;
    }, 1_000);
    $('#cancel-verification')?.addEventListener('click', (event) => {
      void requestVerificationCancellation(event.currentTarget);
    });
    const response = await fetch('/api/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoPath, sha, testCommand, timeoutMs })
    });
    if (!response.ok) throw new Error(await responseError(response, 'Verification failed.'));
    const result = await response.json();
    if (state.verificationRequestId === requestId && state.activeVerificationSha === sha) {
      renderVerificationResult(result, panel);
    }
  } catch (error) {
    if (state.verificationRequestId === requestId && state.activeVerificationSha === sha) {
      if (errorBox) {
        errorBox.textContent = error.message || 'Verification could not be started.';
        errorBox.classList.remove('hidden');
      }
      panel.innerHTML = `
        <div class="eyebrow">REAL VERIFICATION UNAVAILABLE</div>
        <p class="warning" role="alert">${escapeHtml(error.message || 'Verification could not be started.')}</p>`;
    }
  } finally {
    clearInterval(elapsedTimer);
    if (state.verificationRequestId === requestId) {
      state.verificationInFlight = false;
      state.activeVerificationSha = null;
    }
    if (button) {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  }
}

function outputBlock(command) {
  if (!command) return '';
  const parts = [];
  if (command.stdout?.trim()) parts.push(`stdout:\n${truncate(command.stdout.trim())}`);
  if (command.stderr?.trim()) parts.push(`stderr:\n${truncate(command.stderr.trim())}`);
  if (!parts.length) return '';
  return `<details class="output-details"><summary>Command output</summary><pre>${escapeHtml(parts.join('\n\n'))}</pre></details>`;
}

function renderVerificationResult(result, panel) {
  state.verification = result;
  const fixture = result.status === 'complete';
  const cancelled = result.status === 'cancelled' || result.outcome === 'cancelled';
  const outcome = fixture ? 'fixture complete' : (result.outcome || result.status || 'unknown');
  const isolation = result.isolation || (fixture ? 'fixture' : 'unknown');
  const isolationBoundary = result.isolationBoundary || (fixture ? 'server-owned-fixture' : 'not-established');
  const isolationNotice = result.isolationNotice
    || (fixture
      ? 'server-owned fixture data; no repository or test command was executed.'
      : result.isolation === 'container'
        ? (result.status === 'unsupported'
          ? 'constrained Docker/Podman mode was requested but not established; production/container mode fails closed and never falls back to temp-copy.'
          : 'constrained Docker/Podman container; networking is disabled and the source is mounted read-only.')
        : result.isolation === 'temp-copy'
          ? 'trusted-local temporary copy; best-effort boundary only, not a security sandbox.'
          : 'No live verification boundary was established.');
  const positive = fixture || result.outcome === 'confirmed';
  const baseline = result.baseline;
  const candidate = result.candidate;
  const baselineRuns = Array.isArray(result.baselineRuns) ? result.baselineRuns.length : 0;
  const statusText = (command) => command
    ? `${escapeHtml(command.status)}${command.exitCode !== null && command.exitCode !== undefined ? ` (exit ${escapeHtml(command.exitCode)})` : ''}`
    : 'not run';
  const failing = (command) => command && command.failed !== undefined ? `${Number(command.failed)} failing` : '—';

  panel.innerHTML = `
    <div class="eyebrow">${fixture ? 'SAMPLE VERIFICATION COMPLETE' : cancelled ? 'REAL VERIFICATION CANCELLED' : 'REAL VERIFICATION COMPLETE'}</div>
    <h3 id="verification-heading">${cancelled ? 'Verification cancelled' : positive ? 'Rollback hypothesis supported' : 'Rollback hypothesis not confirmed'}</h3>
    <p class="muted">${escapeHtml(result.message || (cancelled ? 'The run was cancelled and its temporary copy was cleaned up.' : ''))}</p>
    <div class="verify-result">
      <div class="result-card">
        <div class="eyebrow">BASELINE${baselineRuns > 1 ? ` (${baselineRuns} RUNS)` : ''}</div>
        <strong>${failing(baseline)}</strong>
        <span class="muted">${escapeHtml(baseline?.label || statusText(baseline))}</span>
      </div>
      <div class="result-card ${positive ? 'good' : cancelled ? '' : 'bad'}">
        <div class="eyebrow">CANDIDATE REVERT</div>
        <strong>${failing(candidate)}</strong>
        <span class="muted">${escapeHtml(candidate?.label || statusText(candidate))}</span>
      </div>
    </div>
    <div class="verify-meta">
      <span>Outcome: ${escapeHtml(outcome)}</span>
      <span>Mode: ${escapeHtml(isolation)} · boundary: ${escapeHtml(isolationBoundary)}</span>
      ${result.reason ? `<span>Reason: ${escapeHtml(result.reason)}</span>` : ''}
      ${Array.isArray(result.baselineRuns) && result.baselineRuns.length > 1 ? `<span>Baseline runs: ${escapeHtml(result.baselineRuns.map((run) => run.status).join(' → '))}</span>` : ''}
      ${result.revert ? `<span>Revert: ${escapeHtml(result.revert.status)}</span>` : ''}
      ${result.sourceUnchanged !== undefined ? `<span>Source unchanged: ${result.sourceUnchanged ? 'yes' : 'no'}</span>` : ''}
      ${result.durationMs !== undefined && result.durationMs !== null ? `<span>Duration: ${Math.round(Number(result.durationMs) / 1000)}s</span>` : ''}
    </div>
    ${result.sourceUnchanged === false ? '<p class="warning" role="alert">The source repository changed during verification. This result cannot be trusted.</p>' : ''}
    ${result.cleanup?.removed === false && !result.cleanup.skipped ? `<p class="warning" role="alert">Temporary workspace cleanup failed: ${escapeHtml(result.cleanup.error || 'unknown error')}</p>` : ''}
    ${outputBlock(baseline)}${outputBlock(candidate)}
    <p class="verify-note">${escapeHtml(fixture
      ? 'This is fixture evidence, not a live test run and not proof of root cause.'
      : `Isolation boundary: ${isolationNotice} This check supports or weakens the rollback hypothesis; it does not prove root cause.`)}</p>`;
  panel.focus({ preventScroll: true });
}

$('#load-sample').addEventListener('click', loadSample);
$('#load-bundle').addEventListener('click', () => $('#bundle-file').click());
$('#bundle-file').addEventListener('change', (event) => loadBundleFile(event.target.files?.[0]));
$('#download-analysis').addEventListener('click', downloadAnalysis);

async function downloadAnalysis() {
  if (!state.analysis) return;
  const button = $('#download-analysis');
  if (button.disabled) return;
  const analysis = state.analysis;
  const verification = state.verification;
  const provenance = {
    source: state.bundleLabel || 'local bundle',
    platform: 'browser',
    bundleSha256: state.bundleSha256
  };
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = 'Building...';
  try {
    const response = await fetch('/api/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ analysis, verification, provenance })
    });
    if (!response.ok) throw new Error(await responseError(response, 'Could not build the report.'));
    const body = await response.json();
    delete body.apiVersion;
    const blob = new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const slug = analysis.incident.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'analysis';
    const link = document.createElement('a');
    link.href = url;
    link.download = `patchtrace-${slug}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    const matches = Number(body.redaction?.matches) || 0;
    setStatus(matches
      ? `Report downloaded. ${matches} likely secret${matches === 1 ? '' : 's'} replaced. Review before sharing; unknown secrets may remain.`
      : 'Report downloaded. Best-effort redaction ran. Review before sharing; unknown secrets may remain.');
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

fetch('/api/health')
  .then((response) => response.ok ? response.json() : null)
  .then((health) => {
    state.realVerificationEnabled = Boolean(health?.realVerificationEnabled && (health?.ready ?? true));
    if (state.realVerificationEnabled && state.analysis) render();
  })
  .catch(() => {});
