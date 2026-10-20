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

function isSensitiveKey(key) {
  const normalized = String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
  return SENSITIVE_KEY_NAMES.some((name) => normalized === name || normalized.endsWith(name));
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
