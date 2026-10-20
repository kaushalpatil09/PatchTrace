export function parseCommandLine(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('Test command must not be empty.');
  }
  const args = [];
  let current = '';
  let tokenStarted = false;
  let quote = null;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (escaped) {
      current += character;
      tokenStarted = true;
      escaped = false;
      continue;
    }
    if (quote === '"' && character === '\\'
      && (input[index + 1] === '"' || input[index + 1] === '\\')) {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
        tokenStarted = true;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (tokenStarted) {
        if (!current) throw new Error('Test command arguments must not be empty.');
        args.push(current);
        current = '';
        tokenStarted = false;
      }
      continue;
    }
    current += character;
    tokenStarted = true;
  }

  if (escaped) {
    current += '\\';
    tokenStarted = true;
  }
  if (quote) throw new Error('Test command has an unterminated quote.');
  if (tokenStarted) {
    if (!current) throw new Error('Test command arguments must not be empty.');
    args.push(current);
  }
  if (!args.length) throw new Error('Test command must not be empty.');
  if (args.some((argument) => argument.includes('\0'))) {
    throw new Error('Test command arguments must not contain null bytes.');
  }
  return args;
}

export function parseTestCommand(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) throw new Error('Test command must not be empty.');
  if (trimmed.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error('Test command JSON must be a valid argv array.');
    }
    if (!Array.isArray(parsed) || !parsed.length
      || parsed.some((part) => typeof part !== 'string' || !part || part.includes('\0'))) {
      throw new Error('Test command JSON must be a non-empty array of strings without empty or null-containing arguments.');
    }
    return parsed;
  }
  return parseCommandLine(trimmed);
}
