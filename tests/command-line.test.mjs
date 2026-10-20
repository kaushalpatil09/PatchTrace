import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommandLine, parseTestCommand } from '../src/core/command-line.mjs';

test('parses ordinary and quoted argv commands', () => {
  assert.deepEqual(parseCommandLine('npm test'), ['npm', 'test']);
  assert.deepEqual(parseCommandLine('node "my script.js" --name "a b"'), ['node', 'my script.js', '--name', 'a b']);
  assert.deepEqual(parseCommandLine("node 'my script.js'"), ['node', 'my script.js']);
  assert.deepEqual(parseCommandLine('node C:\\repo\\script.js'), ['node', 'C:\\repo\\script.js']);
  assert.deepEqual(parseCommandLine('node "C:\\repo\\script.js"'), ['node', 'C:\\repo\\script.js']);
});

test('accepts an explicit JSON argv array', () => {
  assert.deepEqual(parseTestCommand('["npm","test"]'), ['npm', 'test']);
  assert.throws(() => parseTestCommand('["npm",]'), /valid argv/);
  assert.throws(() => parseTestCommand('["npm", 3]'), /array of strings/);
});

test('rejects malformed command lines', () => {
  assert.throws(() => parseCommandLine('npm "test'), /unterminated/);
  assert.throws(() => parseCommandLine('   '), /must not be empty/);
  assert.throws(() => parseCommandLine('npm ""'), /arguments must not be empty/);
  assert.throws(() => parseTestCommand('["node","a\\u0000b"]'), /null-containing/);
});
