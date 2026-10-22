import { redactAndScrubDeep, redactSecrets, scrubPathText } from './redaction.mjs';

const DEFAULT_TOOL_VERSION = '0.1.0';

function redacted(value) {
  const secret = redactSecrets(value);
  return scrubPathText(secret.text).text;
}

function md(value) {
  return redacted(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    // Entities render as literal punctuation without being reparsed as Markdown.
    // Encode backslashes too, so they cannot undo the encoding of adjacent text.
    .replace(/[\\`*_[\]{}()!#|~]/g, (character) => `&#${character.codePointAt(0)};`)
    .replace(/:\/\//g, '&#58;//')
    .replace(/[\r\n\u2028\u2029]+/g, '<br>')
    .replace(/^(\s*)([-+=]|\d+\.)/, (_, whitespace, marker) => whitespace
      + [...marker].map(character => `&#${character.codePointAt(0)};`).join(''))
    .replace(/^[ \t]+/, whitespace => [...whitespace].map(character => `&#${character.codePointAt(0)};`).join(''));
}

function csv(value) {
  let text = redacted(value);
  if (/^[\s\u200b-\u200f\u202a-\u202e\u2060-\u206f]*[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function jsonFence(value) {
  const json = (JSON.stringify(redactAndScrubDeep(value).value, null, 2) ?? 'null')
    .replaceAll('&', '\\u0026')
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e');
  const longestRun = [...json.matchAll(/`+/g)].reduce((longest, match) => Math.max(longest, match[0].length), 0);
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return [`${fence}json`, json, fence].join('\n');
}

function percent(value) {
  return `${Math.round((Number(value) || 0) * 100)}%`;
}

function evidenceLines(suspect) {
  return (suspect.evidence ?? []).map((item) => {
    const origin = item.origin ? `origin: ${md(item.origin)}` : 'origin: unspecified';
    const source = item.source ? `source: ${md(item.source)}` : 'source: unavailable';
    return `- ${md(item.text)} _(${origin}; ${source})_`;
  }).join('\n');
}

function whyNotLines(suspect) {
  const reasons = Array.isArray(suspect.whyNot) ? suspect.whyNot : [];
  if (!reasons.length) return '';
  return [
    'Why this ranks below the top suspect:',
    ...reasons.slice(0, 5).map((reason) => `- ${md(reason)}`)
  ].join('\n');
}

export function buildReport({
  analysis,
  verification = null,
  provenance = {},
  generatedAt = new Date().toISOString(),
  toolVersion = DEFAULT_TOOL_VERSION
}) {
  if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis)) {
    throw new Error('analysis is required to build a report.');
  }
  const safeAnalysis = redactAndScrubDeep(analysis);
  const safeVerification = verification === null || verification === undefined ? null : redactAndScrubDeep(verification);
  const safeProvenance = redactAndScrubDeep(provenance);
  const safeGeneratedAt = redactAndScrubDeep(generatedAt);
  const safeToolVersion = redactAndScrubDeep(toolVersion);
  return {
    schemaVersion: 1,
    generatedAt: safeGeneratedAt.value,
    toolVersion: safeToolVersion.value,
    analysis: safeAnalysis.value,
    verification: safeVerification?.value ?? null,
    provenance: safeProvenance.value,
    redaction: {
      applied: true,
      policy: 'Best-effort secret and path processing ran; review before sharing. Unknown secrets may remain.',
      matches: safeAnalysis.redactions
        + (safeVerification?.redactions ?? 0)
        + safeProvenance.redactions
        + safeGeneratedAt.redactions
        + safeToolVersion.redactions,
      pathsScrubbed: safeAnalysis.pathScrubs
        + (safeVerification?.pathScrubs ?? 0)
        + safeProvenance.pathScrubs
        + safeGeneratedAt.pathScrubs
        + safeToolVersion.pathScrubs
    }
  };
}

export function renderMarkdown(report) {
  if (!report?.analysis) throw new Error('A report with analysis is required.');
  const { analysis, verification, provenance = {}, generatedAt, toolVersion, redaction } = report;
  const { incident, suspects, warnings = [], candidateWindowMinutes, excludedCandidateCount } = analysis;
  const repository = provenance.repository;
  const lines = [];

  lines.push(`# PatchTrace analysis: ${md(incident.title)}`, '');
  lines.push('> This report ranks changes for investigation. It is evidence, not a root-cause proof.');
  lines.push('');
  lines.push(`- Generated: ${md(generatedAt)}`);
  lines.push(`- Tool: patchtrace ${md(toolVersion)}`);
  if (redaction?.matches) {
    lines.push(`- Redaction: ${md(redaction.matches)} likely secret${redaction.matches === 1 ? '' : 's'} replaced`);
  }
  if (redaction?.pathsScrubbed) {
    lines.push(`- Path scrubbing: ${md(redaction.pathsScrubbed)} absolute or home-directory path${redaction.pathsScrubbed === 1 ? '' : 's'} replaced`);
  }
  lines.push(`- Incident start: ${md(incident.incidentStart)}`);
  lines.push(`- Environment: ${md(incident.environment)}`);
  lines.push(`- Candidate window: ${md(candidateWindowMinutes)} minutes (${md(excludedCandidateCount)} commits excluded)`);
  if (repository) {
    lines.push(`- Repository: ${md(repository.branch || 'detached')} at ${md(repository.head)} (${repository.dirty ? 'dirty' : 'clean'})`);
  }
  if (provenance.bundleSha256) lines.push(`- Bundle SHA-256: ${md(provenance.bundleSha256)}`);
  if (verification) {
    lines.push(`- Verification: ${md(verification.outcome || verification.status || 'recorded')}`);
  }
  lines.push('');

  if (incident.summary) {
    lines.push('## Incident', '', md(incident.summary), '');
  }

  const timeline = Array.isArray(analysis.timeline) ? analysis.timeline : [];
  if (timeline.length) {
    lines.push('## Timeline', '');
    lines.push('| UTC | Phase | Kind | Event | Detail | Reference | Source |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const event of timeline) {
      lines.push(`| ${md(event.timestamp)} | ${md(event.phase)} | ${md(event.kind)} | ${md(event.title)} | ${md(event.detail)} | ${event.commitSha ? md(event.commitSha) : '—'} | ${md(event.source)} |`);
    }
    lines.push('');
  }

  if (warnings.length) {
    lines.push('## Warnings', '');
    for (const warning of warnings) lines.push(`- ${md(warning)}`);
    lines.push('');
  }

  lines.push('## Ranked suspects', '');
  lines.push('| Rank | Commit | Confidence | Score | Coverage | Message |');
  lines.push('| ---: | --- | --- | ---: | ---: | --- |');
  if (!suspects.length) {
    lines.push('| — | — | — | — | — | No candidate commits |');
  } else {
    suspects.forEach((suspect, index) => {
      lines.push(`| ${index + 1} | ${md(suspect.sha)} | ${md(suspect.confidence)} | ${suspect.score.toFixed(3)} | ${percent(suspect.coverage)} | ${md(suspect.message)} |`);
    });
  }
  lines.push('');

  for (const [index, suspect] of suspects.entries()) {
    lines.push(`### ${index + 1}. ${md(suspect.sha)} — ${md(suspect.message)}`, '');
    lines.push(`Score **${suspect.score.toFixed(3)}** · ${md(suspect.confidence)} confidence · ${percent(suspect.coverage)} evidence coverage.`);
    lines.push('');
    lines.push('| Signal | Value | Contribution | Source |');
    lines.push('| --- | ---: | ---: | --- |');
    for (const key of ['temporal', 'fileOverlap', 'testOverlap', 'diffRisk', 'dependencyImpact']) {
      lines.push(`| ${key} | ${percent(suspect.factors?.[key])} | +${Number(suspect.contributions?.[key] || 0).toFixed(3)} | ${md(suspect.signalSources?.[key] || 'derived')} |`);
    }
    lines.push('');
    if (suspect.missingSignals?.length) {
      lines.push(`Missing signals: ${suspect.missingSignals.map((signal) => md(signal)).join(', ')}`, '');
    }
    lines.push(evidenceLines(suspect) || '- No evidence recorded.', '');
    const whyNot = whyNotLines(suspect);
    if (whyNot) lines.push(whyNot, '');
  }

  if (verification) {
    lines.push('## Verification', '');
    lines.push(`- Status: ${md(verification.status || 'unknown')}`);
    lines.push(`- Outcome: ${md(verification.outcome || 'unknown')}`);
    if (verification.reason) lines.push(`- Reason: ${md(verification.reason)}`);
    if (verification.message) lines.push(`- Message: ${md(verification.message)}`);
    if (verification.sourceUnchanged !== undefined) {
      lines.push(`- Source unchanged: ${verification.sourceUnchanged ? 'yes' : 'no'}`);
    }
    if (Array.isArray(verification.testCommand) && verification.testCommand.length) {
      lines.push(`- Test command: ${md(verification.testCommand.join(' '))}`);
    }
    if (verification.baseline) {
      const runCount = Array.isArray(verification.baselineRuns) ? verification.baselineRuns.length : 1;
      lines.push(`- Baseline: ${md(verification.baseline.status)} (${md(verification.baseline.failed ?? 'n/a')} failing; ${runCount} run${runCount === 1 ? '' : 's'})`);
    }
    if (verification.revert) lines.push(`- Revert: ${md(verification.revert.status)}`);
    if (verification.candidate) {
      lines.push(`- Candidate revert: ${md(verification.candidate.status)} (${md(verification.candidate.failed ?? 'n/a')} failing)`);
    }
    if (verification.durationMs !== undefined && verification.durationMs !== null) {
      lines.push(`- Duration: ${md(verification.durationMs)} ms`);
    }
    if (verification.cleanup) {
      lines.push(verification.cleanup.removed
        ? '- Temporary workspace: removed'
        : `- Temporary workspace: not removed${verification.cleanup.skipped ? ' (no workspace created)' : ''}`);
    }
    lines.push('');
  }

  lines.push('## Uncertainty and limits', '');
  lines.push('- Scores rank hypotheses from supplied evidence; they are not a root-cause proof.');
  lines.push('- High-confidence candidates still require human review and, when safe, rollback verification.');
  const missing = [...new Set(suspects.flatMap((suspect) => suspect.missingSignals ?? []))];
  if (missing.length) {
    lines.push(`- Missing signals across candidates: ${missing.slice(0, 20).map((signal) => md(signal)).join(', ')}${missing.length > 20 ? ` and ${missing.length - 20} more` : ''}.`);
  } else {
    lines.push('- No missing signal metadata was recorded; absence is not proof that the evidence is complete.');
  }
  if (verification) {
    lines.push(verification.outcome === 'confirmed'
      ? '- Verification supports the rollback hypothesis in the temporary copy; it does not prove the production root cause.'
      : '- Verification did not confirm the rollback hypothesis; treat the ranking as unverified.');
  }
  lines.push('');

  lines.push('## Provenance', '');
  lines.push(jsonFence(provenance), '');

  return `${lines.join('\n')}\n`;
}

export function renderCsv(analysis) {
  if (!analysis?.suspects) throw new Error('analysis.suspects is required.');
  const headers = [
    'rank', 'sha', 'message', 'score', 'confidence', 'coverage',
    'temporal', 'fileOverlap', 'testOverlap', 'diffRisk', 'dependencyImpact', 'missingSignals'
  ];
  const rows = analysis.suspects.map((suspect, index) => [
    index + 1,
    suspect.sha,
    suspect.message,
    suspect.score,
    suspect.confidence,
    suspect.coverage,
    suspect.factors?.temporal,
    suspect.factors?.fileOverlap,
    suspect.factors?.testOverlap,
    suspect.factors?.diffRisk,
    suspect.factors?.dependencyImpact,
    (suspect.missingSignals ?? []).join(';')
  ]);
  return [headers, ...rows].map((row) => row.map(csv).join(',')).join('\n') + '\n';
}
