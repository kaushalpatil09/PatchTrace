import { createHash } from 'node:crypto';
import { enrichIncidentFromRepository } from './git-adapter.mjs';
import { parseDeploymentCsv, parseJunitXml, validateIncident } from './analysis.mjs';

const SUPPORTED_SCHEMA_VERSION = 1;
const INGESTION_VERSION = '1';

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function artifact({ id, kind, sourcePath, content, parser, ingestedAt }) {
  return {
    id,
    kind,
    sourcePath: sourcePath || null,
    sha256: sha256(content),
    parser,
    parserVersion: INGESTION_VERSION,
    ingestedAt
  };
}

function cloneBundle(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Bundle JSON must contain an object at the root.');
  }
  return structuredClone(input);
}

function ensureArray(bundle, field, sourceLabel) {
  if (bundle[field] === undefined) bundle[field] = [];
  if (!Array.isArray(bundle[field])) {
    throw new Error(`${field} must be an array before importing ${sourceLabel}.`);
  }
  return bundle[field];
}

function deploymentRowsForBundle(rows, environment) {
  return rows.map((deployment) => {
    if (deployment.environment === 'unknown' && typeof environment === 'string' && environment.trim()) {
      return { ...deployment, environment };
    }
    return deployment;
  });
}

function junitRowsForBundle(rows) {
  return rows.map((result) => ({
    name: result.name,
    status: result.status,
    ...(result.timestamp !== undefined ? { timestamp: result.timestamp } : {}),
    ...(result.relatedFiles?.length ? { relatedFiles: [...result.relatedFiles] } : {}),
    ...(result.errorSignature ? { errorSignature: result.errorSignature } : {})
  }));
}

function invalidBundleError(result) {
  const summary = result.errors
    .map((error) => `${error.path || 'bundle'}: ${error.message}`)
    .join('; ');
  const error = new Error(`Invalid ingested incident bundle: ${summary}`);
  error.code = 'invalid_bundle';
  error.errors = result.errors;
  return error;
}

/**
 * Apply ingestion overrides and parser output without mutating the caller's object.
 * The returned object is not considered ready to write until validation succeeds.
 */
export function normalizeIncidentBundle(input, {
  deploymentsCsv,
  junitXml,
  incidentStart,
  environment
} = {}) {
  const bundle = cloneBundle(input);

  if (bundle.schemaVersion === undefined) bundle.schemaVersion = SUPPORTED_SCHEMA_VERSION;
  if (bundle.commits === undefined) bundle.commits = [];
  if (incidentStart !== undefined) bundle.incidentStart = incidentStart;
  if (environment !== undefined) bundle.environment = environment;

  if (deploymentsCsv !== undefined) {
    let deployments;
    try {
      deployments = parseDeploymentCsv(deploymentsCsv);
    } catch (error) {
      throw new Error(`Could not parse deployment CSV: ${error.message}`);
    }
    const existing = ensureArray(bundle, 'deployments', 'deployment CSV');
    bundle.deployments = [...existing, ...deploymentRowsForBundle(deployments, bundle.environment)];
  }

  if (junitXml !== undefined) {
    let tests;
    try {
      tests = parseJunitXml(junitXml);
    } catch (error) {
      throw new Error(`Could not parse JUnit XML: ${error.message}`);
    }
    const existing = ensureArray(bundle, 'tests', 'JUnit XML');
    bundle.tests = [...existing, ...junitRowsForBundle(tests)];
  }

  return bundle;
}

/**
 * Build and validate a local incident bundle, optionally enriching commits from Git.
 * Repository provenance is returned for callers that want to display it, while the
 * persisted bundle stays on the existing incident-bundle v1 contract.
 */
export async function buildIngestedBundle(input, {
  deploymentsCsv,
  deployments,
  junitXml,
  junit,
  incidentStart,
  environment,
  repoPath,
  repo,
  maxCommits,
  bundleText,
  bundleSourcePath,
  deploymentsSourcePath,
  junitSourcePath,
  ingestedAt = new Date().toISOString()
} = {}) {
  const bundle = normalizeIncidentBundle(input, {
    deploymentsCsv: deploymentsCsv ?? deployments,
    junitXml: junitXml ?? junit,
    incidentStart,
    environment
  });

  const repository = repoPath ?? repo;
  let prepared = bundle;
  let provenance = null;
  if (repository) {
    if (typeof prepared.incidentStart !== 'string' || !prepared.incidentStart.trim()) {
      throw new Error('Repository enrichment requires incidentStart; provide it in the bundle or with --incident-start.');
    }
    const enriched = await enrichIncidentFromRepository(prepared, {
      repoPath: repository,
      ...(maxCommits === undefined ? {} : { maxCommits })
    });
    prepared = enriched.input;
    provenance = enriched.provenance;
  }

  const validation = validateIncident(prepared);
  if (!validation.valid) throw invalidBundleError(validation);

  const artifacts = [];
  if (bundleText !== undefined) {
    artifacts.push(artifact({
      id: 'incident-bundle',
      kind: 'incident_bundle',
      sourcePath: bundleSourcePath,
      content: bundleText,
      parser: 'json',
      ingestedAt
    }));
  }
  if (deploymentsCsv !== undefined) {
    artifacts.push(artifact({
      id: 'deployments',
      kind: 'deployment_csv',
      sourcePath: deploymentsSourcePath,
      content: deploymentsCsv,
      parser: 'patchtrace-deployment-csv',
      ingestedAt
    }));
  }
  if (junitXml !== undefined) {
    artifacts.push(artifact({
      id: 'junit',
      kind: 'junit_xml',
      sourcePath: junitSourcePath,
      content: junitXml,
      parser: 'patchtrace-junit-xml',
      ingestedAt
    }));
  }
  const ingestion = {
    ingestedAt,
    parserVersion: INGESTION_VERSION,
    artifacts
  };
  const outputBundle = {
    ...prepared,
    provenance: {
      ...(provenance || {}),
      ...(prepared.provenance && typeof prepared.provenance === 'object' ? prepared.provenance : {}),
      ingestion
    }
  };
  return {
    bundle: outputBundle,
    provenance: {
      ...(provenance || {}),
      ingestion
    }
  };
}

export async function ingestIncidentBundle(input, options = {}) {
  const result = await buildIngestedBundle(input, options);
  return result.bundle;
}

export const ingestBundle = ingestIncidentBundle;
