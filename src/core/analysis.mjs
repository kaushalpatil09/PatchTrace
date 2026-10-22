const MINUTE_MS = 60 * 1000;
const DEFAULT_CANDIDATE_WINDOW_MINUTES = 24 * 60;
const ISO_WITH_ZONE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):?(\d{2}))$/i;
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
const MAX_DEPENDENCY_DETAIL_FILES = 100;
const MAX_RELATED_TEST_DETAILS = 20;

const DEPENDENCY_FILE_RULES = Object.freeze([
  { ecosystem: 'node', kind: 'manifest', pattern: /(^|\/)package\.json$/i },
  { ecosystem: 'node', kind: 'lockfile', pattern: /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.ya?ml)$/i },
  { ecosystem: 'python', kind: 'manifest', pattern: /(^|\/)(requirements(?:[-_.][^/]*)?\.txt|requirements\/[^/]+\.txt|pyproject\.toml|setup\.py|setup\.cfg|Pipfile)$/i },
  { ecosystem: 'python', kind: 'lockfile', pattern: /(^|\/)(poetry\.lock|Pipfile\.lock|uv\.lock)$/i },
  { ecosystem: 'go', kind: 'manifest', pattern: /(^|\/)go\.mod$/i },
  { ecosystem: 'go', kind: 'lockfile', pattern: /(^|\/)(go\.sum|vendor\/modules\.txt)$/i },
  { ecosystem: 'rust', kind: 'manifest', pattern: /(^|\/)Cargo\.toml$/i },
  { ecosystem: 'rust', kind: 'lockfile', pattern: /(^|\/)Cargo\.lock$/i },
  { ecosystem: 'ruby', kind: 'manifest', pattern: /(^|\/)(Gemfile|gems\.rb|[^/]+\.gemspec)$/i },
  { ecosystem: 'ruby', kind: 'lockfile', pattern: /(^|\/)(Gemfile\.lock|gems\.locked)$/i },
  { ecosystem: 'maven', kind: 'manifest', pattern: /(^|\/)(pom\.xml|dependency-reduced-pom\.xml)$/i },
  { ecosystem: 'gradle', kind: 'manifest', pattern: /(^|\/)(build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|gradle\.properties)$/i },
  { ecosystem: 'gradle', kind: 'lockfile', pattern: /(^|\/)(gradle\.lockfile|libs\.versions\.toml)$/i }
]);

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
  const [, year, month, day, hour, minute, second, offsetHour = '0', offsetMinute = '0'] = value.match(ISO_WITH_ZONE);
  const y = Number(year);
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (Number.isNaN(parsed) || Number(month) < 1 || Number(month) > 12
    || Number(day) < 1 || Number(day) > days[Number(month) - 1]
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59
    || Number(offsetHour) > 23 || Number(offsetMinute) > 59) {
    throw new Error(`Invalid ${label}: expected a real calendar date and time with a timezone.`);
  }
  return parsed;
}

function signedMinutesBetween(later, earlier) {
  return (later - earlier) / MINUTE_MS;
}

export { timestamp as parseTimestamp };

function setOf(values = []) {
  return new Set(values.map((value) => String(value).replaceAll('\\', '/')));
}

function intersection(left, right) {
  const rightSet = setOf(right);
  return [...setOf(left)].filter((value) => rightSet.has(value));
}

function normalizeRepositoryPath(value) {
  return String(value ?? '')
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/^[ab]\//i, '')
    .replace(/^\/(?:a|b)\//i, '');
}

export function dependencyFileInfo(file) {
  const path = normalizeRepositoryPath(file);
  if (!path) return null;
  const rule = DEPENDENCY_FILE_RULES.find((candidate) => candidate.pattern.test(path));
  return rule ? { path, ecosystem: rule.ecosystem, kind: rule.kind } : null;
}

function normalizedDiffStats(stats) {
  if (!Array.isArray(stats)) return [];
  return stats.slice(0, MAX_FILES)
    .filter((stat) => stat && typeof stat === 'object' && typeof stat.path === 'string')
    .map((stat) => {
      const additions = Number(stat.additions);
      const deletions = Number(stat.deletions);
      const changedLines = Number(stat.changedLines ?? (
        (Number.isFinite(additions) ? additions : 0) + (Number.isFinite(deletions) ? deletions : 0)
      ));
      return {
        path: normalizeRepositoryPath(stat.path),
        additions: Number.isFinite(additions) && additions >= 0 ? additions : 0,
        deletions: Number.isFinite(deletions) && deletions >= 0 ? deletions : 0,
        changedLines: Number.isFinite(changedLines) && changedLines >= 0 ? changedLines : 0
      };
    })
    .filter((stat) => stat.path);
}

/**
 * Derive a deterministic dependency-blast-radius signal from repository paths
 * and bounded Git diff statistics. The returned details intentionally expose
 * the inputs and components so callers can inspect why the value was chosen.
 */
export function deriveDependencyImpact(commit = {}) {
  const hasChangedFileEvidence = Array.isArray(commit.changedFiles) || Array.isArray(commit.diffStats);
  const changedFilesInputTruncated = Array.isArray(commit.changedFiles) && commit.changedFiles.length > MAX_FILES;
  const diffStatsInputTruncated = Array.isArray(commit.diffStats) && commit.diffStats.length > MAX_FILES;
  const changedFiles = Array.isArray(commit.changedFiles)
    ? [...new Set(commit.changedFiles.slice(0, MAX_FILES).map(normalizeRepositoryPath).filter(Boolean))]
    : [];
  const fallbackChangedLines = Number(commit.changedLines ?? commit.diffLines);
  const fallbackStats = !Array.isArray(commit.diffStats)
    && changedFiles.length === 1
    && Number.isFinite(fallbackChangedLines)
    && fallbackChangedLines >= 0
    ? [{ path: changedFiles[0], changedLines: fallbackChangedLines }]
    : [];
  const stats = normalizedDiffStats(Array.isArray(commit.diffStats) ? commit.diffStats : fallbackStats);
  const allPaths = [...new Set([...changedFiles, ...stats.map((stat) => stat.path)])];
  const dependencyFiles = allPaths
    .map((path) => dependencyFileInfo(path))
    .filter(Boolean)
    .slice(0, MAX_DEPENDENCY_DETAIL_FILES);
  const dependencyByPath = new Map(dependencyFiles.map((file) => [file.path, file]));
  const dependencyStats = stats.filter((stat) => dependencyByPath.has(stat.path));
  const dependencyDiffLines = dependencyStats.reduce((total, stat) => total + stat.changedLines, 0);
  const totalDiffLines = Number(commit.diffLines);
  const totalObservedDiffLines = Number.isFinite(totalDiffLines) && totalDiffLines >= 0
    ? totalDiffLines
    : stats.reduce((total, stat) => total + stat.changedLines, 0);
  const manifestFiles = dependencyFiles.filter((file) => file.kind === 'manifest').map((file) => file.path);
  const lockfiles = dependencyFiles.filter((file) => file.kind === 'lockfile').map((file) => file.path);
  const ecosystems = [...new Set(dependencyFiles.map((file) => file.ecosystem))];
  const manifestSignal = clamp(manifestFiles.length / 2);
  const lockfileSignal = clamp(lockfiles.length / 2);
  const fileSignal = clamp(dependencyFiles.length / 3);
  const suppliedDiffRisk = Number(commit.diffRisk);
  const churnSignal = dependencyDiffLines > 0
    ? clamp(Math.log1p(dependencyDiffLines) / Math.log1p(200))
    : Number.isFinite(suppliedDiffRisk) ? clamp(suppliedDiffRisk) : 0;
  const value = hasChangedFileEvidence
    ? clamp(manifestSignal * 0.45 + lockfileSignal * 0.30 + fileSignal * 0.15 + churnSignal * 0.10)
    : 0;
  const available = hasChangedFileEvidence && dependencyFiles.length > 0;
  const source = available ? 'derived:dependency-files' : null;
  const details = {
    formula: '0.45*manifestSignal + 0.30*lockfileSignal + 0.15*fileSignal + 0.10*churnSignal',
    dependencyFiles: dependencyFiles.map((file) => file.path),
    manifestFiles,
    lockfiles,
    ecosystems,
    manifestCount: manifestFiles.length,
    lockfileCount: lockfiles.length,
    dependencyFileCount: dependencyFiles.length,
    dependencyDiffLines,
    totalDiffLines: totalObservedDiffLines,
    signals: { manifestSignal, lockfileSignal, fileSignal, churnSignal },
    ...(hasChangedFileEvidence && dependencyFiles.length === 0
      ? { reason: 'No supported dependency manifest or lockfile changed.' }
      : {}),
    ...(commit.changedFilesTruncated ? { changedFilesTruncated: true } : {}),
    ...(commit.diffLinesTruncated ? { diffLinesTruncated: true } : {}),
    ...(commit.diffOutputTruncated ? { diffOutputTruncated: true } : {}),
    ...(changedFilesInputTruncated ? { changedFilesTruncated: true } : {}),
    ...(diffStatsInputTruncated ? { diffStatsTruncated: true } : {})
  };

  return {
    value: available ? value : 0,
    available,
    source,
    details
  };
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

function scoringContext(input) {
  const failingTests = (input.tests ?? []).filter((test) => test.status === 'failed');
  const testsByFile = new Map();
  let pathReferences = 0;
  const addPaths = (paths) => {
    pathReferences += paths?.length ?? 0;
    if (pathReferences > 250_000) throw analysisLimitError();
  };
  for (const commit of input.commits ?? []) addPaths(commit.changedFiles);
  for (const test of input.tests ?? []) addPaths(test.relatedFiles);
  for (const [index, test] of failingTests.entries()) {
    for (const file of setOf(test.relatedFiles ?? [])) {
      if (!testsByFile.has(file)) testsByFile.set(file, []);
      testsByFile.get(file).push(index);
    }
  }
  // Conservative upper bound on postings visited, before candidate scoring/output.
  let visits = 0;
  for (const commit of input.commits ?? []) {
    for (const file of setOf(commit.changedFiles ?? [])) {
      visits += testsByFile.get(file)?.length ?? 0;
      if (visits > 50_000_000) throw analysisLimitError();
    }
  }
  return { failingTests, testsByFile,
    missingRelatedTests: failingTests.filter((test) => !Array.isArray(test.relatedFiles)) };
}

function analysisLimitError() {
  const error = new Error('Analysis exceeds the workload budget (250000 path references or 50000000 overlap visits). Narrow the bundle.');
  error.code = 'analysis_limit';
  return error;
}

function failingTestsFor(commit, context) {
  const indexes = new Set();
  for (const file of setOf(commit.changedFiles ?? [])) {
    for (const index of context.testsByFile.get(file) ?? []) indexes.add(index);
  }
  // Preserve input test order and count each test once even if multiple files match.
  return [...indexes].sort((a, b) => a - b).map((index) => context.failingTests[index]);
}

function overlapState(available, hasOverlap) {
  if (!available) return 'unknown';
  return hasOverlap ? 'observed_overlap' : 'observed_no_overlap';
}

function missingFileOverlapText({ hasIncidentFiles, hasChangedFiles }) {
  if (!hasIncidentFiles && !hasChangedFiles) {
    return 'Incident files and changedFiles were not provided, so file overlap could not be evaluated.';
  }
  if (!hasIncidentFiles) return 'No incident files were provided, so file overlap could not be evaluated.';
  return 'No changedFiles were provided for this candidate, so file overlap could not be evaluated.';
}

function missingTestOverlapText({ hasChangedFiles, failingTests, missingRelatedTests }) {
  if (!failingTests.length) return 'No failing test data was provided.';
  if (!hasChangedFiles && missingRelatedTests.length) {
    return 'No changedFiles were provided for this candidate, and some failing tests lack relatedFiles, so test overlap could not be evaluated.';
  }
  if (!hasChangedFiles) {
    return 'No changedFiles were provided for this candidate, so test overlap could not be evaluated.';
  }
  if (missingRelatedTests.length) {
    return 'Some failing tests do not provide relatedFiles, so test overlap could not be fully evaluated.';
  }
  return 'Test overlap could not be evaluated.';
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

function dependencyFactorFor(commit) {
  const provided = providedFactor(commit.dependencyImpact, `commit ${commit.sha} dependencyImpact`);
  if (provided.provided) {
    const source = typeof commit.dependencyImpactSource === 'string'
      ? commit.dependencyImpactSource
      : 'provided';
    return {
      ...provided,
      origin: source.startsWith('derived') ? 'derived' : 'provided',
      source,
      details: commit.dependencyImpactDetails ?? null
    };
  }

  const derived = deriveDependencyImpact(commit);
  if (!derived.available) {
    return {
      value: 0,
      provided: false,
      origin: 'missing',
      source: null,
      details: null
    };
  }
  return {
    value: derived.value,
    provided: true,
    origin: 'derived',
    source: derived.source,
    details: derived.details
  };
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
    ...(attributes.timestamp !== undefined ? { timestamp: attributes.timestamp } : {}),
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
    ...(input.tests ?? [])
      .filter((test) => test.status === 'failed' && test.timestamp !== undefined && test.timestamp !== null)
      .map((test) => ({
        kind: 'test_failure',
        timestamp: test.timestamp,
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
    .map((event) => event.timestamp === null || event.timestamp === undefined
      ? { ...event, phase: 'unknown', timestampMs: null }
      : { ...event, timestampMs: timestamp(event.timestamp), phase: phaseFor(event.timestamp, event.source) })
    .sort((a, b) => {
      const aUnknown = a.timestampMs === null;
      const bUnknown = b.timestampMs === null;
      if (aUnknown !== bUnknown) return aUnknown ? 1 : -1;
      return (aUnknown ? 0 : a.timestampMs - b.timestampMs)
        || compareText(a.kind, b.kind)
        || compareText(a.title, b.title)
        || compareText(a.detail, b.detail)
        || compareText(a.source, b.source);
    })
    .map(({ timestampMs, ...event }) => event);
}

export function scoreCommit(commit, input, deploymentMatches, context = scoringContext(input)) {
  const incidentMs = timestamp(input.incidentStart, 'incidentStart');
  const commitMs = timestamp(commit.timestamp, `commit ${commit.sha} timestamp`);
  const resolvedDeployments = deploymentMatches
    ?? createDeploymentMatches(input.deployments ?? [], [...(input.commits ?? []).map((candidate) => candidate?.sha), commit.sha], input.environment);
  const deployment = deploymentFor(commit, input.environment, incidentMs, resolvedDeployments);
  const { failingTests, missingRelatedTests } = context;
  const hasIncidentFiles = Array.isArray(input.incidentFiles) && input.incidentFiles.length > 0;
  const hasChangedFiles = Array.isArray(commit.changedFiles);
  const fileOverlapAvailable = hasIncidentFiles && hasChangedFiles;
  const testOverlapAvailable = failingTests.length > 0
    && hasChangedFiles
    && missingRelatedTests.length === 0;
  const relatedTests = testOverlapAvailable ? failingTestsFor(commit, context) : [];
  const relatedTestDetails = relatedTests.slice(0, MAX_RELATED_TEST_DETAILS);
  const relatedTestsTruncated = relatedTestDetails.length < relatedTests.length;
  const incidentFiles = input.incidentFiles ?? [];
  const changedFiles = commit.changedFiles ?? [];
  const fileMatches = fileOverlapAvailable ? intersection(changedFiles, incidentFiles) : [];
  const diff = providedFactor(commit.diffRisk, `commit ${commit.sha} diffRisk`);
  const dependency = dependencyFactorFor(commit);
  const deploymentMs = deployment ? timestamp(deployment.timestamp, 'deployment timestamp') : null;
  const deploymentBeforeIncident = deploymentMs !== null && deploymentMs <= incidentMs;
  const deploymentAfterCommit = deploymentMs !== null && deploymentMs >= commitMs;
  const usableDeployment = deploymentBeforeIncident && deploymentAfterCommit;
  const minutes = deploymentMs === null ? null : signedMinutesBetween(incidentMs, deploymentMs);
  const temporal = usableDeployment
    ? clamp(1 / (1 + Math.max(0, minutes) / 30))
    : 0;
  const fileOverlap = fileOverlapAvailable ? clamp(fileMatches.length / setOf(incidentFiles).size) : 0;
  const testOverlap = testOverlapAvailable ? clamp(relatedTests.length / failingTests.length) : 0;
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
    fileOverlap: fileOverlapAvailable,
    testOverlap: testOverlapAvailable,
    diffRisk: diff.provided,
    dependencyImpact: dependency.provided
  };
  const missingSignals = Object.entries(signalAvailability)
    .filter(([, available]) => !available)
    .map(([signal]) => signal);
  const coverage = (Object.keys(signalAvailability).length - missingSignals.length) / Object.keys(signalAvailability).length;
  const confidence = confidenceFor(score, coverage);
  const diffOrigin = commit.diffRiskSource?.startsWith('derived') ? 'derived' : 'provided';
  const dependencyOrigin = dependency.origin;
  const signalSources = {
    temporal: usableDeployment ? 'derived' : 'missing',
    fileOverlap: fileOverlapAvailable ? 'derived' : 'missing',
    testOverlap: testOverlapAvailable ? 'derived' : 'missing',
    diffRisk: diff.provided ? diffOrigin : 'missing',
    dependencyImpact: dependency.provided ? dependencyOrigin : 'missing'
  };
  const signalDetails = {
    fileOverlap: {
      state: overlapState(fileOverlapAvailable, fileMatches.length > 0),
      source: fileOverlapAvailable ? 'incidentFiles+commit.changedFiles' : null,
      ...(fileOverlapAvailable ? { matchingFiles: fileMatches } : {
        reason: missingFileOverlapText({ hasIncidentFiles, hasChangedFiles })
      })
    },
    testOverlap: {
      state: overlapState(testOverlapAvailable, relatedTests.length > 0),
      source: testOverlapAvailable ? 'tests.relatedFiles+commit.changedFiles' : null,
      ...(testOverlapAvailable ? { relatedTests: relatedTestDetails.map((test) => test.name),
        ...(relatedTestsTruncated ? { relatedTestCount: relatedTests.length, truncated: true } : {}) } : {
        reason: missingTestOverlapText({ hasChangedFiles, failingTests, missingRelatedTests })
      })
    },
    dependencyImpact: dependency.details
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
  } else if (fileOverlapAvailable) {
    evidence.push({
      kind: 'no-file-overlap',
      signal: 'fileOverlap',
      state: 'observed_no_overlap',
      weight: 0,
      text: 'No changed-file overlap with the incident files was found.',
      source: 'incidentFiles+commit.changedFiles',
      origin: 'derived'
    });
  } else {
    evidence.push({
      kind: 'missing-file-overlap',
      signal: 'fileOverlap',
      state: 'unknown',
      weight: 0,
      text: missingFileOverlapText({ hasIncidentFiles, hasChangedFiles }),
      source: null,
      origin: 'missing'
    });
  }

  if (relatedTests.length) {
    evidence.push({
      kind: 'test-overlap',
      weight: testOverlap,
      text: `Related failing test: ${relatedTestDetails.map((test) => test.name).join(', ')}${relatedTestsTruncated ? ` (and ${relatedTests.length - relatedTestDetails.length} more; details truncated)` : ''}.`,
      source: `tests:${relatedTestDetails.map((test) => test.name).join(',')}`,
      origin: 'derived'
    });
  } else if (testOverlapAvailable) {
    evidence.push({
      kind: 'no-test-overlap',
      signal: 'testOverlap',
      state: 'observed_no_overlap',
      weight: 0,
      text: 'No failing test was directly connected to this commit.',
      source: 'tests.relatedFiles+commit.changedFiles',
      origin: 'derived'
    });
  } else {
    evidence.push({
      kind: 'missing-test-overlap',
      signal: 'testOverlap',
      state: 'unknown',
      weight: 0,
      text: missingTestOverlapText({ hasChangedFiles, failingTests, missingRelatedTests }),
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
        text: `Dependency blast-radius signal is ${(factors.dependencyImpact * 100).toFixed(0)}% (${dependencyOrigin === 'derived' ? 'derived from changed dependency files and diff statistics' : 'provided input'}).`,
        source: dependency.source || 'commit.dependencyImpact',
        origin: dependencyOrigin,
        ...(dependency.details ? { details: dependency.details } : {})
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
    signalAvailability,
    signalSources,
    factors,
    contributions,
    dependencyImpactDetails: dependency.details,
    signalDetails,
    evidence,
    ...(relatedTestsTruncated ? { relatedTestCount: relatedTests.length, relatedTestsTruncated: true } : {}),
    relatedTests: relatedTestDetails.map((test) => ({
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
      if (commit.diffLines !== undefined
        && (!Number.isFinite(commit.diffLines) || commit.diffLines < 0)) {
        add(`${path}.diffLines`, 'diffLines must be a non-negative number.');
      }
      if (commit.diffStats !== undefined && !Array.isArray(commit.diffStats)) {
        add(`${path}.diffStats`, 'diffStats must be an array.');
      } else if (Array.isArray(commit.diffStats) && commit.diffStats.length > MAX_FILES) {
        add(`${path}.diffStats`, `diffStats must contain at most ${MAX_FILES} entries.`);
      }
      if (commit.dependencyImpactDetails !== undefined
        && (!commit.dependencyImpactDetails
          || typeof commit.dependencyImpactDetails !== 'object'
          || Array.isArray(commit.dependencyImpactDetails))) {
        add(`${path}.dependencyImpactDetails`, 'dependencyImpactDetails must be an object.');
      } else if (commit.dependencyImpactDetails) {
        for (const field of ['dependencyFiles', 'manifestFiles', 'lockfiles', 'dependencyFileDetails']) {
          const values = commit.dependencyImpactDetails[field];
          if (values !== undefined && !Array.isArray(values)) {
            add(`${path}.dependencyImpactDetails.${field}`, `${field} must be an array.`);
          } else if (Array.isArray(values) && values.length > MAX_DEPENDENCY_DETAIL_FILES) {
            add(`${path}.dependencyImpactDetails.${field}`, `${field} must contain at most ${MAX_DEPENDENCY_DETAIL_FILES} entries.`);
          }
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
  const context = scoringContext(input);
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
    .map((commit) => scoreCommit(commit, input, deploymentMatches, context))
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
  const untimestampedFailedTests = (input.tests ?? [])
    .filter((test) => test.status === 'failed' && test.timestamp === undefined);
  if (untimestampedFailedTests.length) {
    warnings.push(
      `${untimestampedFailedTests.length} failed test result${untimestampedFailedTests.length === 1 ? '' : 's'} `
      + 'lack a source timestamp and were not placed on the timeline; no timestamp was inferred.'
    );
  }
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
