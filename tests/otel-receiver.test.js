import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  extractSamples, appendSamples, pruneOldSamples, MAX_BODY_BYTES, MAX_SAMPLE_FILES,
} from '../dist/otel/receiver.js';

// getClaudeConfigDir() lets CLAUDE_CONFIG_DIR override the passed homeDir,
// which would break every path assertion below. node --test runs each file in
// its own process, so clearing it here is safe.
delete process.env.CLAUDE_CONFIG_DIR;

const SID = '8c494970-8798-4160-9882-ff4611d1b747';

function payload(records) {
  return { resourceLogs: [{ resource: { attributes: [] }, scopeLogs: [{ scope: { name: 'com.anthropic.claude_code.events' }, logRecords: records }] }] };
}

function apiRequest(overrides = {}) {
  const attrs = {
    'session.id': SID,
    'event.timestamp': '2026-09-11T02:52:24.425Z',
    model: 'deepseek-flash',
    output_tokens: 217,
    duration_ms: 1426,
    ttft_ms: 150,
    ...overrides,
  };
  return {
    body: { stringValue: 'claude_code.api_request' },
    attributes: Object.entries(attrs)
      .filter(([, v]) => v !== undefined)
      .map(([key, value]) => ({
        key,
        value: typeof value === 'number' ? { intValue: value } : { stringValue: value },
      })),
  };
}

async function makeHome() {
  return await mkdtemp(path.join(tmpdir(), 'claude-hud-otel-recv-'));
}

test('extractSamples pulls the api_request record', () => {
  const out = extractSamples(payload([apiRequest()]));
  assert.equal(out.length, 1);
  assert.equal(out[0].sessionId, SID);
  assert.deepEqual(JSON.parse(out[0].line), {
    ts: '2026-09-11T02:52:24.425Z',
    model: 'deepseek-flash',
    outputTokens: 217,
    durationMs: 1426,
    ttftMs: 150,
  });
});

test('extractSamples ignores non api_request records', () => {
  const rec = apiRequest();
  rec.body = { stringValue: 'claude_code.user_prompt' };
  assert.deepEqual(extractSamples(payload([rec])), []);
});

test('extractSamples rejects a session id containing path traversal', () => {
  assert.deepEqual(extractSamples(payload([apiRequest({ 'session.id': '../../etc/passwd' })])), []);
});

test('extractSamples drops records missing a required numeric field', () => {
  assert.deepEqual(extractSamples(payload([apiRequest({ output_tokens: undefined })])), []);
  assert.deepEqual(extractSamples(payload([apiRequest({ duration_ms: undefined })])), []);
  assert.deepEqual(extractSamples(payload([apiRequest({ ttft_ms: undefined })])), []);
  assert.deepEqual(extractSamples(payload([apiRequest({ 'event.timestamp': undefined })])), []);
});

test('extractSamples tolerates numeric fields encoded as strings', () => {
  const out = extractSamples(payload([apiRequest({ duration_ms: '1426' })]));
  assert.equal(JSON.parse(out[0].line).durationMs, 1426);
});

test('extractSamples tolerates a missing model field', () => {
  const out = extractSamples(payload([apiRequest({ model: undefined })]));
  assert.equal(JSON.parse(out[0].line).model, undefined);
});

test('extractSamples returns empty for a malformed payload', () => {
  assert.deepEqual(extractSamples(null), []);
  assert.deepEqual(extractSamples({}), []);
  assert.deepEqual(extractSamples({ resourceLogs: 'nope' }), []);
});

test('appendSamples writes one jsonl line per sample under the session id', async () => {
  const home = await makeHome();
  appendSamples(home, extractSamples(payload([apiRequest(), apiRequest({ output_tokens: 300 })])));
  const content = await readFile(path.join(home, '.claude/plugins/claude-hud/otel', `${SID}.jsonl`), 'utf8');
  const lines = content.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).outputTokens, 300);
  await rm(home, { recursive: true, force: true });
});

test('pruneOldSamples removes files past the retention window and keeps fresh ones', async () => {
  const home = await makeHome();
  const dir = path.join(home, '.claude/plugins/claude-hud/otel');
  appendSamples(home, extractSamples(payload([apiRequest()])));

  const stale = path.join(dir, 'old-session.jsonl');
  await writeFile(stale, '{}\n', 'utf8');
  const old = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000);
  await utimes(stale, old, old);

  pruneOldSamples(home, 7, Date.now());

  const remaining = await readFile(path.join(dir, `${SID}.jsonl`), 'utf8');
  assert.ok(remaining.includes('outputTokens'));
  await assert.rejects(readFile(stale, 'utf8'));
  await rm(home, { recursive: true, force: true });
});

test('pruneOldSamples ignores a missing directory', async () => {
  const home = await makeHome();
  pruneOldSamples(home, 7, Date.now());
  await rm(home, { recursive: true, force: true });
});

test('pruneOldSamples evicts the oldest files past the file-count ceiling', async () => {
  const home = await makeHome();
  const dir = path.join(home, '.claude/plugins/claude-hud/otel');
  await mkdir(dir, { recursive: true });

  const line = `${JSON.stringify({ ts: 'x', outputTokens: 1, durationMs: 200, ttftMs: 0 })}\n`;
  const total = MAX_SAMPLE_FILES + 5;
  for (let i = 0; i < total; i++) {
    const file = path.join(dir, `s${String(i).padStart(3, '0')}.jsonl`);
    await writeFile(file, line, 'utf8');
    // Distinct mtimes make the eviction order deterministic.
    const at = new Date(Date.now() - (total - i) * 1000);
    await utimes(file, at, at);
  }

  pruneOldSamples(home, 7, Date.now());

  const remaining = (await readdir(dir)).filter((name) => name.endsWith('.jsonl'));
  assert.equal(remaining.length, MAX_SAMPLE_FILES);
  assert.ok(remaining.includes('s104.jsonl'), 'the newest must survive');
  assert.ok(!remaining.includes('s000.jsonl'), 'the oldest must go first');
  await rm(home, { recursive: true, force: true });
});

test('pruneOldSamples evicts the oldest files past the size ceiling', async () => {
  const home = await makeHome();
  const dir = path.join(home, '.claude/plugins/claude-hud/otel');
  await mkdir(dir, { recursive: true });

  // Nine files that are each still legal on their own already exceed the
  // directory ceiling, which the per-file cap cannot catch.
  const chunk = 'x'.repeat(8 * 1024 * 1024);
  for (let i = 0; i < 9; i++) {
    const file = path.join(dir, `s${i}.jsonl`);
    await writeFile(file, chunk, 'utf8');
    const at = new Date(Date.now() - (9 - i) * 1000);
    await utimes(file, at, at);
  }

  pruneOldSamples(home, 7, Date.now());

  const remaining = (await readdir(dir)).filter((name) => name.endsWith('.jsonl'));
  assert.equal(remaining.length, 8);
  assert.ok(remaining.includes('s8.jsonl'), 'the newest must survive');
  assert.ok(!remaining.includes('s0.jsonl'));
  await rm(home, { recursive: true, force: true });
});

test('MAX_BODY_BYTES is a sane upper bound', () => {
  assert.ok(MAX_BODY_BYTES >= 64 * 1024 && MAX_BODY_BYTES <= 8 * 1024 * 1024);
});

test('appendSamples trims a sample file that outgrew the cap', async () => {
  const home = await makeHome();
  const dir = path.join(home, '.claude/plugins/claude-hud/otel');
  const file = path.join(dir, `${SID}.jsonl`);

  // Age-based pruning cannot bound a file that is still being written to, since
  // every append refreshes its mtime.
  const filler = `${JSON.stringify({ ts: 'x', outputTokens: 1, durationMs: 200, ttftMs: 0 })}\n`;
  const oversized = filler.repeat(Math.ceil((9 * 1024 * 1024) / filler.length));
  await mkdir(dir, { recursive: true });
  await writeFile(file, oversized, 'utf8');
  assert.ok((await stat(file)).size > 8 * 1024 * 1024);

  appendSamples(home, [{
    sessionId: SID,
    line: JSON.stringify({ ts: 'y', outputTokens: 7, durationMs: 900, ttftMs: 100 }),
  }]);

  const size = (await stat(file)).size;
  assert.ok(size < 64 * 1024, `expected a trimmed file, got ${size} bytes`);

  const lines = (await readFile(file, 'utf8')).trim().split('\n');
  assert.deepEqual(JSON.parse(lines[lines.length - 1]).outputTokens, 7);
  // Every retained line must still be whole.
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
  await rm(home, { recursive: true, force: true });
});

test('appendSamples leaves a file under the cap alone', async () => {
  const home = await makeHome();
  const dir = path.join(home, '.claude/plugins/claude-hud/otel');
  const file = path.join(dir, `${SID}.jsonl`);

  appendSamples(home, [{ sessionId: SID, line: JSON.stringify({ ts: 'a', outputTokens: 1, durationMs: 200, ttftMs: 0 }) }]);
  appendSamples(home, [{ sessionId: SID, line: JSON.stringify({ ts: 'b', outputTokens: 2, durationMs: 300, ttftMs: 0 }) }]);

  const lines = (await readFile(file, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2, 'a small file must keep its history');
  await rm(home, { recursive: true, force: true });
});
