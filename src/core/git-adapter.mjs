import { deriveDependencyImpact, dependencyFileInfo, resolveCommitSha } from './analysis.mjs';
import { runCommand, assertSupportedRepository, repositorySnapshot } from './verification.mjs';

const MARKER = '--PATCHTRACE--';
const DEFAULT_MAX_COMMITS = 200;
const MAX_COMMITS = 500;
const DEFAULT_MAX_CHANGED_FILES = 5000;
const MAX_CHANGED_FILES = 5000;
const DEFAULT_MAX_DIFF_LINES = 100_000;
const MAX_DIFF_LINES = 1_000_000;
const DIFF_RISK_SATURATION_LINES = 1000;
const MAX_DEPENDENCY_DETAIL_FILES = 100;
const OUTPUT_TRUNCATION_MARKER = '[output truncated]';

function clamp(value) {
  return Math.min(1, Math.max(0, value));
}

const ISO_WITH_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

function diffRiskForLines(lines) {
  return clamp(Math.log1p(lines) / Math.log1p(DIFF_RISK_SATURATION_LINES));
}

function validateLimit(value, name, maximum) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

export async function readRepositoryHistory({
  repoPath,
  since,
  until,
  maxCommits = DEFAULT_MAX_COMMITS,
  maxChangedFiles = DEFAULT_MAX_CHANGED_FILES,
  maxDiffLines = DEFAULT_MAX_DIFF_LINES
} = {}) {
  if (typeof repoPath !== 'string' || !repoPath) throw new Error('repoPath is required.');
  validateLimit(maxCommits, 'maxCommits', MAX_COMMITS);
  validateLimit(maxChangedFiles, 'maxChangedFiles', MAX_CHANGED_FILES);
  validateLimit(maxDiffLines, 'maxDiffLines', MAX_DIFF_LINES);
  for (const [label, value] of [['since', since], ['until', until]]) {
    if (value !== undefined && Number.isNaN(Date.parse(value))) {
      throw new Error(`${label} must be a valid date.`);
    }
  }

  await assertSupportedRepository(repoPath);
  const args = [
    'log',
    `--max-count=${maxCommits + 1}`,
    '--numstat',
    '--no-renames',
    '--diff-merges=first-parent',
    `--format=${MARKER}%H%x00%cI%x00%s`,
    '--'
  ];
  if (since) args.splice(2, 0, `--since=${since}`);
  if (until) args.splice(2, 0, `--until=${until}`);

  const result = await runCommand(['git', '-c', 'color.ui=false', '-c', 'core.quotepath=false', ...args], repoPath, 30_000);
  if (result.status !== 'passed') {
    throw new Error(`Could not read Git history: ${result.stderr.trim() || result.error || 'git log failed'}`);
  }

  const commits = [];
  let current = null;
  const outputTruncated = result.stdout.includes(OUTPUT_TRUNCATION_MARKER);

  const finish = () => {
    if (!current) return;
    const changedFiles = [...new Set(current.changedFiles)];
    const diffStats = [...new Map(
      [...current.diffStats, ...current.dependencyStats].map((stat) => [stat.path, stat])
    ).values()];
    const dependencyFiles = current.dependencyFiles;
    const dependency = deriveDependencyImpact({
      changedFiles: [...changedFiles, ...dependencyFiles.map((file) => file.path)],
      diffStats,
      diffLines: current.diffLines,
      diffRisk: diffRiskForLines(current.diffLines),
      changedFilesTruncated: current.changedFilesTruncated,
      diffLinesTruncated: current.diffLinesTruncated,
      diffOutputTruncated: outputTruncated
    });
    const dependencyDetails = dependencyFiles.length
      ? {
          ...dependency.details,
          dependencyFiles: dependencyFiles.map((file) => file.path).slice(0, MAX_DEPENDENCY_DETAIL_FILES),
          dependencyFileDetails: dependencyFiles.slice(0, MAX_DEPENDENCY_DETAIL_FILES)
        }
      : dependency.details;
    const dependencyFields = dependency.available
      ? {
          dependencyImpact: dependency.value,
          dependencyImpactSource: dependency.source,
          dependencyImpactDetails: dependencyDetails
        }
      : { dependencyImpactDetails: dependencyDetails };
    commits.push({
      sha: current.sha,
      timestamp: current.timestamp,
      message: current.message || `Commit ${current.sha.slice(0, 7)}`,
      changedFiles,
      diffRisk: diffRiskForLines(current.diffLines),
      diffRiskSource: 'derived:git',
      ...dependencyFields,
      diffLines: current.diffLines,
      diffStats,
      ...(current.changedFilesTruncated ? { changedFilesTruncated: true } : {}),
      ...(current.diffLinesTruncated ? { diffLinesTruncated: true } : {}),
      ...(outputTruncated ? { diffOutputTruncated: true } : {}),
      ...(current.changedFilesTruncated || current.diffLinesTruncated || outputTruncated
        ? { truncated: true }
        : {})
    });
    current = null;
  };

  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.startsWith(MARKER)) {
      finish();
      const [sha, timestamp, message] = line.slice(MARKER.length).split('\0');
      if (!sha || !timestamp) continue;
      current = {
        sha,
        timestamp,
        message,
        changedFiles: [],
        diffStats: [],
        dependencyStats: [],
        dependencyFiles: [],
        diffLines: 0,
        changedFilesTruncated: false,
        diffLinesTruncated: false
      };
      continue;
    }
    if (!current || !line.trim()) continue;
    const [added, deleted, ...pathParts] = line.split('\t');
    const path = pathParts.join('\t').trim();
    if (!path) continue;
    const normalizedPath = path.replaceAll('\\', '/');
    const additions = Number(added);
    const deletions = Number(deleted);
    const changedLines = (Number.isFinite(additions) && additions >= 0 ? additions : 0)
      + (Number.isFinite(deletions) && deletions >= 0 ? deletions : 0);
    const remainingDiffLines = Math.max(0, maxDiffLines - current.diffLines);
    const observedChangedLines = Math.min(changedLines, remainingDiffLines);
    if (current.changedFiles.length < maxChangedFiles) {
      current.changedFiles.push(normalizedPath);
      current.diffStats.push({
        path: normalizedPath,
        additions: Number.isFinite(additions) && additions >= 0 ? additions : 0,
        deletions: Number.isFinite(deletions) && deletions >= 0 ? deletions : 0,
        changedLines: observedChangedLines
      });
    } else {
      current.changedFilesTruncated = true;
    }

    const dependencyInfo = dependencyFileInfo(normalizedPath);
    if (dependencyInfo && !current.dependencyFiles.some((file) => file.path === dependencyInfo.path)
      && current.dependencyFiles.length < MAX_DEPENDENCY_DETAIL_FILES) {
      current.dependencyFiles.push(dependencyInfo);
      current.dependencyStats.push({
        path: normalizedPath,
        additions: Number.isFinite(additions) && additions >= 0 ? additions : 0,
        deletions: Number.isFinite(deletions) && deletions >= 0 ? deletions : 0,
        changedLines: observedChangedLines
      });
    }

    if (changedLines > remainingDiffLines) {
      current.diffLines = maxDiffLines;
      current.diffLinesTruncated = true;
    } else {
      current.diffLines += changedLines;
    }
  }
  finish();

  const commitTruncated = commits.length > maxCommits;
  const changedFilesTruncated = commits.some((commit) => commit.changedFilesTruncated);
  const diffLinesTruncated = commits.some((commit) => commit.diffLinesTruncated);
  const truncated = commitTruncated || changedFilesTruncated || diffLinesTruncated || outputTruncated;
  const limits = {
    maxCommits,
    maxChangedFiles,
    maxDiffLines,
    commitsRead: Math.min(commits.length, maxCommits),
    commitsTruncated: commitTruncated,
    changedFilesTruncated,
    diffLinesTruncated,
    diffOutputTruncated: outputTruncated,
    reasons: [
      ...(commitTruncated ? ['commit limit exceeded'] : []),
      ...(changedFilesTruncated ? ['changed-file limit exceeded'] : []),
      ...(diffLinesTruncated ? ['diff-line limit exceeded'] : []),
      ...(outputTruncated ? ['Git output was truncated before parsing completed'] : [])
    ]
  };

  return {
    commits: commits.slice(0, maxCommits),
    truncated,
    limits,
    truncation: limits
  };
}

export async function readRepositoryCommits(options = {}) {
  const { commits } = await readRepositoryHistory(options);
  return commits;
}

export async function repositoryProvenance(repoPath) {
  const snapshot = await repositorySnapshot(repoPath);
  if (!snapshot.valid) throw new Error('The path is not a usable Git repository with a HEAD commit.');
  const branch = await runCommand(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], repoPath, 10_000);
  return {
    repository: {
      head: snapshot.head,
      dirty: snapshot.dirty,
      branch: branch.status === 'passed' ? branch.stdout.trim() : null
    }
  };
}

export async function enrichIncidentFromRepository(input, {
  repoPath,
  maxCommits = DEFAULT_MAX_COMMITS,
  maxChangedFiles = DEFAULT_MAX_CHANGED_FILES,
  maxDiffLines = DEFAULT_MAX_DIFF_LINES
} = {}) {
  if (!input || typeof input !== 'object') throw new Error('Incident bundle must be an object.');
  if (typeof repoPath !== 'string' || !repoPath) throw new Error('repoPath is required.');
  if (typeof input.incidentStart !== 'string' || !ISO_WITH_ZONE.test(input.incidentStart)) {
    throw new Error('incidentStart must include a timezone.');
  }
  const incidentMs = Date.parse(input.incidentStart);
  if (Number.isNaN(incidentMs)) throw new Error('incidentStart must be a valid date.');
  const windowMinutes = input.candidateWindowMinutes ?? 24 * 60;
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) {
    throw new Error('candidateWindowMinutes must be a positive number.');
  }

  const since = new Date(incidentMs - windowMinutes * 60_000).toISOString();
  const until = new Date(incidentMs).toISOString();
  const repositoryHistory = await readRepositoryHistory({
    repoPath,
    since,
    until,
    maxCommits,
    maxChangedFiles,
    maxDiffLines
  });
  const repositoryCommits = repositoryHistory.commits;
  const repositoryShas = repositoryCommits.map((commit) => commit.sha);
  const byFullSha = new Map(repositoryCommits.map((commit) => [commit.sha.toLowerCase(), commit]));
  const findRepositoryCommit = (sha) => {
    const resolution = resolveCommitSha(sha, repositoryShas);
    if (resolution.status !== 'matched') return { status: resolution.status, commit: null };
    return {
      status: 'matched',
      commit: byFullSha.get(resolution.match.toLowerCase()) ?? null
    };
  };
  const bundleCommits = Array.isArray(input.commits) ? input.commits : [];
  let matchedBundleCommits = 0;
  const ambiguousBundleShas = [];
  const unresolvedBundleShas = [];

  const commits = bundleCommits.length
    ? bundleCommits.map((commit) => {
        const lookup = findRepositoryCommit(commit.sha);
        if (lookup.status === 'ambiguous') {
          ambiguousBundleShas.push(commit.sha);
          return commit;
        }
        if (lookup.status === 'unresolved') {
          unresolvedBundleShas.push(commit.sha);
          return commit;
        }
        matchedBundleCommits += 1;
        const repositoryCommit = lookup.commit;
        return {
          ...commit,
          timestamp: repositoryCommit.timestamp || commit.timestamp,
          message: commit.message || repositoryCommit.message,
          changedFiles: repositoryCommit.changedFiles.length
            ? repositoryCommit.changedFiles
            : commit.changedFiles,
          diffRisk: commit.diffRisk === undefined ? repositoryCommit.diffRisk : commit.diffRisk,
          diffRiskSource: commit.diffRisk === undefined
            ? repositoryCommit.diffRiskSource
            : commit.diffRiskSource,
          dependencyImpact: commit.dependencyImpact === undefined
            ? repositoryCommit.dependencyImpact
            : commit.dependencyImpact,
          dependencyImpactSource: commit.dependencyImpact === undefined
            ? repositoryCommit.dependencyImpactSource
            : commit.dependencyImpactSource,
          dependencyImpactDetails: commit.dependencyImpact === undefined
            ? repositoryCommit.dependencyImpactDetails
            : commit.dependencyImpactDetails,
          ...(repositoryCommit.diffLines === undefined ? {} : { diffLines: repositoryCommit.diffLines }),
          ...(repositoryCommit.diffStats === undefined ? {} : { diffStats: repositoryCommit.diffStats }),
          ...(repositoryCommit.changedFilesTruncated ? { changedFilesTruncated: true } : {}),
          ...(repositoryCommit.diffLinesTruncated ? { diffLinesTruncated: true } : {}),
          ...(repositoryCommit.diffOutputTruncated ? { diffOutputTruncated: true } : {}),
          ...(repositoryCommit.truncated ? { truncated: true } : {})
        };
      })
    : repositoryCommits;

  const provenance = await repositoryProvenance(repoPath);
  return {
    input: { ...input, commits },
    provenance: {
      ...provenance,
      enrichment: {
        commitsFromRepository: repositoryCommits.length,
        commitsFromBundle: bundleCommits.length,
        matchedBundleCommits,
        ambiguousBundleCommits: ambiguousBundleShas.length,
        unresolvedBundleCommits: unresolvedBundleShas.length,
        ambiguousBundleShas,
        unresolvedBundleShas,
        truncated: repositoryHistory.truncated,
        limits: repositoryHistory.limits,
        truncation: repositoryHistory.truncation,
        windowMinutes,
        since,
        until
      }
    }
  };
}
