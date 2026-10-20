import { resolveCommitSha } from './analysis.mjs';
import { runCommand, assertSupportedRepository, repositorySnapshot } from './verification.mjs';

const MARKER = '--PATCHTRACE--';
const DEFAULT_MAX_COMMITS = 200;
const MAX_COMMITS = 500;
const MAX_DIFF_LINES = 1000;

function clamp(value) {
  return Math.min(1, Math.max(0, value));
}

const ISO_WITH_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

function diffRiskForLines(lines) {
  return clamp(Math.log1p(lines) / Math.log1p(MAX_DIFF_LINES));
}

export async function readRepositoryHistory({
  repoPath,
  since,
  until,
  maxCommits = DEFAULT_MAX_COMMITS
} = {}) {
  if (typeof repoPath !== 'string' || !repoPath) throw new Error('repoPath is required.');
  if (!Number.isInteger(maxCommits) || maxCommits < 1 || maxCommits > MAX_COMMITS) {
    throw new Error(`maxCommits must be an integer between 1 and ${MAX_COMMITS}.`);
  }
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

  const finish = () => {
    if (!current) return;
    commits.push({
      sha: current.sha,
      timestamp: current.timestamp,
      message: current.message || `Commit ${current.sha.slice(0, 7)}`,
      changedFiles: [...new Set(current.changedFiles)],
      diffRisk: diffRiskForLines(current.diffLines),
      diffRiskSource: 'derived:git'
    });
    current = null;
  };

  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.startsWith(MARKER)) {
      finish();
      const [sha, timestamp, message] = line.slice(MARKER.length).split('\0');
      if (!sha || !timestamp) continue;
      current = { sha, timestamp, message, changedFiles: [], diffLines: 0 };
      continue;
    }
    if (!current || !line.trim()) continue;
    const [added, deleted, ...pathParts] = line.split('\t');
    const path = pathParts.join('\t').trim();
    if (!path) continue;
    current.changedFiles.push(path);
    const additions = Number(added);
    const deletions = Number(deleted);
    if (Number.isFinite(additions)) current.diffLines += additions;
    if (Number.isFinite(deletions)) current.diffLines += deletions;
  }
  finish();

  return {
    commits: commits.slice(0, maxCommits),
    truncated: commits.length > maxCommits
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
  maxCommits = DEFAULT_MAX_COMMITS
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
  const repositoryHistory = await readRepositoryHistory({ repoPath, since, until, maxCommits });
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
          diffRisk: repositoryCommit.diffRisk,
          diffRiskSource: repositoryCommit.diffRiskSource
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
        windowMinutes,
        since,
        until
      }
    }
  };
}
