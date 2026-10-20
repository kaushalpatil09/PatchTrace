const MINUTE_MS = 60 * 1000;
const DEFAULT_CANDIDATE_WINDOW_MINUTES = 24 * 60;
const ISO_WITH_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const SHA_PATTERN = /^[0-9a-f]{4,64}$/i;
const MAX_COMMITS = 2000;
const MAX_DEPLOYMENTS = 2000;
const MAX_TESTS = 5000;
const MAX_FILES = 5000;
const MAX_EVENTS = 2000;
const MAX_DEPLOYMENT_SHAS = 1000;
const MAX_JUNIT_INPUT_LENGTH = 1_000_000;
const MAX_JUNIT_TAGS = 10_000;
const MAX_JUNIT_DEPTH = 256;
const MAX_WHY_NOT_REASONS = 5;

const RANKING_SIGNALS = Object.freeze([
  'temporal',
  'fileOverlap',
  'testOverlap',
  'diffRisk',
  'dependencyImpact'
]);

const SIGNAL_LABELS = Object.freeze({
  temporal: 'temporal',
  fileOverlap: 'file-overlap',
  testOverlap: 'test-overlap',
  diffRisk: 'diff-risk',
  dependencyImpact: 'dependency-impact'
});

export const SCORING_WEIGHTS = Object.freeze({
  temporal: 0.30,
  fileOverlap: 0.25,
  testOverlap: 0.20,
  diffRisk: 0.15,
  dependencyImpact: 0.10
});

const CONFIDENCE_THRESHOLDS = Object.freeze({
  highScore: 0.75,
  mediumScore: 0.45,
  highCoverage: 0.8,
  mediumCoverage: 0.4
});

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : 0));
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isSha(value) {
  return isNonEmptyString(value) && SHA_PATTERN.test(value);
}

function createCommitShaResolver(candidates = []) {
  const uniqueCandidates = new Map();
  for (const candidate of candidates) {
    if (isSha(candidate)) uniqueCandidates.set(candidate.toLowerCase(), candidate);
  }

  return (value) => {
    if (!isSha(value)) return { status: 'unresolved', match: null };

    const normalizedValue = value.toLowerCase();
    const exact = uniqueCandidates.get(normalizedValue);
    if (exact) return { status: 'matched', match: exact };

    const prefixMatches = [...uniqueCandidates.entries()]
      .filter(([candidate]) => candidate.startsWith(normalizedValue) || normalizedValue.startsWith(candidate))
      .map(([, candidate]) => candidate);
    if (prefixMatches.length === 1) return { status: 'matched', match: prefixMatches[0] };
    if (prefixMatches.length > 1) return { status: 'ambiguous', match: null };
    return { status: 'unresolved', match: null };
  };
}

export function resolveCommitSha(value, candidates = []) {
  return createCommitShaResolver(candidates)(value);
}

function timestamp(value, label = 'timestamp') {
  if (typeof value !== 'string' || !ISO_WITH_ZONE.test(value)) {
    throw new Error(`Invalid ${label}: expected an ISO 8601 timestamp with a timezone, for example 2026-10-20T14:00:00Z.`);
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return parsed;
}

function signedMinutesBetween(later, earlier) {
  return (later - earlier) / MINUTE_MS;
}

function setOf(values = []) {
  return new Set(values.map((value) => String(value).replaceAll('\\', '/')));
}

function intersection(left, right) {
  const rightSet = setOf(right);
  return [...setOf(left)].filter((value) => rightSet.has(value));
}

function deploymentShas(deployment) {
  return [
    ...(deployment.commitSha ? [deployment.commitSha] : []),
    ...(Array.isArray(deployment.commitShas) ? deployment.commitShas : [])
  ];
}

function createDeploymentMatches(deployments, knownCommitShas, environment) {
  const resolve = createCommitShaResolver(knownCommitShas);
  const candidatesBySha = new Map();
  for (const deployment of deployments.filter((entry) => !environment || entry.environment === environment)) {
    for (const sha of deploymentShas(deployment)) {
      const resolution = resolve(sha);
      if (resolution.status !== 'matched') continue;
      const candidateSha = resolution.match.toLowerCase();
      const entry = candidatesBySha.get(candidateSha) ?? { deploymentShas: new Set(), deployments: new Set() };
      entry.deploymentShas.add(sha.toLowerCase());
      entry.deployments.add(deployment);
      candidatesBySha.set(candidateSha, entry);
    }
  }

  const matchesByCommit = new Map();
  for (const [candidateSha, entry] of candidatesBySha) {
    const longerPrefixMatches = [...entry.deploymentShas]
      .filter((deploymentSha) => deploymentSha.length > candidateSha.length
        && deploymentSha.startsWith(candidateSha));
    if (new Set(longerPrefixMatches).size > 1) continue;
    matchesByCommit.set(candidateSha, [...entry.deployments]);
  }
  return matchesByCommit;
}

function deploymentFor(commit, environment, incidentMs, deploymentMatches) {
  const commitSha = String(commit.sha).toLowerCase();
  const matches = (deploymentMatches?.get(commitSha) ?? [])
    .sort((a, b) => timestamp(b.timestamp) - timestamp(a.timestamp)
      || compareText(deploymentShas(a).join(','), deploymentShas(b).join(',')));
  return matches.find((deployment) => timestamp(deployment.timestamp) <= incidentMs) ?? matches[0];
}

function failingTestsFor(commit, failingTests) {
  const changedFiles = commit.changedFiles ?? [];
  return failingTests.filter((test) => intersection(changedFiles, test.relatedFiles ?? []).length > 0);
}

function providedFactor(value, label) {
  if (value === undefined || value === null) {
    return { value: 0, provided: false };
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new Error(`${label} must be a number between 0 and 1.`);
  }
  return { value: number, provided: true };
}

function confidenceFor(score, coverage) {
  if (score >= CONFIDENCE_THRESHOLDS.highScore && coverage >= CONFIDENCE_THRESHOLDS.highCoverage) {
    return 'high';
  }
  if (score >= CONFIDENCE_THRESHOLDS.mediumScore && coverage >= CONFIDENCE_THRESHOLDS.mediumCoverage) {
    return 'medium';
  }
  return 'low';
}

function percentText(value) {
  return `${Math.round(clamp(Number(value)) * 100)}%`;
}

function whyNotFor(suspect, topSuspect) {
  if (!suspect || !topSuspect || suspect === topSuspect || suspect.sha === topSuspect.sha) return [];

  const topMissing = new Set(topSuspect.missingSignals ?? []);
  const suspectMissing = new Set(suspect.missingSignals ?? []);
  const reasons = [];

  for (const signal of RANKING_SIGNALS) {
    if (suspectMissing.has(signal) && !topMissing.has(signal)) {
      reasons.push(`Missing ${SIGNAL_LABELS[signal]} evidence relative to top suspect ${topSuspect.sha}.`);
      continue;
    }

    const suspectContribution = Number(suspect.contributions?.[signal] ?? 0);
    const topContribution = Number(topSuspect.contributions?.[signal] ?? 0);
    if (suspectContribution < topContribution) {
      reasons.push(
        `Weaker ${SIGNAL_LABELS[signal]} evidence than top suspect ${topSuspect.sha} `
        + `(${percentText(suspect.factors?.[signal])} vs ${percentText(topSuspect.factors?.[signal])}).`
      );
    }
  }

  if (!reasons.length) {
    reasons.push(`No ranking signal is stronger than top suspect ${topSuspect.sha}; deterministic tie-break ordering placed this candidate lower.`);
  }

  return reasons.slice(0, MAX_WHY_NOT_REASONS);
}

function decodeXml(value) {
  return String(value).replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (match, entity) => {
    const lower = entity.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    const codePoint = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10FFFF
      ? String.fromCodePoint(codePoint)
      : match;
  });
}

function parseAttributes(source) {
  const attributes = {};
  const text = String(source);
  let index = 0;

  while (index < text.length) {
    while (/\s/.test(text[index] ?? '')) index += 1;
    if (index >= text.length) break;

    const nameMatch = text.slice(index).match(/^[A-Za-z_][\w:.-]*/);
    if (!nameMatch) throw new Error('Malformed JUnit XML: invalid attribute name.');
    const name = nameMatch[0];
    index += name.length;
    while (/\s/.test(text[index] ?? '')) index += 1;
    if (text[index] !== '=') throw new Error(`Malformed JUnit XML: attribute ${name} is missing '='.`);
    index += 1;
    while (/\s/.test(text[index] ?? '')) index += 1;

    const quote = text[index];
    if (quote !== '"' && quote !== "'") {
      throw new Error(`Malformed JUnit XML: attribute ${name} must use quoted text.`);
    }
    index += 1;
    const valueStart = index;
    while (index < text.length && text[index] !== quote) index += 1;
    if (index >= text.length) throw new Error(`Malformed JUnit XML: unterminated attribute ${name}.`);
    if (Object.hasOwn(attributes, name)) throw new Error(`Malformed JUnit XML: duplicate attribute ${name}.`);
    attributes[name] = decodeXml(text.slice(valueStart, index));
    index += 1;
  }
  return attributes;
}

function localName(name) {
  return name.includes(':') ? name.split(':').pop() : name;
}

function scanTags(xml) {
  const tags = [];
  const stack = [];
  let index = 0;
  while (index < xml.length) {
    const start = xml.indexOf('<', index);
    if (start === -1) break;

    if (xml.startsWith('<!--', start)) {
      const end = xml.indexOf('-->', start + 4);
      if (end === -1) throw new Error('Malformed JUnit XML: unterminated comment.');
      index = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', start)) {
      const end = xml.indexOf(']]>', start + 9);
      if (end === -1) throw new Error('Malformed JUnit XML: unterminated CDATA section.');
      index = end + 3;
      continue;
    }
    if (xml.startsWith('<?', start)) {
      const end = xml.indexOf('?>', start + 2);
      if (end === -1) throw new Error('Malformed JUnit XML: unterminated processing instruction.');
      index = end + 2;
      continue;
    }
    if (xml.startsWith('<!', start)) {
      const end = xml.indexOf('>', start + 2);
      if (end === -1) throw new Error('Malformed JUnit XML: unterminated declaration.');
      index = end + 1;
      continue;
    }

    let cursor = start + 1;
    let quote = null;
    while (cursor < xml.length) {
      const character = xml[cursor];
      if (quote) {
        if (character === quote) quote = null;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        break;
      }
      cursor += 1;
    }
    if (cursor >= xml.length) throw new Error('Malformed JUnit XML: unterminated tag.');

    let tag = xml.slice(start + 1, cursor).trim();
    let type = 'open';
    if (tag.startsWith('/')) {
      type = 'close';
      tag = tag.slice(1).trim();
    } else if (tag.endsWith('/')) {
      type = 'self';
      tag = tag.slice(0, -1).trim();
    }
    const whitespace = tag.search(/\s/);
    const name = whitespace === -1 ? tag : tag.slice(0, whitespace);
    const attributes = whitespace === -1 ? '' : tag.slice(whitespace + 1);
    if (!/^[A-Za-z_][\w:.-]*$/.test(name)) {
      throw new Error('Malformed JUnit XML: invalid tag name.');
    }
    if (tags.length >= MAX_JUNIT_TAGS) {
      throw new Error(`Malformed JUnit XML: tag limit exceeded (at most ${MAX_JUNIT_TAGS} tags).`);
    }
    if (type === 'close') {
      if (attributes) throw new Error(`Malformed JUnit XML: closing tag </${name}> cannot have attributes.`);
      const open = stack.pop();
      if (!open) throw new Error(`Malformed JUnit XML: unexpected </${name}>.`);
      if (open.name !== name) {
        throw new Error(`Malformed JUnit XML: mismatched closing tag </${name}>; expected </${open.name}>.`);
      }
    } else {
      parseAttributes(attributes);
      if (type === 'open') {
        if (stack.length >= MAX_JUNIT_DEPTH) {
          throw new Error(`Malformed JUnit XML: nesting depth exceeds ${MAX_JUNIT_DEPTH}.`);
        }
        stack.push({ name });
      }
    }
    tags.push({ type, name, localName: localName(name), attributes, start, end: cursor + 1 });
    index = cursor + 1;
  }
  if (stack.length) throw new Error(`Malformed JUnit XML: missing </${stack.at(-1).name}>.`);
  return tags;
}

function textAfterTag(xml, tag) {
  const closing = `</${tag.name}>`;
  const end = xml.indexOf(closing, tag.end);
  const raw = xml.slice(tag.end, end === -1 ? xml.length : end);
  return decodeXml(raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function testcaseResult(attributes, body) {
  const bodyTags = scanTags(body);
  const failure = bodyTags.find((tag) => tag.localName === 'failure' || tag.localName === 'error');
  const skipped = bodyTags.find((tag) => tag.localName === 'skipped');
  const status = failure ? 'failed' : skipped ? 'skipped' : 'passed';

  let errorSignature = '';
  if (failure) {
    const failureAttributes = parseAttributes(failure.attributes);
    errorSignature = failureAttributes.message
      || failureAttributes.type
      || textAfterTag(body, failure)
      || 'test failure';
  }

  const filePath = attributes.file || attributes.classname || '';
  const relatedFiles = attributes.file ? [attributes.file] : [];
  const duration = Number(attributes.time);

  return {
    name: attributes.name || 'unnamed test',
    filePath,
    status,
    relatedFiles,
    errorSignature,
    ...(Number.isFinite(duration) ? { durationMs: Math.round(duration * 1000) } : {})
  };
}

export function parseDeploymentCsv(csv) {
  const text = String(csv).replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += character;
      }
    } else if (character === '"') {
      if (field.length) throw new Error('Deployment CSV contains a quote inside an unquoted field.');
      inQuotes = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (character !== '\r') {
      field += character;
    }
  }

  if (inQuotes) throw new Error('Deployment CSV has an unterminated quoted field.');
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  const nonEmptyRows = rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
  if (!nonEmptyRows.length) return [];

  const aliases = { sha: 'commitSha', commit: 'commitSha', deployedAt: 'timestamp', time: 'timestamp', env: 'environment' };
  const headers = nonEmptyRows[0].map((header) => aliases[header.trim()] ?? header.trim());
  if (new Set(headers).size !== headers.length) throw new Error('Deployment CSV contains duplicate headers.');
  for (const required of ['commitSha', 'timestamp']) {
    if (!headers.includes(required)) throw new Error(`Deployment CSV is missing required header: ${required}`);
  }

  return nonEmptyRows.slice(1).map((cells, rowIndex) => {
    const values = Object.fromEntries(headers.map((header, index) => [header, (cells[index] ?? '').trim()]));
    const line = rowIndex + 2;
    if (!values.commitSha) throw new Error(`Deployment CSV row ${line} is missing commitSha.`);
    if (!isSha(values.commitSha)) throw new Error(`Deployment CSV row ${line} commitSha must be 4-64 hexadecimal characters.`);
    timestamp(values.timestamp, `deployment CSV row ${line} timestamp`);
    return {
      commitSha: values.commitSha,
      timestamp: values.timestamp,
      environment: values.environment || 'unknown'
    };
  });
}

export function parseJunitXml(xml) {
  const source = String(xml);
  if (source.length > MAX_JUNIT_INPUT_LENGTH) {
    throw new Error(`Malformed JUnit XML: input exceeds ${MAX_JUNIT_INPUT_LENGTH} characters.`);
  }
  const tags = scanTags(source);
  const results = [];
  let current = null;

  for (const tag of tags) {
    if (tag.localName === 'testcase' && tag.type !== 'close') {
      if (current) throw new Error('Malformed JUnit XML: nested <testcase> elements are not supported.');
      const attributes = parseAttributes(tag.attributes);
      if (tag.type === 'self') {
        results.push(testcaseResult(attributes, ''));
      } else {
        current = { attributes, bodyStart: tag.end };
      }
      continue;
    }

    if (tag.localName === 'testcase' && tag.type === 'close') {
      if (!current) throw new Error('Malformed JUnit XML: unexpected </testcase>.');
      results.push(testcaseResult(current.attributes, source.slice(current.bodyStart, tag.start)));
      current = null;
    }
  }
  if (current) throw new Error('Malformed JUnit XML: missing </testcase>.');
  return results;
}

export function buildTimeline(input) {
  const incidentStartMs = timestamp(input.incidentStart, 'incidentStart');
  const incidentEndMs = input.incidentEnd ? timestamp(input.incidentEnd, 'incidentEnd') : null;
  const phaseFor = (value, source) => {
    const eventMs = timestamp(value);
    if (eventMs < incidentStartMs) return 'before';
    if (source === 'incident') {
      return incidentEndMs === null || eventMs <= incidentEndMs ? 'during' : 'after';
    }
    if (incidentEndMs !== null && eventMs <= incidentEndMs) return 'during';
    return 'after';
  };

  const events = [
    ...(input.commits ?? []).map((commit) => ({
      kind: 'commit',
      timestamp: commit.timestamp,
      title: `Commit ${commit.sha.slice(0, 7)} recorded`,
      detail: commit.message,
      commitSha: commit.sha,
      source: 'git'
    })),
    ...(input.deployments ?? []).map((deployment) => ({
      kind: 'deployment',
      timestamp: deployment.timestamp,
      title: `Deployment completed to ${deployment.environment}`,
      detail: `Commit ${deploymentShas(deployment).map((sha) => sha.slice(0, 7)).join(', ')}`,
      commitSha: deployment.commitSha ?? deploymentShas(deployment)[0] ?? null,
      source: 'deployment'
    })),
    ...(input.tests ?? []).filter((test) => test.status === 'failed').map((test) => ({
      kind: 'test_failure',
      timestamp: test.timestamp ?? input.incidentStart,
      title: `${test.name} failed`,
      detail: test.errorSignature || 'failure recorded',
      commitSha: null,
      source: 'test'
    })),
    ...(input.incidentEvents ?? []).map((event) => ({
      kind: event.kind,
      timestamp: event.timestamp,
      title: event.title,
      detail: event.detail || '',
      commitSha: event.commitSha || null,
      source: 'incident'
    }))
  ];

  return events
    .map((event) => ({ ...event, timestampMs: timestamp(event.timestamp), phase: phaseFor(event.timestamp, event.source) }))
    .sort((a, b) => a.timestampMs - b.timestampMs
      || compareText(a.kind, b.kind)
      || compareText(a.title, b.title))
    .map(({ timestampMs, ...event }) => event);
}

export function scoreCommit(commit, input, deploymentMatches) {
  const incidentMs = timestamp(input.incidentStart, 'incidentStart');
  const commitMs = timestamp(commit.timestamp, `commit ${commit.sha} timestamp`);
  const knownCommitShas = Array.isArray(input.commits)
    ? input.commits.map((candidate) => candidate?.sha)
    : [commit.sha];
  const resolvedDeployments = deploymentMatches
    ?? createDeploymentMatches(input.deployments ?? [], [...knownCommitShas, commit.sha], input.environment);
  const deployment = deploymentFor(commit, input.environment, incidentMs, resolvedDeployments);
  const failingTests = (input.tests ?? []).filter((test) => test.status === 'failed');
  const relatedTests = failingTestsFor(commit, failingTests);
  const incidentFiles = input.incidentFiles ?? [];
  const changedFiles = commit.changedFiles ?? [];
  const fileMatches = intersection(changedFiles, incidentFiles);
  const diff = providedFactor(commit.diffRisk, `commit ${commit.sha} diffRisk`);
  const dependency = providedFactor(commit.dependencyImpact, `commit ${commit.sha} dependencyImpact`);
  const deploymentMs = deployment ? timestamp(deployment.timestamp, 'deployment timestamp') : null;
  const deploymentBeforeIncident = deploymentMs !== null && deploymentMs <= incidentMs;
  const deploymentAfterCommit = deploymentMs !== null && deploymentMs >= commitMs;
  const usableDeployment = deploymentBeforeIncident && deploymentAfterCommit;
  const minutes = deploymentMs === null ? null : signedMinutesBetween(incidentMs, deploymentMs);
  const temporal = usableDeployment
    ? clamp(1 / (1 + Math.max(0, minutes) / 30))
    : 0;
  const fileOverlap = incidentFiles.length ? clamp(fileMatches.length / setOf(incidentFiles).size) : 0;
  const testOverlap = failingTests.length ? clamp(relatedTests.length / failingTests.length) : 0;
  const factors = {
    temporal,
    fileOverlap,
    testOverlap,
    diffRisk: diff.value,
    dependencyImpact: dependency.value
  };
  const contributions = Object.fromEntries(
    Object.entries(SCORING_WEIGHTS).map(([key, weight]) => [key, weight * factors[key]])
  );
  const score = clamp(Object.values(contributions).reduce((total, value) => total + value, 0));

  const signalAvailability = {
    temporal: usableDeployment,
    fileOverlap: incidentFiles.length > 0,
    testOverlap: failingTests.length > 0,
    diffRisk: diff.provided,
    dependencyImpact: dependency.provided
  };
  const missingSignals = Object.entries(signalAvailability)
    .filter(([, available]) => !available)
    .map(([signal]) => signal);
  const coverage = (Object.keys(signalAvailability).length - missingSignals.length) / Object.keys(signalAvailability).length;
  const confidence = confidenceFor(score, coverage);
  const diffOrigin = commit.diffRiskSource?.startsWith('derived') ? 'derived' : 'provided';
  const dependencyOrigin = commit.dependencyImpactSource?.startsWith('derived') ? 'derived' : 'provided';
  const signalSources = {
    temporal: usableDeployment ? 'derived' : 'missing',
    fileOverlap: incidentFiles.length ? 'derived' : 'missing',
    testOverlap: failingTests.length ? 'derived' : 'missing',
    diffRisk: diff.provided ? diffOrigin : 'missing',
    dependencyImpact: dependency.provided ? dependencyOrigin : 'missing'
  };
  const evidence = [];
  if (deployment && usableDeployment) {
    evidence.push({
      kind: 'deployment',
      weight: temporal,
      text: `Deployed ${Math.round(minutes)} minutes before the incident started.`,
      source: `deployment:${deployment.commitSha ?? deploymentShas(deployment).join(',')}`,
      origin: 'derived'
    });
  } else if (deployment && !deploymentBeforeIncident) {
    evidence.push({
      kind: 'post-incident-deployment',
      weight: 0,
      text: `Deployment occurred ${Math.abs(Math.round(minutes))} minutes after the incident started and was not treated as causal evidence.`,
      source: `deployment:${deployment.commitSha ?? deploymentShas(deployment).join(',')}`,
      origin: 'derived'
    });
  } else if (deployment && !deploymentAfterCommit) {
    evidence.push({
      kind: 'deployment-order',
      weight: 0,
      text: 'Deployment occurred before this commit and was not treated as causal evidence.',
      source: `deployment:${deployment.commitSha ?? deploymentShas(deployment).join(',')}`,
      origin: 'derived'
    });
  } else {
    evidence.push({
      kind: 'missing-deployment',
      weight: 0,
      text: input.environment
        ? `No matching deployment in ${input.environment} was found.`
        : 'No matching deployment event was found.',
      source: null,
      origin: 'missing'
    });
  }

  if (fileMatches.length) {
    evidence.push({
      kind: 'file-overlap',
      weight: fileOverlap,
      text: `Changed files overlap with incident evidence: ${fileMatches.join(', ')}.`,
      source: 'incidentFiles',
      origin: 'derived'
    });
  } else {
    evidence.push({
      kind: 'missing-file-overlap',
      weight: 0,
      text: incidentFiles.length
        ? 'No changed-file overlap with the incident files was found.'
        : 'No incident files were provided.',
      source: null,
      origin: 'missing'
    });
  }

  if (relatedTests.length) {
    evidence.push({
      kind: 'test-overlap',
      weight: testOverlap,
      text: `Related failing test: ${relatedTests.map((test) => test.name).join(', ')}.`,
      source: `tests:${relatedTests.map((test) => test.name).join(',')}`,
      origin: 'derived'
    });
  } else {
    evidence.push({
      kind: 'missing-test-overlap',
      weight: 0,
      text: failingTests.length
        ? 'No failing test was directly connected to this commit.'
        : 'No failing test data was provided.',
      source: null,
      origin: 'missing'
    });
  }

  evidence.push(diff.provided
    ? {
        kind: 'diff-risk',
        weight: factors.diffRisk,
        text: `Diff-risk signal is ${(factors.diffRisk * 100).toFixed(0)}% (${diffOrigin === 'derived' ? 'derived from the Git diff' : 'provided input'}).`,
        source: 'commit.diffRisk',
        origin: diffOrigin
      }
    : {
        kind: 'missing-diff-risk',
        weight: 0,
        text: 'No diff-risk signal was provided or derived.',
        source: null,
        origin: 'missing'
      });

  evidence.push(dependency.provided
    ? {
        kind: 'dependency-impact',
        weight: factors.dependencyImpact,
        text: `Dependency blast-radius signal is ${(factors.dependencyImpact * 100).toFixed(0)}% (${dependencyOrigin === 'derived' ? 'derived from the package graph' : 'provided input'}).`,
        source: 'commit.dependencyImpact',
        origin: dependencyOrigin
      }
    : {
        kind: 'missing-dependency-impact',
        weight: 0,
        text: 'No dependency-impact signal was provided or derived.',
        source: null,
        origin: 'missing'
      });

  return {
    sha: commit.sha,
    message: commit.message,
    timestamp: commit.timestamp,
    changedFiles,
    score,
    confidence,
    coverage,
    missingSignals,
    signalSources,
    factors,
    contributions,
    evidence,
    relatedTests: relatedTests.map((test) => ({
      name: test.name,
      errorSignature: test.errorSignature,
      relatedFiles: test.relatedFiles
    }))
  };
}

export function validateIncident(input) {
  const errors = [];
  const add = (path, message) => errors.push({ path, message });

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    add('', 'Incident bundle must be an object.');
    return { valid: false, errors };
  }

  if (input.schemaVersion === undefined) {
    add('schemaVersion', 'schemaVersion is required. Supported version: 1.');
  } else if (input.schemaVersion !== 1) {
    add('schemaVersion', 'Only schemaVersion 1 is supported.');
  }
  for (const field of ['title', 'environment', 'incidentStart']) {
    if (!isNonEmptyString(input[field])) add(field, `${field} is required.`);
  }
  if (input.summary !== undefined && typeof input.summary !== 'string') {
    add('summary', 'summary must be a string.');
  }
  if (isNonEmptyString(input.incidentStart)) {
    try {
      timestamp(input.incidentStart, 'incidentStart');
    } catch (error) {
      add('incidentStart', error.message);
    }
  }
  if (input.incidentEnd !== undefined) {
    try {
      timestamp(input.incidentEnd, 'incidentEnd');
    } catch (error) {
      add('incidentEnd', error.message);
    }
  }
  if (isNonEmptyString(input.incidentStart) && isNonEmptyString(input.incidentEnd)) {
    try {
      if (timestamp(input.incidentEnd) < timestamp(input.incidentStart)) {
        add('incidentEnd', 'incidentEnd must be at or after incidentStart.');
      }
    } catch {
      // The individual timestamp errors above are more useful.
    }
  }
  if (input.candidateWindowMinutes !== undefined
    && (!Number.isFinite(input.candidateWindowMinutes) || input.candidateWindowMinutes <= 0)) {
    add('candidateWindowMinutes', 'candidateWindowMinutes must be a positive number.');
  }
  if (input.incidentFiles !== undefined && !Array.isArray(input.incidentFiles)) {
    add('incidentFiles', 'incidentFiles must be an array of paths.');
  } else if (Array.isArray(input.incidentFiles)) {
    if (input.incidentFiles.length > MAX_FILES) {
      add('incidentFiles', `incidentFiles must contain at most ${MAX_FILES} paths.`);
    } else {
      input.incidentFiles.forEach((file, index) => {
        if (!isNonEmptyString(file)) add(`incidentFiles[${index}]`, 'File path must be a non-empty string.');
      });
    }
  }

  if (!Array.isArray(input.commits)) {
    add('commits', 'commits must be an array.');
  } else if (input.commits.length > MAX_COMMITS) {
    add('commits', `commits must contain at most ${MAX_COMMITS} entries.`);
  } else {
    const seenShas = new Set();
    input.commits.forEach((commit, index) => {
      const path = `commits[${index}]`;
      if (!commit || typeof commit !== 'object') {
        add(path, 'Commit must be an object.');
        return;
      }
      if (!isNonEmptyString(commit.sha)) {
        add(`${path}.sha`, 'Commit SHA is required.');
      } else if (!isSha(commit.sha)) {
        add(`${path}.sha`, 'Commit SHA must be 4-64 hexadecimal characters.');
      } else {
        const normalized = commit.sha.toLowerCase();
        if (seenShas.has(normalized)) add(`${path}.sha`, 'Duplicate commit SHA.');
        seenShas.add(normalized);
      }
      if (!isNonEmptyString(commit.message)) add(`${path}.message`, 'Commit message is required.');
      try {
        timestamp(commit.timestamp, `${path}.timestamp`);
      } catch (error) {
        add(`${path}.timestamp`, error.message);
      }
      if (commit.changedFiles !== undefined && !Array.isArray(commit.changedFiles)) {
        add(`${path}.changedFiles`, 'changedFiles must be an array.');
      } else if (Array.isArray(commit.changedFiles)) {
        if (commit.changedFiles.length > MAX_FILES) {
          add(`${path}.changedFiles`, `changedFiles must contain at most ${MAX_FILES} paths.`);
        } else {
          commit.changedFiles.forEach((file, fileIndex) => {
            if (!isNonEmptyString(file)) add(`${path}.changedFiles[${fileIndex}]`, 'File path must be a non-empty string.');
          });
        }
      }
      for (const factor of ['diffRisk', 'dependencyImpact']) {
        if (commit[factor] !== undefined
          && (!Number.isFinite(commit[factor]) || commit[factor] < 0 || commit[factor] > 1)) {
          add(`${path}.${factor}`, `${factor} must be a number between 0 and 1.`);
        }
      }
      for (const source of ['diffRiskSource', 'dependencyImpactSource']) {
        if (commit[source] !== undefined && typeof commit[source] !== 'string') {
          add(`${path}.${source}`, `${source} must be a string.`);
        }
      }
    });
  }

  if (input.deployments !== undefined && !Array.isArray(input.deployments)) {
    add('deployments', 'deployments must be an array.');
  } else if (Array.isArray(input.deployments)) {
    if (input.deployments.length > MAX_DEPLOYMENTS) {
      add('deployments', `deployments must contain at most ${MAX_DEPLOYMENTS} entries.`);
    } else {
      input.deployments.forEach((deployment, index) => {
      const path = `deployments[${index}]`;
      if (!deployment || typeof deployment !== 'object') {
        add(path, 'Deployment must be an object.');
        return;
      }
      if (!isNonEmptyString(deployment.commitSha) && !(Array.isArray(deployment.commitShas) && deployment.commitShas.length)) {
        add(path, 'Deployment must have commitSha or commitShas.');
      }
      if (deployment.commitSha !== undefined && !isSha(deployment.commitSha)) {
        add(`${path}.commitSha`, 'Commit SHA must be 4-64 hexadecimal characters.');
      }
      if (deployment.commitShas !== undefined) {
        if (!Array.isArray(deployment.commitShas)) {
          add(`${path}.commitShas`, 'commitShas must be an array.');
        } else if (deployment.commitShas.length > MAX_DEPLOYMENT_SHAS) {
          add(`${path}.commitShas`, `commitShas must contain at most ${MAX_DEPLOYMENT_SHAS} entries.`);
        } else {
          deployment.commitShas.forEach((sha, shaIndex) => {
            if (!isSha(sha)) add(`${path}.commitShas[${shaIndex}]`, 'Commit SHA must be 4-64 hexadecimal characters.');
          });
        }
      }
      try {
        timestamp(deployment.timestamp, `${path}.timestamp`);
      } catch (error) {
        add(`${path}.timestamp`, error.message);
      }
      if (!isNonEmptyString(deployment.environment)) add(`${path}.environment`, 'Environment is required.');
    });
    }
  }

  if (input.tests !== undefined && !Array.isArray(input.tests)) {
    add('tests', 'tests must be an array.');
  } else if (Array.isArray(input.tests)) {
    if (input.tests.length > MAX_TESTS) {
      add('tests', `tests must contain at most ${MAX_TESTS} entries.`);
    } else {
      input.tests.forEach((test, index) => {
      const path = `tests[${index}]`;
      if (!test || typeof test !== 'object') {
        add(path, 'Test result must be an object.');
        return;
      }
      if (!isNonEmptyString(test.name)) add(`${path}.name`, 'Test name is required.');
      if (!['passed', 'failed', 'skipped'].includes(test.status)) {
        add(`${path}.status`, 'Test status must be passed, failed, or skipped.');
      }
      if (test.timestamp !== undefined) {
        try {
          timestamp(test.timestamp, `${path}.timestamp`);
        } catch (error) {
          add(`${path}.timestamp`, error.message);
        }
      }
      if (test.relatedFiles !== undefined && !Array.isArray(test.relatedFiles)) {
        add(`${path}.relatedFiles`, 'relatedFiles must be an array.');
      } else if (Array.isArray(test.relatedFiles)) {
        if (test.relatedFiles.length > MAX_FILES) {
          add(`${path}.relatedFiles`, `relatedFiles must contain at most ${MAX_FILES} paths.`);
        } else {
          test.relatedFiles.forEach((file, fileIndex) => {
            if (!isNonEmptyString(file)) add(`${path}.relatedFiles[${fileIndex}]`, 'File path must be a non-empty string.');
          });
        }
      }
      if (test.errorSignature !== undefined && typeof test.errorSignature !== 'string') {
        add(`${path}.errorSignature`, 'errorSignature must be a string.');
      }
    });
    }
  }

  if (input.incidentEvents !== undefined && !Array.isArray(input.incidentEvents)) {
    add('incidentEvents', 'incidentEvents must be an array.');
  } else if (Array.isArray(input.incidentEvents)) {
    if (input.incidentEvents.length > MAX_EVENTS) {
      add('incidentEvents', `incidentEvents must contain at most ${MAX_EVENTS} entries.`);
    } else {
      input.incidentEvents.forEach((event, index) => {
      const path = `incidentEvents[${index}]`;
      if (!event || typeof event !== 'object') {
        add(path, 'Incident event must be an object.');
        return;
      }
      if (!isNonEmptyString(event.kind)) add(`${path}.kind`, 'Event kind is required.');
      if (!isNonEmptyString(event.title)) add(`${path}.title`, 'Event title is required.');
      if (event.detail !== undefined && typeof event.detail !== 'string') {
        add(`${path}.detail`, 'Event detail must be a string.');
      }
      if (event.commitSha !== undefined && !isSha(event.commitSha)) {
        add(`${path}.commitSha`, 'Commit SHA must be 4-64 hexadecimal characters.');
      }
      try {
        timestamp(event.timestamp, `${path}.timestamp`);
      } catch (error) {
        add(`${path}.timestamp`, error.message);
      }
    });
    }
  }

  if (input.verification !== undefined
    && (!input.verification || typeof input.verification !== 'object' || Array.isArray(input.verification))) {
    add('verification', 'verification must be an object keyed by commit SHA.');
  } else if (input.verification) {
    for (const [sha, result] of Object.entries(input.verification)) {
      if (!isSha(sha)) add(`verification.${sha}`, 'Verification key must be 4-64 hexadecimal characters.');
      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        add(`verification.${sha}`, 'Verification fixture must be an object.');
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function assertValidIncident(input) {
  const result = validateIncident(input);
  if (!result.valid) {
    const message = result.errors.map((error) => `${error.path || 'bundle'}: ${error.message}`).join('; ');
    const error = new Error(`Invalid incident bundle: ${message}`);
    error.code = 'invalid_bundle';
    error.errors = result.errors;
    throw error;
  }
  return input;
}

export function analyzeIncident(input) {
  assertValidIncident(input);
  const incidentMs = timestamp(input.incidentStart, 'incidentStart');
  const windowMinutes = input.candidateWindowMinutes ?? DEFAULT_CANDIDATE_WINDOW_MINUTES;
  const windowStartMs = incidentMs - windowMinutes * MINUTE_MS;
  const allCommits = input.commits ?? [];
  const candidates = allCommits.filter((commit) => {
    const commitMs = timestamp(commit.timestamp, `commit ${commit.sha} timestamp`);
    return commitMs <= incidentMs && commitMs >= windowStartMs;
  });
  const timeline = buildTimeline(input);
  const deploymentMatches = createDeploymentMatches(input.deployments ?? [], allCommits.map((commit) => commit.sha), input.environment);
  const rankedSuspects = candidates
    .map((commit) => scoreCommit(commit, input, deploymentMatches))
    .sort((a, b) => b.score - a.score
      || b.contributions.temporal - a.contributions.temporal
      || timestamp(a.timestamp) - timestamp(b.timestamp)
      || compareText(a.sha, b.sha));
  const topSuspect = rankedSuspects[0] ?? null;
  const suspects = rankedSuspects.map((suspect) => ({
    ...suspect,
    whyNot: whyNotFor(suspect, topSuspect)
  }));

  const warnings = [];
  if (!suspects.length) {
    warnings.push('No candidate commits fell inside the analysis window. Widen the window or check the incident timestamps.');
  } else if (suspects[0].confidence === 'low') {
    warnings.push('Evidence is weak. No reliable suspect can be identified yet.');
  } else if (suspects[0].coverage < 0.6) {
    warnings.push('The top candidate is missing several evidence signals. Treat the ranking as provisional.');
  }

  return {
    schemaVersion: 1,
    incident: {
      title: input.title,
      summary: input.summary ?? '',
      incidentStart: input.incidentStart,
      incidentEnd: input.incidentEnd ?? null,
      environment: input.environment
    },
    timeline,
    suspects,
    weights: SCORING_WEIGHTS,
    candidateWindowMinutes: windowMinutes,
    excludedCandidateCount: allCommits.length - candidates.length,
    warnings,
    verification: input.verification ?? {}
  };
}

export function verifyFixture(analysis, sha) {
  const result = analysis?.verification?.[sha];
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return {
      status: 'not_available',
      message: 'No fixture verification is available for this candidate.',
      baseline: null,
      candidate: null
    };
  }
  return { ...result, status: 'complete' };
}
