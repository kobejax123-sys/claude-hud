import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isValidSessionId, getOtelDir, getSamplePath, getPidFilePath } from '../dist/otel/paths.js';

// getClaudeConfigDir() lets CLAUDE_CONFIG_DIR override the passed homeDir,
// which would break every path assertion below. node --test runs each file in
// its own process, so clearing it here is safe.
delete process.env.CLAUDE_CONFIG_DIR;

test('isValidSessionId accepts a uuid-style session id', () => {
  assert.equal(isValidSessionId('8c494970-8798-4160-9882-ff4611d1b747'), true);
});

test('isValidSessionId rejects path traversal', () => {
  assert.equal(isValidSessionId('../../etc/passwd'), false);
  assert.equal(isValidSessionId('a/b'), false);
  assert.equal(isValidSessionId('..'), false);
});

test('isValidSessionId rejects empty, overlong and non-string input', () => {
  assert.equal(isValidSessionId(''), false);
  assert.equal(isValidSessionId('a'.repeat(65)), false);
  assert.equal(isValidSessionId(undefined), false);
  assert.equal(isValidSessionId(123), false);
  assert.equal(isValidSessionId('has space'), false);
});

test('isValidSessionId accepts a 64-character id and rejects 65', () => {
  assert.equal(isValidSessionId('a'.repeat(64)), true);
  assert.equal(isValidSessionId('a'.repeat(65)), false);
});

test('isValidSessionId rejects backslashes and dot-only ids', () => {
  assert.equal(isValidSessionId('a\\b'), false);
  assert.equal(isValidSessionId('.'), false);
  assert.equal(isValidSessionId('...'), false);
});

test('getSamplePath refuses an invalid session id', () => {
  assert.throws(() => getSamplePath('/home/u', '../evil'), /Invalid session id/);
});

test('getSamplePath builds a path under the hud plugin dir', () => {
  const p = getSamplePath('/home/u', 'abc-123');
  assert.equal(p, path.join('/home/u', '.claude', 'plugins', 'claude-hud', 'otel', 'abc-123.jsonl'));
});

test('getOtelDir and getPidFilePath agree on the directory', () => {
  const dir = getOtelDir('/home/u');
  assert.equal(dir, path.join('/home/u', '.claude', 'plugins', 'claude-hud', 'otel'));
  assert.equal(getPidFilePath('/home/u'), path.join(dir, 'receiver.pid'));
});
