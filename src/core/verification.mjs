import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, cp, lstat, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import {
  ContainerCancelledError,
  ContainerUnavailableError,
  containerSettings as resolveContainerSettings,
  createContainerCommandRunner,
  prepareContainerRuntime
} from './container-runner.mjs';
import { redactSecrets } from './redaction.mjs';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const KILL_GRACE_MS = 5_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_BASELINE_RUNS = 2;
const MAX_BASELINE_RUNS = 3;
const WORKSPACE_MARKER = '.patchtrace-workspace';
const DEFAULT_STALE_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_REPOSITORY_COPY_BYTES = 2 * 1024 ** 3;
const DEFAULT_MIN_FREE_BYTES = 256 * 1024 ** 2;

const SAFE_ENV_KEYS = new Set([
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
  'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'CI', 'NODE_ENV'
]);

export class SafetyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SafetyError';
    this.code = code;
  }
}

class VerificationLimitError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'VerificationLimitError';
    this.code = code;
    this.details = details;
  }
}

export function isPathOutside(root, target) {
  const rel = relative(root, target);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

export function resolveCommand(command) {
  if (typeof command !== 'string' || !command) throw new Error('Command must be a non-empty string.');
  if (process.platform !== 'win32') return command;
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) return command;

  const extensions = (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .filter(Boolean);
  if (extname(command)) {
    for (const directory of (process.env.PATH || '').split(delimiter)) {
      const candidate = join(directory, command);
      if (existsSync(candidate)) return candidate;
    }
    return command;
  }

  for (const directory of (process.env.PATH || '').split(delimiter)) {
    for (const extension of [...extensions, '']) {
      const candidate = join(directory, command + extension);
      if (existsSync(candidate)) return candidate;
    }
  }
  return command;
}

function verificationEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (SAFE_ENV_KEYS.has(key)) env[key] = value;
  }
  const passthrough = String(process.env.PATCHTRACE_VERIFY_ENV || '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
  for (const key of passthrough) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, ...extra };
}

export { redactSecrets } from './redaction.mjs';

export async function sweepStaleWorkspaces({
  tempRoot = tmpdir(),
  maxAgeMs = DEFAULT_STALE_AGE_MS,
  now = Date.now()
} = {}) {
  const root = await realpath(tempRoot);
  const entries = await readdir(root, { withFileTypes: true });
  const removed = [];
  const skipped = [];
  const errors = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('patchtrace-')) continue;
    const workspace = join(root, entry.name);
    let markerStat;
    try {
      markerStat = await stat(join(workspace, WORKSPACE_MARKER));
    } catch {
      skipped.push(entry.name);
      continue;
    }
    if (!markerStat.isFile() || now - markerStat.mtimeMs < maxAgeMs) {
      skipped.push(entry.name);
      continue;
    }
    try {
      await rm(workspace, { recursive: true, force: true });
      removed.push(entry.name);
    } catch (error) {
      errors.push({ name: entry.name, error: error.message });
    }
  }
  return { removed, skipped, errors };
}

function validateCommand(command) {
  if (!Array.isArray(command) || command.length === 0
    || command.some((part) => typeof part !== 'string' || !part || part.includes('\0'))) {
    throw new Error('testCommand must be a non-empty argv array without empty or null-containing arguments, for example ["npm", "test"].');
  }
}

function validateTimeout(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('timeoutMs must be a positive number.');
  }
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be no greater than ${MAX_TIMEOUT_MS} ms.`);
  }
}

function validateNonNegativeLimit(value, name) {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }
  return number;
}

function configuredLimit(value, environmentKey, fallback, name) {
  return validateNonNegativeLimit(
    value === undefined ? (process.env[environmentKey] ?? fallback) : value,
    name
  );
}

async function measureRepositoryCopySize(repoPath, limitBytes, signal) {
  const pending = [repoPath];
  let totalBytes = 0;
  while (pending.length) {
    if (signal?.aborted) return { cancelled: true };
    const current = pending.pop();
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (signal?.aborted) return { cancelled: true };
      const entryPath = join(current, entry.name);
      const entryStats = await lstat(entryPath);
      if (entryStats.isDirectory() && !entryStats.isSymbolicLink()) {
        pending.push(entryPath);
        continue;
      }
      totalBytes += Number(entryStats.size) || 0;
      if (totalBytes > limitBytes) return { bytes: totalBytes, exceeded: true };
    }
  }
  return { bytes: totalBytes, exceeded: false };
}

async function availableSpaceBytes(path) {
  try {
    const filesystem = await statfs(path);
    const blockSize = Number(filesystem.bsize || filesystem.frsize || 0);
    const availableBlocks = Number(filesystem.bavail ?? filesystem.bfree ?? 0);
    if (!Number.isSafeInteger(blockSize) || blockSize <= 0
      || !Number.isSafeInteger(availableBlocks) || availableBlocks < 0) {
      return null;
    }
    const available = blockSize * availableBlocks;
    return Number.isSafeInteger(available) ? available : null;
  } catch {
    return null;
  }
}

async function verificationPreflight(repoPath, tempParent, {
  maxRepositoryCopyBytes,
  minFreeBytes,
  signal
}) {
  if (signal?.aborted) return { cancelled: true };
  const copy = await measureRepositoryCopySize(repoPath, maxRepositoryCopyBytes, signal);
  if (copy.cancelled) return { cancelled: true };
  if (copy.exceeded) {
    throw new VerificationLimitError(
      'repository_copy_too_large',
      `The repository copy is larger than the configured ${maxRepositoryCopyBytes} byte verification limit.`,
      { repositoryBytes: copy.bytes, maxRepositoryCopyBytes }
    );
  }
  if (signal?.aborted) return { cancelled: true };
  const freeBytes = await availableSpaceBytes(tempParent);
  if (freeBytes !== null && freeBytes < copy.bytes + minFreeBytes) {
    throw new VerificationLimitError(
      'insufficient_disk_space',
      `Verification needs the repository copy plus ${minFreeBytes} bytes of free space, but only ${freeBytes} bytes are available.`,
      { repositoryBytes: copy.bytes, freeBytes, minFreeBytes }
    );
  }
  return { repositoryBytes: copy.bytes, freeBytes };
}

async function makeWorkspaceWritable(root, signal) {
  const pending = [root];
  while (pending.length) {
    if (signal?.aborted) return false;
    const current = pending.pop();
    const currentStats = await lstat(current);
    if (currentStats.isDirectory() && !currentStats.isSymbolicLink()) {
      await chmod(current, (currentStats.mode & 0o777) | 0o777);
      for (const entry of await readdir(current, { withFileTypes: true })) {
        pending.push(join(current, entry.name));
      }
      continue;
    }
    if (currentStats.isSymbolicLink()) continue;
    await chmod(current, (currentStats.mode & 0o777) | 0o222);
  }
  return true;
}

function appendOutput(current, chunk) {
  const remaining = MAX_OUTPUT_BYTES - Buffer.byteLength(current, 'utf8');
  if (remaining <= 0) return current;
  const text = chunk.toString('utf8');
  if (Buffer.byteLength(text, 'utf8') <= remaining) return current + text;
  return `${current}${Buffer.from(text).subarray(0, remaining).toString('utf8')}\n[output truncated]`;
}

function quoteWindowsArg(value) {
  if (!/[\s"&|<>^]/.test(value)) return value;
  return `"${value.replaceAll('"', '\\"')}"`;
}

function terminateProcess(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    });
    killer.once('error', () => {
      try { child.kill(); } catch { /* already gone */ }
    });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
    return;
  } catch {
    // Fall through to the direct child kill when the process group is gone.
  }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

export function runCommand(command, cwd, timeoutMs, options = {}) {
  validateCommand(command);
  validateTimeout(timeoutMs);
  if (options.signal?.aborted) {
    return Promise.resolve({
      status: 'cancelled',
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      durationMs: 0,
      timedOut: false,
      cancelled: true,
      redactions: 0
    });
  }

  const executable = resolveCommand(command[0]);
  const isBatch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable);
  const comspec = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
  const batchLine = isBatch
    ? `"${[executable, ...command.slice(1)].map(quoteWindowsArg).join(' ')}"`
    : null;

  return new Promise((resolveResult) => {
    const startedAt = Date.now();
    const child = isBatch
      ? spawn(comspec, ['/d', '/s', '/c', batchLine], {
          cwd,
          shell: false,
          windowsHide: true,
          windowsVerbatimArguments: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: verificationEnv(options.env)
        })
      : spawn(executable, command.slice(1), {
          cwd,
          shell: false,
          windowsHide: true,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: verificationEnv(options.env)
        });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let timer;
    let forceTimer;
    let abortListener;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      if (abortListener) options.signal.removeEventListener('abort', abortListener);
      const cleanStdout = redactSecrets(stdout);
      const cleanStderr = redactSecrets(stderr);
      resolveResult({
        ...result,
        stdout: cleanStdout.text,
        stderr: cleanStderr.text,
        redactions: cleanStdout.redactions + cleanStderr.redactions,
        durationMs: Date.now() - startedAt,
        timedOut,
        cancelled: result.status === 'cancelled'
      });
    };

    const abort = () => {
      if (settled || aborted || timedOut) return;
      aborted = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      try {
        terminateProcess(child);
      } catch {
        // The forced timer below still resolves the cancelled run.
      }
      forceTimer = setTimeout(() => {
        finish({ status: 'cancelled', exitCode: null, signal: 'SIGKILL', forced: true });
      }, KILL_GRACE_MS);
    };

    if (typeof options.signal?.addEventListener === 'function') {
      abortListener = abort;
      options.signal.addEventListener('abort', abortListener, { once: true });
      if (options.signal.aborted) abort();
    }

    child.stdout.on('data', (chunk) => { stdout = appendOutput(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = appendOutput(stderr, chunk); });
    child.once('error', (error) => finish({
      status: aborted ? 'cancelled' : 'error',
      exitCode: null,
      signal: null,
      error: aborted ? null : error.message
    }));
    child.once('close', (exitCode, signal) => {
      if (timedOut) {
        finish({ status: 'timeout', exitCode, signal: signal || 'SIGKILL' });
        return;
      }
      if (aborted) {
        finish({ status: 'cancelled', exitCode, signal: signal || 'SIGKILL' });
        return;
      }
      finish({ status: exitCode === 0 ? 'passed' : 'failed', exitCode, signal: signal || null });
    });

    timer = setTimeout(() => {
      timedOut = true;
      try {
        terminateProcess(child);
      } catch {
        // The forced timeout below still resolves the run.
      }
      forceTimer = setTimeout(() => {
        finish({ status: 'timeout', exitCode: null, signal: 'SIGKILL', forced: true });
      }, KILL_GRACE_MS);
    }, timeoutMs);
    if (settled) clearTimeout(timer);
  });
}

async function git(cwd, args, timeoutMs = 10_000, options = {}) {
  return runCommand(['git', '-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', ...args], cwd, timeoutMs, options);
}

async function fileHash(path) {
  try {
    return createHash('sha256').update(await readFile(path)).digest('hex');
  } catch {
    return null;
  }
}

export async function repositorySnapshot(repoPath) {
  const [head, status, configHash] = await Promise.all([
    git(repoPath, ['rev-parse', 'HEAD']),
    git(repoPath, ['status', '--porcelain=v1', '--untracked-files=all']),
    fileHash(join(repoPath, '.git', 'config'))
  ]);
  return {
    valid: head.status === 'passed' && status.status === 'passed',
    head: head.stdout.trim(),
    status: status.stdout,
    dirty: status.stdout.trim().length > 0,
    configHash
  };
}

async function assertSupportedGitVersion() {
  const result = await git(process.cwd(), ['--version'], 5_000);
  const match = result.stdout.match(/git version (\d+)\.(\d+)/i);
  if (result.status !== 'passed' || !match) {
    throw new SafetyError('git_unavailable', 'Git is required for verification but could not be started.');
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < 2 || (major === 2 && minor < 31)) {
    throw new SafetyError('git_too_old', `Git 2.31 or newer is required; found ${result.stdout.trim()}.`);
  }
}

export async function assertSupportedRepository(repoPath) {
  const gitEntry = await stat(join(repoPath, '.git')).catch(() => null);
  if (!gitEntry) throw new SafetyError('invalid_repo', 'The path is not a Git worktree.');
  if (gitEntry.isFile()) {
    throw new SafetyError('unsupported_worktree', 'Linked worktrees and submodule checkouts are not supported. Use a normal clone.');
  }

  const [bare, shallow, topLevel, inside, submodules] = await Promise.all([
    git(repoPath, ['rev-parse', '--is-bare-repository']),
    git(repoPath, ['rev-parse', '--is-shallow-repository']),
    git(repoPath, ['rev-parse', '--show-toplevel']),
    git(repoPath, ['rev-parse', '--is-inside-work-tree']),
    git(repoPath, ['submodule', 'status'])
  ]);

  if (inside.stdout.trim() !== 'true') throw new SafetyError('invalid_repo', 'The path is not a Git worktree.');
  if (bare.stdout.trim() === 'true') throw new SafetyError('unsupported_bare_repo', 'Bare repositories are not supported.');
  if (shallow.stdout.trim() === 'true') throw new SafetyError('unsupported_shallow_repo', 'Shallow repositories are not supported because rollback history may be missing.');
  if (submodules.status === 'passed' && submodules.stdout.trim()) {
    throw new SafetyError('unsupported_submodule', 'Repositories with submodules are not supported yet.');
  }

  const [actualTopLevel, expectedTopLevel] = await Promise.all([
    realpath(topLevel.stdout.trim()).catch(() => null),
    realpath(repoPath).catch(() => null)
  ]);
  const matches = Boolean(actualTopLevel && expectedTopLevel)
    && (process.platform === 'win32'
      ? actualTopLevel.toLowerCase() === expectedTopLevel.toLowerCase()
      : actualTopLevel === expectedTopLevel);
  if (!matches) {
    throw new SafetyError('invalid_repo', 'repoPath must point to the root of the Git worktree.');
  }
}

async function assertNoSymlinkOutsideRepository(repoPath) {
  const root = await realpath(repoPath);
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const entryPath = join(current, entry.name);
      const entryStats = await lstat(entryPath);
      if (entry.isSymbolicLink() || entryStats.isSymbolicLink()) {
        let linkTarget;
        try {
          linkTarget = await readlink(entryPath);
        } catch {
          throw new SafetyError('unsupported_symlink', `Repository contains a link that could not be inspected: ${entryPath}`);
        }
        const absoluteTarget = isAbsolute(linkTarget)
          || (process.platform === 'win32' && (/^[\\/]/.test(linkTarget) || /^[A-Za-z]:/.test(linkTarget)));
        if (absoluteTarget) {
          throw new SafetyError('absolute_symlink', `Repository contains an absolute symlink or junction: ${entryPath}`);
        }
        const lexicalTarget = resolve(dirname(entryPath), linkTarget);
        if (isPathOutside(root, lexicalTarget)) {
          throw new SafetyError('symlink_escape', `Repository contains a relative symlink that escapes its root: ${entryPath}`);
        }
        let target;
        try {
          target = await realpath(entryPath);
        } catch {
          throw new SafetyError('broken_symlink', `Repository contains a broken symlink: ${entryPath}`);
        }
        if (isPathOutside(root, target)) {
          throw new SafetyError('symlink_escape', `Repository contains a symlink outside its root: ${entryPath}`);
        }
      } else if (entryStats.isDirectory()) {
        pending.push(entryPath);
      }
    }
  }
}

function baseResult(candidateSha, {
  isolation = 'temp-copy',
  isolationRequested = isolation,
  containerRuntime = null,
  containerImage = null,
  maxRepositoryCopyBytes = null,
  minFreeBytes = null
} = {}) {
  return {
    status: 'failed',
    outcome: 'not_confirmed',
    candidateSha,
    repoPath: null,
    baseline: null,
    baselineRuns: [],
    revert: null,
    candidate: null,
    reason: 'command_error',
    message: '',
    sourceUnchanged: true,
    sourceDirty: false,
    cleanup: { removed: false },
    isolation,
    isolationRequested,
    containerRuntime,
    containerImage,
    repositoryBytes: null,
    freeSpaceBytes: null,
    maxRepositoryCopyBytes,
    minFreeBytes,
    platform: process.platform,
    testCommand: null,
    timeoutMs: null,
    overallBudgetMs: null,
    baselineRunsRequested: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    durationMs: null
  };
}

function resultForSafety(base, error) {
  return {
    ...base,
    status: 'unsupported_layout',
    outcome: 'invalid_repo',
    reason: error.code || 'unsupported_layout',
    message: error.message,
    sourceUnchanged: true
  };
}

function outcomeFor(result) {
  if (result.status === 'passed') return 'confirmed';
  if (result.status === 'timeout') return 'timeout';
  if (result.status === 'cancelled') return 'cancelled';
  if (result.status === 'unsupported') return 'unsupported';
  if (result.status === 'missing_history') return 'invalid_repo';
  if (result.status === 'unsupported_layout') return 'invalid_repo';
  if (result.status === 'failed' && result.reason === 'baseline_did_not_fail') return 'inconclusive';
  if (result.status === 'failed' && result.reason === 'flaky_baseline') return 'inconclusive';
  if (result.status === 'failed' && result.reason === 'failure_persisted') return 'not_confirmed';
  if (result.status === 'failed' && result.reason === 'source_changed') return 'source_changed';
  if (result.status === 'failed' && result.reason === 'dirty_worktree') return 'invalid_repo';
  return 'command_error';
}

function cancelResult(result, message) {
  result.status = 'cancelled';
  result.reason = 'cancelled';
  result.message = message;
  result.outcome = 'cancelled';
  return result;
}

function unsupportedResult(base, error) {
  return {
    ...base,
    ...(error.details && typeof error.details === 'object' ? error.details : {}),
    status: 'unsupported',
    outcome: 'unsupported',
    reason: error.code || 'unsupported',
    message: error.message,
    sourceUnchanged: true,
    cleanup: { removed: false, skipped: true }
  };
}

export async function verifyRollback({
  repoPath,
  candidateSha,
  testCommand = ['npm', 'test'],
  timeoutMs = DEFAULT_TIMEOUT_MS,
  tempRoot = tmpdir(),
  mainline,
  baselineRuns = DEFAULT_BASELINE_RUNS,
  signal,
  isolation: requestedIsolation = process.env.PATCHTRACE_VERIFY_ISOLATION || 'temp-copy',
  containerRuntime,
  containerImage,
  containerUser,
  containerCpus,
  containerMemory,
  containerPidsLimit,
  containerTmpfsSize,
  maxRepositoryCopyBytes,
  maxCopyBytes,
  minFreeBytes,
  minimumFreeBytes,
  commandRunner: injectedCommandRunner,
  runCommand: injectedRunCommand
}) {
  validateCommand(testCommand);
  validateTimeout(timeoutMs);
  if (!Number.isInteger(baselineRuns) || baselineRuns < 1 || baselineRuns > MAX_BASELINE_RUNS) {
    throw new Error(`baselineRuns must be an integer between 1 and ${MAX_BASELINE_RUNS}.`);
  }
  if (typeof repoPath !== 'string' || !repoPath) throw new Error('repoPath is required.');
  if (typeof candidateSha !== 'string' || !/^[0-9a-f]{4,64}$/i.test(candidateSha)) {
    throw new Error('candidateSha must be a Git commit SHA.');
  }
  if (mainline !== undefined && (!Number.isInteger(mainline) || mainline < 1)) {
    throw new Error('mainline must be a positive integer when verifying a merge commit.');
  }

  const isolation = requestedIsolation === 'production' ? 'container' : requestedIsolation;
  if (!['temp-copy', 'container'].includes(isolation)) {
    throw new Error('isolation must be "container" (production) or "temp-copy" (trusted local preview).');
  }
  const maxCopyLimit = configuredLimit(
    maxRepositoryCopyBytes ?? maxCopyBytes,
    'PATCHTRACE_VERIFY_MAX_COPY_BYTES',
    DEFAULT_MAX_REPOSITORY_COPY_BYTES,
    'maxRepositoryCopyBytes'
  );
  const freeSpaceLimit = configuredLimit(
    minFreeBytes ?? minimumFreeBytes,
    'PATCHTRACE_VERIFY_MIN_FREE_BYTES',
    DEFAULT_MIN_FREE_BYTES,
    'minFreeBytes'
  );
  const commandRunner = injectedCommandRunner || injectedRunCommand || runCommand;
  if (typeof commandRunner !== 'function') throw new Error('commandRunner must be a function.');
  const requestedContainerRuntime = containerRuntime
    ?? process.env.PATCHTRACE_CONTAINER_RUNTIME
    ?? null;
  const requestedContainerImage = containerImage
    ?? process.env.PATCHTRACE_VERIFY_IMAGE
    ?? 'patchtrace:local';
  const configuredContainerSettings = isolation === 'container'
    ? resolveContainerSettings({
        runtime: requestedContainerRuntime,
        image: requestedContainerImage,
        user: containerUser,
        cpus: containerCpus,
        memory: containerMemory,
        pidsLimit: containerPidsLimit,
        tmpfsSize: containerTmpfsSize
      })
    : null;

  const startedMs = Date.now();
  const seal = (value) => {
    value.finishedAt = new Date().toISOString();
    value.durationMs = Date.now() - startedMs;
    value.outcome = outcomeFor(value);
    return value;
  };

  const sourcePath = await realpath(repoPath);
  const tempParent = await realpath(tempRoot);
  const sourceStats = await stat(sourcePath);
  if (!sourceStats.isDirectory()) throw new Error('repoPath must point to a directory.');
  if (basename(sourcePath) === '') throw new Error('repoPath must not be a filesystem root.');
  if (resolve(tempParent) === resolve(sourcePath) || !isPathOutside(resolve(sourcePath), resolve(tempParent))) {
    throw new Error('tempRoot cannot be inside repoPath.');
  }

  const base = baseResult(candidateSha, {
    isolation,
    isolationRequested: requestedIsolation,
    containerRuntime: isolation === 'container' ? requestedContainerRuntime : null,
    containerImage: isolation === 'container' ? requestedContainerImage : null,
    maxRepositoryCopyBytes: maxCopyLimit,
    minFreeBytes: freeSpaceLimit
  });
  base.testCommand = testCommand;
  base.timeoutMs = timeoutMs;
  base.baselineRunsRequested = baselineRuns;
  base.repoPath = sourcePath;

  if (signal?.aborted) {
    return seal(cancelResult(
      { ...base, cleanup: { removed: false, skipped: true } },
      'Verification was cancelled before it started.'
    ));
  }

  try {
    await assertSupportedGitVersion();
    await assertSupportedRepository(sourcePath);
    await assertNoSymlinkOutsideRepository(sourcePath);
  } catch (error) {
    if (error instanceof SafetyError) return seal(resultForSafety(base, error));
    throw error;
  }

  const sourceBefore = await repositorySnapshot(sourcePath);
  if (!sourceBefore.valid) {
    return seal({
      ...base,
      status: 'missing_history',
      outcome: 'invalid_repo',
      reason: 'not_a_git_repository',
      message: 'The source path is not a usable Git repository with a HEAD commit.',
      sourceUnchanged: false
    });
  }
  base.sourceDirty = sourceBefore.dirty;
  base.sourceHead = sourceBefore.head;
  if (sourceBefore.dirty) {
    return seal({
      ...base,
      status: 'failed',
      outcome: 'invalid_repo',
      reason: 'dirty_worktree',
      message: 'The source worktree has uncommitted changes. Commit or stash them before verification; PatchTrace will not silently test a dirty tree.',
      cleanup: { removed: false, skipped: true }
    });
  }

  let containerInfo = null;
  if (isolation === 'container') {
    try {
      containerInfo = await prepareContainerRuntime({
        runtime: requestedContainerRuntime,
        image: requestedContainerImage,
        commandRunner,
        cwd: process.cwd(),
        timeoutMs: Math.min(timeoutMs, 10_000),
        signal
      });
      base.containerRuntime = containerInfo.runtime;
      base.containerImage = containerInfo.image;
    } catch (error) {
      if (error instanceof ContainerCancelledError) {
        return seal(cancelResult(
          { ...base, cleanup: { removed: false, skipped: true } },
          'Verification was cancelled while checking the container runtime.'
        ));
      }
      if (error instanceof ContainerUnavailableError) {
        return seal(unsupportedResult(base, error));
      }
      throw error;
    }
  }

  let preflight;
  try {
    preflight = await verificationPreflight(sourcePath, tempParent, {
      maxRepositoryCopyBytes: maxCopyLimit,
      minFreeBytes: freeSpaceLimit,
      signal
    });
  } catch (error) {
    if (error instanceof VerificationLimitError) return seal(unsupportedResult(base, error));
    return seal({
      ...base,
      status: 'failed',
      reason: 'runner_error',
      message: `Verification preflight could not complete: ${error.message}`,
      cleanup: { removed: false, skipped: true }
    });
  }
  if (preflight.cancelled) {
    return seal(cancelResult(
      { ...base, cleanup: { removed: false, skipped: true } },
      'Verification was cancelled during the repository preflight.'
    ));
  }
  base.repositoryBytes = preflight.repositoryBytes;
  base.freeSpaceBytes = preflight.freeBytes;

  let temporaryRoot;
  try {
    temporaryRoot = await mkdtemp(join(tempParent, 'patchtrace-'));
  } catch (error) {
    return seal({
      ...base,
      status: 'failed',
      reason: 'runner_error',
      message: `A temporary workspace could not be created: ${error.message}`
    });
  }
  const workspace = join(temporaryRoot, basename(sourcePath));
  const result = base;

  try {
    try {
      await writeFile(join(temporaryRoot, WORKSPACE_MARKER), JSON.stringify({
        createdAt: new Date().toISOString(),
        candidateSha
      }), { mode: 0o600 });
    } catch (error) {
      result.cleanup.markerError = error.message;
    }

    if (signal?.aborted) return cancelResult(result, 'Verification was cancelled before the repository was copied.');

    await cp(sourcePath, workspace, {
      recursive: true,
      errorOnExist: true,
      force: false,
      dereference: false,
      verbatimSymlinks: true
    });
    await assertNoSymlinkOutsideRepository(workspace);
    let executeCommand = runCommand;
    if (isolation === 'container') {
      const workspaceWritable = await makeWorkspaceWritable(workspace, signal);
      if (!workspaceWritable) return cancelResult(result, 'Verification was cancelled while preparing the container workspace.');
      executeCommand = createContainerCommandRunner({
        ...configuredContainerSettings,
        runtime: containerInfo.runtime,
        image: containerInfo.image,
        sourcePath,
        workspacePath: workspace,
        commandRunner,
        hostCwd: process.cwd()
      });
    }
    const workspaceGit = (args, timeout = 10_000, options = {}) => executeCommand(
      [
        'git',
        '-c', 'core.hooksPath=',
        '-c', 'core.fsmonitor=false',
        ...(isolation === 'container' ? ['-c', 'safe.directory=/patchtrace/workspace'] : []),
        ...args
      ],
      workspace,
      timeout,
      options
    );
    if (signal?.aborted) return cancelResult(result, 'Verification was cancelled during the repository copy.');

    const candidateExists = await workspaceGit(['rev-parse', '--verify', `${candidateSha}^{commit}`], 10_000, { signal });
    if (candidateExists.status === 'cancelled') {
      return cancelResult(result, 'Verification was cancelled while checking the candidate commit.');
    }
    const candidateReachable = candidateExists.status === 'passed'
      ? await workspaceGit(['merge-base', '--is-ancestor', candidateSha, 'HEAD'], 10_000, { signal })
      : candidateExists;
    if (candidateReachable.status === 'cancelled') {
      return cancelResult(result, 'Verification was cancelled while checking candidate reachability.');
    }
    if (candidateExists.status !== 'passed' || candidateReachable.status !== 'passed') {
      result.status = 'missing_history';
      result.outcome = 'invalid_repo';
      result.reason = 'candidate_missing_or_unreachable';
      result.message = 'The candidate commit is missing from the copied repository or is not reachable from HEAD.';
      return result;
    }

    const overallBudgetMs = timeoutMs * (baselineRuns + 1) + 10_000;
    result.overallBudgetMs = overallBudgetMs;
    const testDeadline = Date.now() + overallBudgetMs;
    const remainingBudget = () => Math.max(0, testDeadline - Date.now());
    for (let index = 0; index < baselineRuns; index += 1) {
      if (signal?.aborted) {
        return cancelResult(result, `Verification was cancelled before baseline run ${index + 1}.`);
      }
      const remaining = remainingBudget();
      if (!remaining) {
        result.status = 'timeout';
        result.reason = 'test_timeout';
        result.message = `The overall ${overallBudgetMs} ms verification budget was exhausted before baseline run ${index + 1}.`;
        return result;
      }
      const baseline = await executeCommand(
        testCommand,
        workspace,
        Math.max(1, Math.min(timeoutMs, remaining)),
        { signal }
      );
      result.baselineRuns.push(baseline);
      result.baseline = baseline;
      if (baseline.status === 'cancelled') {
        return cancelResult(result, `Verification was cancelled during baseline run ${index + 1}.`);
      }
      if (baseline.status === 'timeout') {
        result.status = 'timeout';
        result.reason = 'test_timeout';
        result.message = `Baseline run ${index + 1} timed out (per-run limit ${timeoutMs} ms, overall budget ${overallBudgetMs} ms).`;
        return result;
      }
      if (baseline.status === 'error') {
        result.reason = 'command_error';
        result.message = baseline.error || 'The baseline command could not be started.';
        return result;
      }
    }

    const baselineStatuses = new Set(result.baselineRuns.map((run) => run.status));
    if (baselineStatuses.size > 1) {
      result.status = 'failed';
      result.reason = 'flaky_baseline';
      result.message = `Baseline runs disagreed (${result.baselineRuns.map((run) => run.status).join(', ')}). The reproduced failure is unstable, so the rollback result is inconclusive; rerun or narrow the test command.`;
      return result;
    }
    if (result.baseline.status === 'passed') {
      result.reason = 'baseline_did_not_fail';
      result.message = `The baseline did not fail${baselineRuns > 1 ? ' in any of its runs' : ''}, so there was no reproduced failure for the rollback to remove.`;
      return result;
    }

    if (!remainingBudget()) {
      result.status = 'timeout';
      result.reason = 'revert_timeout';
      result.message = `The overall ${overallBudgetMs} ms verification budget was exhausted before the Git revert.`;
      return result;
    }
    const revertArgs = ['revert', '--no-commit', '--no-edit'];
    if (mainline !== undefined) revertArgs.push('-m', String(mainline));
    revertArgs.push(candidateSha);
    const revert = await workspaceGit(
      revertArgs,
      Math.max(1, Math.min(10_000, remainingBudget())),
      { signal }
    );
    result.revert = {
      status: revert.status === 'passed' ? 'applied' : revert.status === 'cancelled' ? 'cancelled' : 'failed',
      exitCode: revert.exitCode,
      stdout: revert.stdout,
      stderr: revert.stderr,
      redactions: revert.redactions,
      timedOut: revert.timedOut
    };
    if (revert.status === 'cancelled') {
      return cancelResult(result, 'Verification was cancelled during the Git revert.');
    }
    if (revert.status === 'timeout') {
      result.status = 'timeout';
      result.reason = 'revert_timeout';
      result.message = 'The Git revert timed out.';
      return result;
    }
    if (revert.status !== 'passed') {
      result.reason = 'revert_failed';
      result.message = 'The candidate could not be reverted cleanly in the temporary copy.';
      return result;
    }

    if (!remainingBudget()) {
      result.status = 'timeout';
      result.reason = 'test_timeout';
      result.message = `The overall ${overallBudgetMs} ms verification budget was exhausted before the candidate test run.`;
      return result;
    }
    result.candidate = await executeCommand(
      testCommand,
      workspace,
      Math.max(1, Math.min(timeoutMs, remainingBudget())),
      { signal }
    );
    if (result.candidate.status === 'cancelled') {
      return cancelResult(result, 'Verification was cancelled during the candidate test run.');
    }
    if (result.candidate.status === 'timeout') {
      result.status = 'timeout';
      result.reason = 'test_timeout';
      result.message = 'The candidate test command timed out.';
    } else if (result.candidate.status === 'error') {
      result.reason = 'command_error';
      result.message = result.candidate.error || 'The candidate command could not be started.';
    } else if (result.baseline.status === 'failed' && result.candidate.status === 'passed') {
      result.status = 'passed';
      result.reason = 'rollback_removed_failure';
      result.message = 'Reverting the candidate removed the reproduced failure in the temporary copy. This supports the rollback hypothesis; it does not prove root cause.';
    } else {
      result.reason = 'failure_persisted';
      result.message = 'The failure persisted after reverting the candidate.';
    }
    return result;
  } catch (error) {
    if (error instanceof SafetyError) {
      result.status = 'unsupported_layout';
      result.outcome = 'invalid_repo';
      result.reason = error.code;
      result.message = error.message;
      return result;
    }
    result.status = 'failed';
    result.reason = 'runner_error';
    result.message = `Verification could not complete: ${error.message}`;
    return result;
  } finally {
    try {
      await rm(temporaryRoot, { recursive: true, force: true });
      result.cleanup = { removed: true };
    } catch (error) {
      result.cleanup = { ...result.cleanup, removed: false, error: error.message };
    }

    let sourceAfter = null;
    try {
      sourceAfter = await repositorySnapshot(sourcePath);
    } catch (error) {
      result.cleanup.sourceSnapshotError = error.message;
    }
    result.sourceUnchanged = Boolean(
      sourceBefore.valid
      && sourceAfter?.valid
      && sourceAfter.head === sourceBefore.head
      && sourceAfter.status === sourceBefore.status
      && sourceAfter.configHash === sourceBefore.configHash
    );
    if (!result.sourceUnchanged && result.status === 'passed') {
      result.status = 'failed';
      result.reason = 'source_changed';
      result.message = 'The source repository changed during verification; the result cannot be trusted.';
    }
    seal(result);
  }
}
