import { analyzeIncident } from './analysis.mjs';

const compareSha = (a, b) => a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0;

/** Offline labeled-case evaluation. Scores measure this dataset only, not causation. */
export function evaluateIncidents(cases) {
  if (!Array.isArray(cases) || !cases.length) throw new Error('At least one labeled case is required.');
  const ids = new Set();
  const rows = cases.map(item => {
    if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id)
      || !['development', 'holdout'].includes(item.split) || typeof item.synthetic !== 'boolean'
      || !Array.isArray(item.expectedShas) || !item.expectedShas.length
      || item.expectedShas.some(sha => typeof sha !== 'string' || !/^[a-f0-9]{4,64}$/i.test(sha))) {
      throw new Error('Each case requires a unique id, split, synthetic flag and exact expectedShas.');
    }
    ids.add(item.id);
    const analysis = analyzeIncident(item.bundle);
    const candidates = analysis.suspects;
    const expected = new Set(item.expectedShas.map(sha => sha.toLowerCase()));
    if ([...expected].some(sha => !(item.bundle.commits ?? []).some(commit => commit.sha.toLowerCase() === sha))) {
      throw new Error('Expected SHAs must identify commits in the labeled bundle.');
    }
    const rankers = {
      patchtrace: candidates,
      latestEligible: [...candidates].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp) || compareSha(a, b)),
      deployedCommit: [...candidates].filter(candidate => candidate.signalAvailability.temporal)
        .sort((a, b) => b.factors.temporal - a.factors.temporal || compareSha(a, b)),
      fileOverlap: [...candidates].sort((a, b) => b.factors.fileOverlap - a.factors.fileOverlap || compareSha(a, b))
    };
    return { id: item.id, split: item.split, synthetic: item.synthetic,
      abstained: !candidates.length || candidates[0].confidence === 'low',
      ranks: Object.fromEntries(Object.entries(rankers).map(([name, ranked]) => {
        const index = ranked.findIndex(candidate => expected.has(candidate.sha.toLowerCase()));
        return [name, index < 0 ? null : index + 1];
      })) };
  });
  const summarize = subset => ({ size: subset.length,
    coverage: subset.length ? subset.filter(row => !row.abstained).length / subset.length : null,
    abstentionRate: subset.length ? subset.filter(row => row.abstained).length / subset.length : null,
    methods: Object.fromEntries(['patchtrace', 'latestEligible', 'deployedCommit', 'fileOverlap'].map(name => [name, {
      top1: subset.length ? subset.filter(row => row.ranks[name] === 1).length / subset.length : null,
      top3: subset.length ? subset.filter(row => row.ranks[name] !== null && row.ranks[name] <= 3).length / subset.length : null,
      mrr: subset.length ? subset.reduce((sum, row) => sum + (row.ranks[name] ? 1 / row.ranks[name] : 0), 0) / subset.length : null
    }])) });
  return { schemaVersion: 1, externalValidation: 'OPEN',
    methodology: 'Exact labeled SHA matching; low confidence abstains. Rank metrics include abstained cases. Deployment baseline orders eligible candidates by temporal factor. Holdout is reported separately; synthetic cases do not validate real-world effectiveness.',
    all: summarize(rows), development: summarize(rows.filter(row => row.split === 'development')),
    holdout: summarize(rows.filter(row => row.split === 'holdout')), rows,
    failureCases: rows.filter(row => row.ranks.patchtrace !== 1).map(row => row.id) };
}
