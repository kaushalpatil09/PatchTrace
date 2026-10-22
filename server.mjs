import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { access, readFile, realpath } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { validateIncident, verifyFixture } from './src/core/analysis.mjs';
import { analyzeInWorker } from './src/analysis-service.mjs';
import { buildReport } from './src/core/report.mjs';
import { PATH_REPLACEMENT, scrubPathText } from './src/core/redaction.mjs';
import { runCommand, sweepStaleWorkspaces, verifyRollback } from './src/core/verification.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(root, 'public');
const fixturePath = join(root, 'fixtures', 'sample-incident', 'manifest.json');
const packagePath = join(root, 'package.json');
const COOKIE_NAME = 'patchtrace_session';
const API_VERSION = 1;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);
const toolVersionPromise = readFile(packagePath, 'utf8')
  .then((text) => JSON.parse(text).version ?? '0.1.0')
  .catch(() => '0.1.0');

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png'
};

const securityHeaders = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'cross-origin-resource-policy': 'same-origin',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
};

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function addContractError(errors, path, message) {
  errors.push({ path, message });
}

function validateAnalysisShape(value, prefix = 'analysis', { output = false } = {}) {
  const errors = [];
  if (!isObject(value)) {
    addContractError(errors, prefix, `${prefix} must be an object.`);
    return errors;
  }
  if (value.schemaVersion !== 1) addContractError(errors, `${prefix}.schemaVersion`, `${prefix}.schemaVersion must be 1.`);
  if (!isObject(value.incident)) {
    addContractError(errors, `${prefix}.incident`, `${prefix}.incident must be an object.`);
  } else {
    for (const field of ['title', 'environment', 'incidentStart']) {
      if (typeof value.incident[field] !== 'string' || !value.incident[field].trim()) {
        addContractError(errors, `${prefix}.incident.${field}`, `${field} is required.`);
      }
    }
  }
  if (!Array.isArray(value.suspects)) addContractError(errors, `${prefix}.suspects`, `${prefix}.suspects must be an array.`);
  if (!Array.isArray(value.timeline)) addContractError(errors, `${prefix}.timeline`, `${prefix}.timeline must be an array.`);
  if (!Number.isFinite(value.candidateWindowMinutes) || value.candidateWindowMinutes <= 0) {
    addContractError(errors, `${prefix}.candidateWindowMinutes`, 'candidateWindowMinutes must be a positive number.');
  }
  if (output) {
    if (!isObject(value.weights)) addContractError(errors, `${prefix}.weights`, `${prefix}.weights must be an object.`);
    if (!Array.isArray(value.warnings)) addContractError(errors, `${prefix}.warnings`, `${prefix}.warnings must be an array.`);
    if (!Number.isSafeInteger(value.excludedCandidateCount) || value.excludedCandidateCount < 0) {
      addContractError(errors, `${prefix}.excludedCandidateCount`, 'excludedCandidateCount must be a non-negative integer.');
    }
    if (!isObject(value.verification)) addContractError(errors, `${prefix}.verification`, `${prefix}.verification must be an object.`);
  }
  return errors;
}

function validateVerifyRequest(body) {
  const errors = [];
  if (!isObject(body)) {
    addContractError(errors, '', 'Verification request must be a JSON object.');
    return errors;
  }
  if (typeof body.sha !== 'string' || !/^[0-9a-f]{4,64}$/i.test(body.sha)) {
    addContractError(errors, 'sha', 'sha must be a Git commit SHA.');
  }

  if (body.repoPath !== undefined) {
    if (typeof body.repoPath !== 'string' || !body.repoPath.trim()) {
      addContractError(errors, 'repoPath', 'repoPath must be a non-empty string.');
    }
    if (body.testCommand !== undefined
      && (!Array.isArray(body.testCommand) || !body.testCommand.length
        || body.testCommand.some((part) => typeof part !== 'string' || !part || part.includes('\0')))) {
      addContractError(errors, 'testCommand', 'testCommand must be a non-empty argv array of strings without empty or null-containing arguments.');
    }
    if (body.timeoutMs !== undefined
      && (!Number.isFinite(body.timeoutMs) || body.timeoutMs < 1 || body.timeoutMs > 600_000)) {
      addContractError(errors, 'timeoutMs', 'timeoutMs must be between 1 and 600000.');
    }
    if (body.mainline !== undefined && (!Number.isInteger(body.mainline) || body.mainline < 1)) {
      addContractError(errors, 'mainline', 'mainline must be a positive integer.');
    }
  } else {
    if (!isObject(body.analysis)) addContractError(errors, 'analysis', 'Fixture verification requires analysis and sha.');
  }
  return errors;
}

function validateCancelRequest(body) {
  if (body === undefined || body === null) return [];
  return isObject(body) ? [] : [{ path: '', message: 'Cancellation request must be a JSON object.' }];
}

function validateHealthResponse(value) {
  const errors = [];
  if (!isObject(value)) return [{ path: '', message: 'Health response must be an object.' }];
  if (!['ok', 'degraded'].includes(value.status)) addContractError(errors, 'status', 'status must be ok or degraded.');
  for (const field of ['ready', 'tempWritable', 'realVerificationEnabled', 'verificationInProgress']) {
    if (typeof value[field] !== 'boolean') addContractError(errors, field, `${field} must be a boolean.`);
  }
  for (const field of ['version', 'node', 'platform']) {
    if (typeof value[field] !== 'string' || !value[field]) addContractError(errors, field, `${field} must be a non-empty string.`);
  }
  if (!isObject(value.git)) {
    addContractError(errors, 'git', 'git must be an object.');
  } else {
    if (typeof value.git.available !== 'boolean') addContractError(errors, 'git.available', 'git.available must be a boolean.');
    if (value.git.version !== null && typeof value.git.version !== 'string') {
      addContractError(errors, 'git.version', 'git.version must be a string or null.');
    }
  }
  return errors;
}

function validateVerificationResponse(value) {
  const errors = [];
  if (!isObject(value)) return [{ path: '', message: 'Verification response must be an object.' }];
  if (typeof value.status !== 'string' || !value.status) addContractError(errors, 'status', 'status must be a non-empty string.');
  if (value.outcome !== undefined && (typeof value.outcome !== 'string' || !value.outcome)) {
    addContractError(errors, 'outcome', 'outcome must be a non-empty string when present.');
  }
  if (!['fixture', 'live'].includes(value.source)) addContractError(errors, 'source', 'source must be fixture or live.');
  return errors;
}

function validateReportResponse(value) {
  const errors = [];
  if (!isObject(value)) return [{ path: '', message: 'Report response must be an object.' }];
  if (value.schemaVersion !== 1) addContractError(errors, 'schemaVersion', 'schemaVersion must be 1.');
  if (typeof value.generatedAt !== 'string' || !value.generatedAt) addContractError(errors, 'generatedAt', 'generatedAt must be a non-empty string.');
  if (typeof value.toolVersion !== 'string' || !value.toolVersion) addContractError(errors, 'toolVersion', 'toolVersion must be a non-empty string.');
  errors.push(...validateAnalysisShape(value.analysis, 'analysis', { output: true }));
  if (value.verification !== null && !isObject(value.verification)) addContractError(errors, 'verification', 'verification must be an object or null.');
  if (!isObject(value.provenance)) addContractError(errors, 'provenance', 'provenance must be an object.');
  if (!isObject(value.redaction)) {
    addContractError(errors, 'redaction', 'redaction must be an object.');
  } else {
    if (value.redaction.applied !== true) addContractError(errors, 'redaction.applied', 'redaction.applied must be true.');
    if (!Number.isSafeInteger(value.redaction.matches) || value.redaction.matches < 0) {
      addContractError(errors, 'redaction.matches', 'redaction.matches must be a non-negative integer.');
    }
    if (value.redaction.pathsScrubbed !== undefined
      && (!Number.isSafeInteger(value.redaction.pathsScrubbed) || value.redaction.pathsScrubbed < 0)) {
      addContractError(errors, 'redaction.pathsScrubbed', 'redaction.pathsScrubbed must be a non-negative integer.');
    }
  }
  return errors;
}

function validateSampleResponse(value) {
  return validateIncident(value).errors;
}

function validateApiResponse(route, value) {
  switch (route) {
    case 'health': return validateHealthResponse(value);
    case 'sample': return validateSampleResponse(value);
    case 'analyze': return validateAnalysisShape(value, '', { output: true });
    case 'report': return validateReportResponse(value);
    case 'verify': return validateVerificationResponse(value);
    case 'cancel':
      return isObject(value) && value.cancelled === true
        ? []
        : [{ path: 'cancelled', message: 'cancelled must be true.' }];
    default: return [{ path: '', message: `Unknown API response contract: ${route}.` }];
  }
}

export function validateApiRequest(route, body) {
  let errors;
  switch (route) {
    case 'analyze':
      errors = validateIncident(body).errors;
      break;
    case 'report':
      errors = validateReportRequest(body);
      break;
    case 'verify':
      errors = validateVerifyRequest(body);
      break;
    case 'cancel':
      errors = validateCancelRequest(body);
      break;
    default:
      errors = [{ path: '', message: `Unknown API request contract: ${route}.` }];
  }
  return { valid: errors.length === 0, errors };
}

export { validateApiResponse };

const ERROR_PATH_PATTERN = /(^|[\s("'=,:])((?:[A-Za-z]:[\\/]|\\\\|\/\/|\/|~[\\/]|\$(?:HOME|USERPROFILE)[\\/]|%(?:HOME|USERPROFILE)%[\\/]|%HOMEDRIVE%%HOMEPATH%[\\/])[^\r\n"'<>|;,)]*)/gi;

function scrubErrorText(value, key = '') {
  let text = String(value ?? '');
  text = text.replace(ERROR_PATH_PATTERN, (match, boundary, path, offset, whole) => {
    const before = whole.slice(0, offset + boundary.length);
    const scheme = before.match(/([A-Za-z][A-Za-z0-9+.-]*):$/u)?.[1];
    if (path.startsWith('//') && /^(?:https?|ftp)$/i.test(scheme || '')) {
      return match;
    }
    return `${boundary}${PATH_REPLACEMENT}`;
  });
  return scrubPathText(text, { key }).text;
}

function scrubApiValue(value, seen = new WeakSet(), key = '') {
  if (typeof value === 'string') return scrubErrorText(value, key);
  if (Array.isArray(value)) return value.map((item) => scrubApiValue(item, seen, key));
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => {
      const safeKey = scrubErrorText(childKey);
      return [safeKey, scrubApiValue(child, seen, childKey)];
    }));
  }
  return value;
}

function sendJson(response, status, payload, extraHeaders = {}) {
  const body = JSON.stringify({ ...payload, apiVersion: API_VERSION });
  response.writeHead(status, {
    ...securityHeaders,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...extraHeaders
  });
  response.end(body);
}

function sendError(response, status, code, message, details) {
  const safeMessage = scrubErrorText(message || 'The request could not be completed.');
  const safeDetails = details === undefined ? undefined : scrubApiValue(details);
  sendJson(response, status, {
    error: {
      code,
      message: safeMessage,
      ...(safeDetails !== undefined ? { details: safeDetails } : {})
    }
  });
}

function sendContract(response, status, route, payload, extraHeaders = {}) {
  const errors = validateApiResponse(route, payload);
  if (errors.length) {
    sendError(response, 500, 'internal_contract_error', 'The server produced an invalid API response.');
    return false;
  }
  sendJson(response, status, payload, extraHeaders);
  return true;
}

function parseCookies(header = '') {
  const cookies = {};
  for (const part of String(header).split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    if (!key) continue;
    const value = part.slice(separator + 1).trim();
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

function tokenMatches(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function requestToken(request, token) {
  const authorization = request.headers.authorization;
  const bearer = typeof authorization === 'string' ? authorization.match(/^Bearer\s+(.+)$/i) : null;
  if (bearer) return bearer[1];
  const headerToken = request.headers['x-patchtrace-token'];
  if (typeof headerToken === 'string') return headerToken;
  return parseCookies(request.headers.cookie)[COOKIE_NAME] ?? '';
}

function hostnameOf(value) {
  try {
    return new URL(`http://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function originHost(value) {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

function createAllowedHosts(extraHosts = []) {
  const hosts = new Set(LOCAL_HOSTNAMES);
  for (const host of extraHosts) {
    if (!host) continue;
    const hostname = hostnameOf(host) || hostnameOf(`localhost:${host}`) || host;
    hosts.add(String(hostname).toLowerCase());
  }
  return { hosts };
}

function isHostAllowed(request, allowed) {
  const host = request.headers.host;
  if (!host) return false;
  const hostname = hostnameOf(host);
  return Boolean(hostname && allowed.hosts.has(hostname));
}

function isOriginAllowed(request, allowed) {
  const origin = request.headers.origin;
  if (!origin) return true;
  const host = originHost(origin);
  if (!host) return false;
  if (host !== String(request.headers.host).toLowerCase()) return false;
  const hostname = hostnameOf(host);
  return Boolean(hostname && allowed.hosts.has(hostname));
}

async function readJsonBody(request, limit = MAX_BODY_BYTES, { allowEmpty = false } = {}) {
  const contentType = String(request.headers['content-type'] || '');
  const declaredLength = request.headers['content-length'];
  const hasNoBody = declaredLength === '0'
    || (declaredLength === undefined && !request.headers['transfer-encoding']);
  if (!/^application\/json(?:\s*;|$)/i.test(contentType) && !(allowEmpty && hasNoBody)) {
    const error = new Error('Content-Type must be application/json.');
    error.status = 415;
    error.code = 'unsupported_media_type';
    throw error;
  }
  const declaredBytes = Number(request.headers['content-length'] || 0);
  if (Number.isFinite(declaredBytes) && declaredBytes > limit) {
    const error = new Error(`Request body exceeds the ${limit} byte limit.`);
    error.status = 413;
    error.code = 'body_too_large';
    throw error;
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > limit) {
      request.resume();
      const error = new Error(`Request body exceeds the ${limit} byte limit.`);
      error.status = 413;
      error.code = 'body_too_large';
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('Request body must be valid JSON.');
    error.status = 400;
    error.code = 'invalid_json';
    throw error;
  }
}

async function serveStatic(request, response) {
  const requested = request.url === '/' ? '/index.html' : request.url.split('?')[0];
  let filePath;
  try {
    filePath = normalize(join(publicDir, decodeURIComponent(requested)));
  } catch {
    sendError(response, 400, 'invalid_path', 'Invalid path.');
    return;
  }
  const rootPath = await realpath(publicDir);
  const resolved = await realpath(filePath).catch(() => null);
  if (!resolved || !(resolved === rootPath || resolved.startsWith(rootPath + sep))) {
    sendError(response, 404, 'not_found', 'Not found.');
    return;
  }
  try {
    const file = await readFile(resolved);
    response.writeHead(200, {
      ...securityHeaders,
      'content-type': mimeTypes[extname(resolved)] || 'application/octet-stream',
      'content-length': file.length,
      'cache-control': 'no-cache'
    });
    response.end(file);
  } catch {
    sendError(response, 404, 'not_found', 'Not found.');
  }
}

function verificationErrorResponse(error) {
  if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
    return {
      code: 'invalid_repo',
      message: 'Repository path could not be found.'
    };
  }
  if (error?.code === 'EACCES' || error?.code === 'EPERM') {
    return {
      code: 'invalid_repo',
      message: 'Repository path is not accessible.'
    };
  }
  return {
    code: 'verification_error',
    message: 'Repository verification could not be completed.'
  };
}

function validateReportRequest(body) {
  const errors = [];
  const add = (path, message) => errors.push({ path, message });
  if (!isObject(body)) {
    add('', 'Report request must be a JSON object.');
    return errors;
  }

  errors.push(...validateAnalysisShape(body.analysis));
  if (body.verification !== undefined && body.verification !== null
    && (typeof body.verification !== 'object' || Array.isArray(body.verification))) {
    add('verification', 'verification must be a JSON object or null.');
  }
  if (body.provenance !== undefined
    && (!body.provenance || typeof body.provenance !== 'object' || Array.isArray(body.provenance))) {
    add('provenance', 'provenance must be a JSON object.');
  }
  return errors;
}

export function createPatchTraceServer(options = {}) {
  const token = options.token || process.env.PATCHTRACE_TOKEN || randomBytes(32).toString('hex');
  const enableRealVerification = options.enableRealVerification
    ?? process.env.PATCHTRACE_ENABLE_VERIFY === '1';
  const runVerification = options.runVerification || verifyRollback;
  const extraHosts = (options.allowedHosts || process.env.PATCHTRACE_ALLOWED_HOSTS || '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);
  const allowed = createAllowedHosts(extraHosts);
  let realVerificationInFlight = false;
  let currentAnalysis = null;
  let currentVerification = null;

  // Sweep only marked workspaces older than the stale threshold. This runs in the
  // background so a slow filesystem cannot delay the server from listening.
  void sweepStaleWorkspaces().catch(() => {});

  const server = http.createServer(async (request, response) => {
    try {
      if (!isHostAllowed(request, allowed)) {
        sendError(response, 403, 'host_not_allowed', 'Request Host is not allowed.');
        return;
      }
      if (!isOriginAllowed(request, allowed)) {
        sendError(response, 403, 'origin_not_allowed', 'Request Origin is not allowed.');
        return;
      }

      const pathname = request.url.split('?')[0];
      const authenticated = tokenMatches(requestToken(request, token), token);

      if (request.method === 'GET' && pathname === '/index.html') {
        response.writeHead(302, { ...securityHeaders, location: '/' });
        response.end();
        return;
      }

      if (request.method === 'GET' && pathname === '/') {
        const file = await readFile(join(publicDir, 'index.html'));
        response.writeHead(200, {
          ...securityHeaders,
          'content-type': 'text/html; charset=utf-8',
          'content-length': file.length,
          'cache-control': 'no-cache',
          'set-cookie': `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`
        });
        response.end(file);
        return;
      }

      if (request.method === 'GET' && pathname === '/api/health') {
        const version = await toolVersionPromise;
        const git = await runCommand(['git', '--version'], root, 2_000);
        const gitAvailable = git.status === 'passed';
        const tempWritable = await access(tmpdir(), fsConstants.W_OK).then(() => true, () => false);
        sendContract(response, 200, 'health', {
          status: gitAvailable ? 'ok' : 'degraded',
          ready: gitAvailable && tempWritable,
          version,
          node: process.version,
          platform: process.platform,
          git: {
            available: gitAvailable,
            version: gitAvailable ? git.stdout.trim() : null
          },
          tempWritable,
          realVerificationEnabled: enableRealVerification,
          verificationInProgress: realVerificationInFlight
        });
        return;
      }

      if (pathname.startsWith('/api/') && !authenticated) {
        sendError(response, 401, 'unauthorized', 'A valid PatchTrace session token is required.');
        return;
      }

      if (request.method === 'GET' && pathname === '/api/sample') {
        const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
        sendContract(response, 200, 'sample', fixture);
        return;
      }

      if (request.method === 'POST' && pathname === '/api/analyze') {
        if (currentAnalysis) {
          request.resume();
          sendError(response, 503, 'analysis_busy', 'Another analysis is running. Try again when it finishes.');
          return;
        }
        const controller = new AbortController();
        currentAnalysis = controller;
        const abort = () => { if (!response.writableEnded) controller.abort(); };
        request.once('aborted', abort);
        response.once('close', abort);
        try {
          const input = await readJsonBody(request);
          const validation = validateApiRequest('analyze', input);
          if (!validation.valid) {
            sendError(response, 400, 'invalid_bundle', 'The incident bundle is invalid.', validation.errors);
            return;
          }
          const result = await analyzeInWorker(input, { signal: controller.signal });
          sendContract(response, 200, 'analyze', result);
        } catch (error) {
          if (['analysis_limit', 'analysis_timeout', 'analysis_failed', 'analysis_cancelled'].includes(error.code)) {
            sendError(response, error.code === 'analysis_limit' ? 422 : 503, error.code, error.message);
          } else throw error;
        } finally {
          request.off('aborted', abort);
          response.off('close', abort);
          if (currentAnalysis === controller) currentAnalysis = null;
        }
        return;
      }

      if (request.method === 'POST' && pathname === '/api/report') {
        const body = await readJsonBody(request);
        const validation = validateApiRequest('report', body);
        if (!validation.valid) {
          sendError(response, 400, 'invalid_request', 'Report request does not match the analysis contract.', validation.errors);
          return;
        }
        const report = buildReport({
          analysis: body.analysis,
          verification: body.verification ?? null,
          provenance: body.provenance ?? {},
          generatedAt: new Date().toISOString(),
          toolVersion: await toolVersionPromise
        });
        sendContract(response, 200, 'report', report);
        return;
      }

      if (request.method === 'POST' && pathname === '/api/verify/cancel') {
        const body = await readJsonBody(request, 1024 * 1024, { allowEmpty: true });
        const validation = validateApiRequest('cancel', body);
        if (!validation.valid) {
          sendError(response, 400, 'invalid_request', 'Cancellation request does not match the API contract.', validation.errors);
          return;
        }
        if (!currentVerification) {
          sendError(response, 409, 'no_verification_in_progress', 'There is no real verification run to cancel.');
          return;
        }
        currentVerification.abort();
        sendContract(response, 202, 'cancel', { cancelled: true });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/verify') {
        const body = await readJsonBody(request, 1024 * 1024);
        const validation = validateApiRequest('verify', body);
        if (!validation.valid) {
          sendError(response, 400, 'invalid_request', 'Verification request does not match the API contract.', validation.errors);
          return;
        }

        if (body.repoPath !== undefined) {
          if (!enableRealVerification) {
            sendError(response, 403, 'verify_disabled', 'Real repository verification is disabled. Start the server with PATCHTRACE_ENABLE_VERIFY=1 to enable it.');
            return;
          }
          if (realVerificationInFlight) {
            sendError(response, 409, 'verification_in_progress', 'Another real verification is already running. Wait for it to finish and try again.');
            return;
          }
          let result;
          realVerificationInFlight = true;
          const controller = new AbortController();
          currentVerification = controller;
          const abortOnDisconnect = () => {
            if (!response.writableEnded) controller.abort();
          };
          request.once('aborted', abortOnDisconnect);
          response.once('close', abortOnDisconnect);
          try {
            result = await runVerification({
              repoPath: body.repoPath.trim(),
              candidateSha: body.sha,
              testCommand: body.testCommand,
              timeoutMs: body.timeoutMs,
              mainline: body.mainline,
              signal: controller.signal
            });
          } catch (error) {
            if (controller.signal.aborted) {
              sendError(response, 409, 'verification_cancelled', 'Verification was cancelled.');
            } else {
              const mapped = verificationErrorResponse(error);
              sendError(response, 400, mapped.code, mapped.message);
            }
            return;
          } finally {
            request.off('aborted', abortOnDisconnect);
            response.off('close', abortOnDisconnect);
            realVerificationInFlight = false;
            if (currentVerification === controller) currentVerification = null;
          }
          sendContract(response, 200, 'verify', { ...result, source: 'live' });
          return;
        }

        const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
        const result = verifyFixture({ verification: fixture.verification }, body.sha);
        sendContract(response, 200, 'verify', { ...result, source: 'fixture' });
        return;
      }

      if (request.method === 'OPTIONS') {
        response.setHeader('allow', 'GET, POST');
        sendError(response, 405, 'method_not_allowed', 'Method not allowed.');
        return;
      }

      if (request.method === 'GET' && !pathname.startsWith('/api/')) {
        await serveStatic(request, response);
        return;
      }

      if (pathname.startsWith('/api/')) {
        sendError(response, 404, 'not_found', 'Not found.');
        return;
      }

      sendError(response, 405, 'method_not_allowed', 'Method not allowed.');
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      if (error?.status) {
        sendError(response, error.status, error.code || 'request_error', error.message, error.errors);
        return;
      }
      console.error('PatchTrace request failed: internal_error');
      sendError(response, 500, 'internal_error', 'The request could not be completed.');
    }
  });

  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  return {
    server,
    token,
    enableRealVerification,
    allowedHosts: allowed.hosts,
    cancelVerification: () => currentVerification?.abort(),
    cancelAnalysis: () => currentAnalysis?.abort()
  };
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const port = Number(process.env.PORT || 4173);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('Invalid PORT. Use an integer between 0 and 65535.');
    process.exit(1);
  }
  const host = process.env.HOST || '127.0.0.1';
  const app = createPatchTraceServer({ port });
  app.server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Set PORT to a different value.`);
    } else {
      console.error(`PatchTrace could not start: ${error.message}`);
    }
    process.exit(1);
  });
  app.server.listen(port, host, () => {
    const actualPort = app.server.address().port;
    const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
    console.log(`PatchTrace listening on http://${displayHost}:${actualPort}`);
    if (!process.env.PATCHTRACE_TOKEN) {
      console.log(`Session token: ${app.token}`);
    }
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.cancelVerification();
    app.cancelAnalysis();
    app.server.close(() => process.exit(0));
    app.server.closeIdleConnections?.();
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
