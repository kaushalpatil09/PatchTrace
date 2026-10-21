const DEFAULT_CONTAINER_RUNTIME = null;
const DEFAULT_CONTAINER_IMAGE = 'patchtrace:local';
const DEFAULT_CONTAINER_USER = '65532:65532';
const DEFAULT_CONTAINER_CPUS = 1;
const DEFAULT_CONTAINER_MEMORY = '512m';
const DEFAULT_CONTAINER_PIDS_LIMIT = 256;
const DEFAULT_CONTAINER_TMPFS_SIZE = '64m';
const CONTAINER_SOURCE_PATH = '/patchtrace/source';
const CONTAINER_WORKSPACE_PATH = '/patchtrace/workspace';
let containerSequence = 0;

const MINIMAL_ENVIRONMENT = [
  'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  'HOME=/tmp',
  'TMPDIR=/tmp',
  'LANG=C',
  'LC_ALL=C',
  'CI=1',
  'NODE_ENV=test',
  'GIT_CONFIG_NOSYSTEM=1',
  'NPM_CONFIG_UPDATE_NOTIFIER=false'
];

function requiredString(value, name, { allowPath = true } = {}) {
  if (typeof value !== 'string' || !value || value.includes('\0')) {
    throw new Error(`${name} must be a non-empty string without null bytes.`);
  }
  if (!allowPath && /\s/.test(value)) {
    throw new Error(`${name} must not contain whitespace.`);
  }
  return value;
}

function positiveNumber(value, name) {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return number;
}

function positiveInteger(value, name) {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return number;
}

function resourceSize(value, name) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+(?:[bkmg](?:i)?|)$/i.test(normalized) || Number(normalized) === 0) {
    throw new Error(`${name} must be a positive Docker/Podman resource size such as 512m.`);
  }
  return normalized;
}

function containerUser(value) {
  const normalized = requiredString(value, 'containerUser', { allowPath: false });
  if (!/^\d+:\d+$/.test(normalized)) {
    throw new Error('containerUser must be a non-root numeric uid:gid pair.');
  }
  const [uid, gid] = normalized.split(':').map(Number);
  if (!Number.isSafeInteger(uid) || uid < 1 || !Number.isSafeInteger(gid) || gid < 0) {
    throw new Error('containerUser must be a non-root numeric uid:gid pair.');
  }
  return normalized;
}

function validateCommand(command) {
  if (!Array.isArray(command) || command.length === 0
    || command.some((part) => typeof part !== 'string' || !part || part.includes('\0'))) {
    throw new Error('Container command must be a non-empty argv array without empty or null-containing arguments.');
  }
}

function validateImage(image) {
  const normalized = requiredString(image, 'containerImage', { allowPath: false });
  if (normalized.startsWith('-')) throw new Error('containerImage must not start with a dash.');
  return normalized;
}

export class ContainerUnavailableError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ContainerUnavailableError';
    this.code = code;
    this.details = details;
  }
}

export class ContainerCancelledError extends Error {
  constructor(message = 'Container verification was cancelled.') {
    super(message);
    this.name = 'ContainerCancelledError';
    this.code = 'cancelled';
  }
}

export function containerSettings({
  runtime = process.env.PATCHTRACE_CONTAINER_RUNTIME || DEFAULT_CONTAINER_RUNTIME,
  image = process.env.PATCHTRACE_VERIFY_IMAGE || DEFAULT_CONTAINER_IMAGE,
  user = process.env.PATCHTRACE_VERIFY_USER || DEFAULT_CONTAINER_USER,
  cpus = process.env.PATCHTRACE_VERIFY_CPUS || DEFAULT_CONTAINER_CPUS,
  memory = process.env.PATCHTRACE_VERIFY_MEMORY || DEFAULT_CONTAINER_MEMORY,
  pidsLimit = process.env.PATCHTRACE_VERIFY_PIDS_LIMIT || DEFAULT_CONTAINER_PIDS_LIMIT,
  tmpfsSize = process.env.PATCHTRACE_VERIFY_TMPFS_SIZE || DEFAULT_CONTAINER_TMPFS_SIZE
} = {}) {
  const normalizedRuntime = runtime === undefined || runtime === null || runtime === ''
    ? null
    : requiredString(runtime, 'containerRuntime');
  return {
    runtime: normalizedRuntime,
    image: validateImage(image),
    user: containerUser(user),
    cpus: positiveNumber(cpus, 'containerCpus'),
    memory: resourceSize(memory, 'containerMemory'),
    pidsLimit: positiveInteger(pidsLimit, 'containerPidsLimit'),
    tmpfsSize: resourceSize(tmpfsSize, 'containerTmpfsSize')
  };
}

function runtimeUnavailable(runtime, message, details) {
  return new ContainerUnavailableError('container_runtime_unavailable', message, {
    runtime: runtime || null,
    ...details
  });
}

function imageUnavailable(runtime, image, details) {
  return new ContainerUnavailableError(
    'container_image_unavailable',
    `Verification image "${image}" is unavailable for the ${runtime} runtime. Build or configure PATCHTRACE_VERIFY_IMAGE before running production verification.`,
    { runtime, image, ...details }
  );
}

function commandStatus(result) {
  return result && typeof result.status === 'string' ? result.status : 'error';
}

/**
 * Resolve a configured runtime or the first working Docker/Podman runtime and
 * fail closed when the configured verification image is not already local.
 * `commandRunner` is injected so this preflight can be tested without Docker.
 */
export async function prepareContainerRuntime({
  runtime,
  image,
  commandRunner,
  cwd = process.cwd(),
  timeoutMs = 10_000,
  signal
} = {}) {
  if (typeof commandRunner !== 'function') throw new Error('commandRunner must be a function.');
  const settings = containerSettings({ runtime, image });
  const candidates = settings.runtime ? [settings.runtime] : ['docker', 'podman'];
  const availableRuntimes = [];

  for (const candidate of candidates) {
    if (signal?.aborted) throw new ContainerCancelledError();
    let version;
    try {
      version = await commandRunner([candidate, '--version'], cwd, timeoutMs, { signal });
    } catch {
      version = { status: 'error' };
    }
    if (commandStatus(version) === 'cancelled') throw new ContainerCancelledError();
    if (commandStatus(version) !== 'passed') {
      if (settings.runtime) {
        throw runtimeUnavailable(candidate, `The configured container runtime "${candidate}" is unavailable. Install Docker or Podman or configure PATCHTRACE_CONTAINER_RUNTIME.`, {
          phase: 'version'
        });
      }
      continue;
    }

    availableRuntimes.push(candidate);
    let imageCheck;
    try {
      imageCheck = await commandRunner([candidate, 'image', 'inspect', settings.image], cwd, timeoutMs, { signal });
    } catch {
      imageCheck = { status: 'error' };
    }
    if (commandStatus(imageCheck) === 'cancelled') throw new ContainerCancelledError();
    if (commandStatus(imageCheck) === 'passed') {
      return {
        ...settings,
        runtime: candidate,
        image: settings.image,
        version: typeof version.stdout === 'string' ? version.stdout.trim() : ''
      };
    }
    if (settings.runtime) throw imageUnavailable(candidate, settings.image, { phase: 'image-inspect' });
  }

  if (availableRuntimes.length) {
    throw imageUnavailable(availableRuntimes[0], settings.image, { phase: 'image-inspect' });
  }
  throw runtimeUnavailable(
    settings.runtime,
    'No supported container runtime (Docker or Podman) is available. Production verification cannot fall back to temp-copy mode.',
    { phase: 'version' }
  );
}

export function buildContainerCommand({
  runtime,
  image,
  sourcePath,
  workspacePath,
  command,
  name,
  user = DEFAULT_CONTAINER_USER,
  cpus = DEFAULT_CONTAINER_CPUS,
  memory = DEFAULT_CONTAINER_MEMORY,
  pidsLimit = DEFAULT_CONTAINER_PIDS_LIMIT,
  tmpfsSize = DEFAULT_CONTAINER_TMPFS_SIZE
} = {}) {
  const settings = containerSettings({ runtime, image, user, cpus, memory, pidsLimit, tmpfsSize });
  if (!settings.runtime) throw new Error('containerRuntime must resolve to Docker or Podman before building a container command.');
  requiredString(sourcePath, 'sourcePath');
  requiredString(workspacePath, 'workspacePath');
  validateCommand(command);
  if (name !== undefined) requiredString(name, 'containerName', { allowPath: false });

  return [
    settings.runtime,
    'run',
    '--rm',
    '--pull=never',
    '--network=none',
    '--read-only',
    '--security-opt=no-new-privileges',
    '--cap-drop=ALL',
    ...(name ? ['--name', name] : []),
    '--user', settings.user,
    '--cpus', String(settings.cpus),
    '--memory', settings.memory,
    '--pids-limit', String(settings.pidsLimit),
    '--tmpfs', `/tmp:rw,noexec,nosuid,size=${settings.tmpfsSize}`,
    '--volume', `${sourcePath}:${CONTAINER_SOURCE_PATH}:ro`,
    '--volume', `${workspacePath}:${CONTAINER_WORKSPACE_PATH}:rw`,
    '--workdir', CONTAINER_WORKSPACE_PATH,
    ...MINIMAL_ENVIRONMENT.flatMap((entry) => ['--env', entry]),
    settings.image,
    ...command
  ];
}

/**
 * Return a runner with the same `(argv, cwd, timeout, options)` contract as
 * verification's host command runner. Each phase gets a disposable
 * `--rm` container, while the workspace volume carries state between phases.
 */
export function createContainerCommandRunner({
  runtime,
  image,
  sourcePath,
  workspacePath,
  commandRunner,
  hostCwd = process.cwd(),
  user = DEFAULT_CONTAINER_USER,
  cpus = DEFAULT_CONTAINER_CPUS,
  memory = DEFAULT_CONTAINER_MEMORY,
  pidsLimit = DEFAULT_CONTAINER_PIDS_LIMIT,
  tmpfsSize = DEFAULT_CONTAINER_TMPFS_SIZE
} = {}) {
  if (typeof commandRunner !== 'function') throw new Error('commandRunner must be a function.');
  const settings = containerSettings({ runtime, image, user, cpus, memory, pidsLimit, tmpfsSize });
  if (!settings.runtime) throw new Error('containerRuntime must resolve to Docker or Podman before creating a container runner.');
  requiredString(sourcePath, 'sourcePath');
  requiredString(workspacePath, 'workspacePath');
  return async (command, _cwd, timeoutMs, options = {}) => {
    const name = `patchtrace-verify-${process.pid}-${Date.now().toString(36)}-${++containerSequence}`;
    const containerCommand = buildContainerCommand({
      ...settings,
      sourcePath,
      workspacePath,
      command,
      name
    });
    let cleanupStarted = false;
    let cleanupPromise = null;
    const cleanup = () => {
      if (cleanupStarted) return cleanupPromise || Promise.resolve();
      cleanupStarted = true;
      try {
        cleanupPromise = Promise.resolve(commandRunner(
          [settings.runtime, 'rm', '-f', name],
          hostCwd,
          Math.min(5_000, timeoutMs),
          {}
        )).catch(() => {});
      } catch {
        // The verification result still reports cancellation/timeout; cleanup
        // remains best-effort when the runtime client cannot be started.
        cleanupPromise = Promise.resolve();
      }
      return cleanupPromise;
    };
    const abortListener = () => { void cleanup(); };
    if (typeof options.signal?.addEventListener === 'function') {
      options.signal.addEventListener('abort', abortListener, { once: true });
    }
    let result;
    try {
      result = await commandRunner(containerCommand, hostCwd, timeoutMs, options);
    } catch (error) {
      await cleanup();
      throw error;
    } finally {
      if (typeof options.signal?.removeEventListener === 'function') {
        options.signal.removeEventListener('abort', abortListener);
      }
    }
    if (result?.status === 'cancelled' || result?.status === 'timeout' || result?.status === 'error') {
      await cleanup();
    }
    return result;
  };
}

export {
  CONTAINER_SOURCE_PATH,
  CONTAINER_WORKSPACE_PATH,
  DEFAULT_CONTAINER_CPUS,
  DEFAULT_CONTAINER_IMAGE,
  DEFAULT_CONTAINER_MEMORY,
  DEFAULT_CONTAINER_PIDS_LIMIT,
  DEFAULT_CONTAINER_RUNTIME,
  DEFAULT_CONTAINER_TMPFS_SIZE,
  DEFAULT_CONTAINER_USER,
  MINIMAL_ENVIRONMENT
};
