import { homedir } from 'node:os';

const REDACTION_RULES = [
  {
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    replacement: '[redacted private key]'
  },
  {
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bAKIA[0-9A-Z]{16}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b|\bsk-[A-Za-z0-9]{20,}\b/g,
    replacement: '[redacted token]'
  },
  {
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replacement: 'Bearer [redacted]'
  },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replacement: '[redacted jwt]'
  },
  {
    pattern: /((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|authorization)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
    replacement: '$1[redacted]'
  },
  {
    pattern: /(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi,
    replacement: '$1[redacted]@'
  }
];

const SENSITIVE_KEY_NAMES = [
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'apikey',
  'accesskey',
  'clientsecret',
  'authorization',
  'credential',
  'credentials',
  'privatekey',
  'sshkey'
];

export const PATH_REPLACEMENT = '[path redacted]';

const WINDOWS_DRIVE_PATH = /[A-Za-z]:[\\/](?:[^\\/\s"'`<>|;,)]+[\\/])*[^\\/\s"'`<>|;,)]+/g;
const UNC_PATH = /(?:\\\\|\/\/)(?:[^\\/\s"'`<>|]+[\\/])+[^\\/\s"'`<>|]*/g;
const HOME_ALIAS_PATH = /(?:~|\$HOME|\$USERPROFILE|%HOME%|%USERPROFILE%|%HOMEDRIVE%%HOMEPATH%)[\\/](?:[^\\/\s"'`<>|]+[\\/])*[^\\/\s"'`<>|]*/gi;
const POSIX_PATH = /\/(?:[^\\/\s"'`<>|;,)]+\/)+[^\\/\s"'`<>|;,)]+/g;

function isSensitiveKey(key) {
  const normalized = String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
  return SENSITIVE_KEY_NAMES.some((name) => normalized === name || normalized.endsWith(name));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function homePrefixes() {
  return [...new Set([
    homedir(),
    process.env.HOME,
    process.env.USERPROFILE,
    process.env.HOMEDRIVE && process.env.HOMEPATH
      ? `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`
      : null
  ].filter((value) => typeof value === 'string' && value.length > 1))];
}

function isUrlAt(source, offset) {
  const before = source.slice(0, offset);
  const boundary = Math.max(
    before.lastIndexOf(' '),
    before.lastIndexOf('\n'),
    before.lastIndexOf('\r'),
    before.lastIndexOf('"'),
    before.lastIndexOf("'"),
    before.lastIndexOf('('),
    before.lastIndexOf('['),
    before.lastIndexOf('=')
  );
  const prefix = source.slice(boundary + 1, offset);
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>]*$/u.test(prefix);
}

function replacePathMatches(source, pattern, shouldReplace = () => true) {
  let scrubs = 0;
  const text = source.replace(pattern, (match, offset, whole) => {
    if (!shouldReplace(match, offset, whole)) return match;
    scrubs += 1;
    return PATH_REPLACEMENT;
  });
  return { text, scrubs };
}

function isAbsolutePathLike(value) {
  const text = String(value).trim();
  if (!text || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(text)) return false;
  if (/^(?:[A-Za-z]:[\\/]|\\\\|\/\/|\/|~[\\/]|\$(?:HOME|USERPROFILE)[\\/]|%(?:HOME|USERPROFILE)%[\\/]|%HOMEDRIVE%%HOMEPATH%[\\/])/i.test(text)) {
    return true;
  }
  return homePrefixes().some((prefix) => {
    const normalizedPrefix = prefix.replaceAll('\\', '/').replace(/\/+$/, '');
    const normalizedText = text.replaceAll('\\', '/');
    return normalizedText === normalizedPrefix || normalizedText.startsWith(`${normalizedPrefix}/`);
  });
}

/**
 * Replace filesystem paths in user-controlled metadata without changing
 * repository-relative evidence such as `src/server.mjs` or `tests/report.test.mjs`.
 * The replacement is intentionally stable across platforms and report formats.
 */
export function scrubPathText(value, { key = '' } = {}) {
  let text = String(value ?? '');
  const trimmed = text.trim();
  if (isAbsolutePathLike(trimmed)) {
    const start = text.indexOf(trimmed);
    return {
      text: `${text.slice(0, start)}${PATH_REPLACEMENT}${text.slice(start + trimmed.length)}`,
      scrubs: 1
    };
  }

  let scrubs = 0;
  const replace = (pattern, shouldReplace) => {
    const result = replacePathMatches(text, pattern, shouldReplace);
    text = result.text;
    scrubs += result.scrubs;
  };

  for (const prefix of homePrefixes()) {
    const escaped = escapeRegExp(prefix.replace(/[\\/]$/, ''));
    const pattern = new RegExp(`${escaped}(?:[\\/][^\\s"'\\x60<>|;,)]+)*`, 'gi');
    replace(pattern, (match, offset, whole) => !isUrlAt(whole, offset));
  }
  replace(HOME_ALIAS_PATH, () => true);
  replace(UNC_PATH, (match, offset, whole) => whole[offset - 1] !== ':' && !isUrlAt(whole, offset));
  replace(WINDOWS_DRIVE_PATH, (match, offset, whole) => {
    const previous = whole[offset - 1];
    return (!previous || !/[A-Za-z0-9_]/u.test(previous)) && !isUrlAt(whole, offset);
  });
  replace(POSIX_PATH, (match, offset, whole) => {
    const previous = whole[offset - 1];
    return (!previous || /[\s("'=,:\[]/u.test(previous)) && !isUrlAt(whole, offset);
  });

  return { text, scrubs };
}

export function redactSecrets(value) {
  let text = String(value ?? '');
  let redactions = 0;
  for (const rule of REDACTION_RULES) {
    const matches = text.match(rule.pattern);
    if (!matches) continue;
    redactions += matches.length;
    text = text.replace(rule.pattern, rule.replacement);
  }
  return { text, redactions };
}

export function redactDeep(value) {
  const stats = { redactions: 0 };
  const seen = new WeakSet();

  const redactKeyedValue = () => {
    stats.redactions += 1;
    return '[redacted]';
  };

  const walk = (item) => {
    if (typeof item === 'string') {
      const result = redactSecrets(item);
      stats.redactions += result.redactions;
      return result.text;
    }
    if (Array.isArray(item)) return item.map(walk);
    if (item instanceof Date) return item.toISOString();
    if (item && typeof item === 'object') {
      if (seen.has(item)) return '[circular]';
      seen.add(item);
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [
        key,
        isSensitiveKey(key) ? redactKeyedValue() : walk(child)
      ]));
    }
    return item;
  };

  return { value: walk(value), redactions: stats.redactions };
}

/**
 * Apply secret redaction and filesystem path scrubbing in one immutable walk.
 * Report exports use this variant so JSON, Markdown, and CSV share one policy.
 */
export function redactAndScrubDeep(value) {
  const stats = { redactions: 0, pathScrubs: 0 };
  const seen = new WeakSet();

  const redactKeyedValue = () => {
    stats.redactions += 1;
    return '[redacted]';
  };

  const walk = (item, key = '') => {
    if (typeof item === 'string') {
      const secret = redactSecrets(item);
      stats.redactions += secret.redactions;
      const paths = scrubPathText(secret.text, { key });
      stats.pathScrubs += paths.scrubs;
      return paths.text;
    }
    if (Array.isArray(item)) return item.map((child) => walk(child, key));
    if (item instanceof Date) return item.toISOString();
    if (item && typeof item === 'object') {
      if (seen.has(item)) return '[circular]';
      seen.add(item);
      return Object.fromEntries(Object.entries(item).map(([childKey, child]) => [
        childKey,
        isSensitiveKey(childKey) ? redactKeyedValue() : walk(child, childKey)
      ]));
    }
    return item;
  };

  return { value: walk(value), redactions: stats.redactions, pathScrubs: stats.pathScrubs };
}
