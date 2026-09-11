import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseSample, computeTps, readLastSample, getOtelTps,
} from '../dist/otel/client.js';

// getClaudeConfigDir() lets CLAUDE_CONFIG_DIR override the passed homeDir,
// which would break every path assertion below. node --test runs each file in
// its own process, so clearing it here is safe.
delete process.env.CLAUDE_CONFIG_DIR;

function sampleLine(overrides = {}) {
  return JSON.stringify({
    ts: '2026-09-11T02:52:24.425Z',
    model: 'deepseek-flash',
    outputTokens: 217,
    durationMs: 1426,
    ttftMs: 150,
    ...overrides,
  });
}

async function makeHome() {
  return await mkdtemp(path.join(tmpdir(), 'claude-hud-otel-client-'));
}

test('parseSample returns null on malformed json', () => {
  assert.equal(parseSample('not json'), null);
  assert.equal(parseSample(''), null);
});

test('parseSample returns null when a numeric field is missing or wrong type', () => {
  assert.equal(parseSample(JSON.stringify({ ts: 'x', durationMs: 1, ttftMs: 0 })), null);
  assert.equal(parseSample(JSON.stringify({ ts: 'x', outputTokens: '217', durationMs: 1, ttftMs: 0 })), null);
  assert.equal(parseSample(JSON.stringify({ outputTokens: 1, durationMs: 1, ttftMs: 0 })), null);
});

test('parseSample accepts a well-formed line', () => {
  const s = parseSample(sampleLine());
  assert.equal(s.outputTokens, 217);
  assert.equal(s.durationMs, 1426);
  assert.equal(s.ttftMs, 150);
  assert.equal(s.model, 'deepseek-flash');
});

test('computeTps divides output tokens by decode time', () => {
  const tps = computeTps({ ts: 'x', outputTokens: 217, durationMs: 1426, ttftMs: 150 });
  assert.ok(Math.abs(tps - 170.06) < 0.1, `got ${tps}`);
});

test('computeTps rejects output below the usable floor', () => {
  // The measured window carries a fixed per-request cost that dominates a short
  // reply, so its rate says more about the response tail than about generation.
  assert.equal(computeTps({ ts: 'x', outputTokens: 0, durationMs: 1426, ttftMs: 150 }), null);
  assert.equal(computeTps({ ts: 'x', outputTokens: 149, durationMs: 1426, ttftMs: 150 }), null);
});

test('computeTps accepts output exactly at the floor', () => {
  assert.equal(computeTps({ ts: 'x', outputTokens: 150, durationMs: 1000, ttftMs: 0 }), 150);
});

test('computeTps rejects an inverted timeline', () => {
  assert.equal(computeTps({ ts: 'x', outputTokens: 200, durationMs: 100, ttftMs: 200 }), null);
  assert.equal(computeTps({ ts: 'x', outputTokens: 200, durationMs: 100, ttftMs: 100 }), null);
});

test('computeTps rejects a non-finite result', () => {
  // A finite-but-huge token count over a short decode window overflows to
  // Infinity, which the statusline would render verbatim.
  assert.equal(computeTps({ ts: 'x', outputTokens: 1e308, durationMs: 200, ttftMs: 0 }), null);
  assert.equal(computeTps({ ts: 'x', outputTokens: Number.MAX_VALUE, durationMs: 100, ttftMs: 0 }), null);
});

test('computeTps rejects a rate exceeding the 500 tps ceiling', () => {
  // When an upstream proxy buffers streaming tokens and dumps them in a burst
  // (e.g. 453 tokens in 130ms = 3485 tps), the rate is rejected.
  assert.equal(computeTps({ ts: 'x', outputTokens: 453, durationMs: 4416, ttftMs: 4286 }), null);
  assert.equal(computeTps({ ts: 'x', outputTokens: 501, durationMs: 2000, ttftMs: 1000 }), null);
  // A near-zero decode window needs no guard of its own: 200 tokens over 50ms is
  // 4000 tps, so the ceiling already rejects it.
  assert.equal(computeTps({ ts: 'x', outputTokens: 200, durationMs: 200, ttftMs: 150 }), null);
  // Exactly 500 tps is accepted
  assert.equal(computeTps({ ts: 'x', outputTokens: 500, durationMs: 2000, ttftMs: 1000 }), 500);
});

test('readLastSample skips a truncated trailing line and finds the last good one', async () => {
  const dir = await makeHome();
  const file = path.join(dir, 's.jsonl');
  await writeFile(file, `${sampleLine({ outputTokens: 100 })}\n${sampleLine({ outputTokens: 200 })}\n{"ts":"broken"`, 'utf8');
  const s = readLastSample(file);
  assert.equal(s.outputTokens, 200);
  await rm(dir, { recursive: true, force: true });
});

test('readLastSample returns null for a missing file', () => {
  assert.equal(readLastSample('/nonexistent/nope.jsonl'), null);
});

test('readLastSample skips a trailing sample the guards reject', async () => {
  const dir = await makeHome();
  const file = path.join(dir, 's.jsonl');
  // An interrupted request is recorded with no output. Returning it would blank a
  // segment that is meant to hold the last rate the session actually measured.
  await writeFile(
    file,
    `${sampleLine({ outputTokens: 300 })}\n${sampleLine({ outputTokens: 0, durationMs: 900, ttftMs: 150 })}\n`,
    'utf8',
  );

  const s = readLastSample(file);
  assert.equal(s.outputTokens, 300);
  await rm(dir, { recursive: true, force: true });
});

test('readLastSample holds the last rate through a short reply', async () => {
  const dir = await makeHome();
  const file = path.join(dir, 's.jsonl');
  // A 12-token reply measures mostly the tail of the response rather than
  // generation, so it must not replace a rate that was measured properly.
  // 900 tokens in 3600ms = 250 tps is well within the 500 tps ceiling.
  await writeFile(
    file,
    `${sampleLine({ outputTokens: 900, durationMs: 4000, ttftMs: 400 })}\n${sampleLine({ outputTokens: 12, durationMs: 900, ttftMs: 250 })}\n`,
    'utf8',
  );

  const s = readLastSample(file);
  assert.equal(s.outputTokens, 900);
  await rm(dir, { recursive: true, force: true });
});

test('readLastSample holds the last rate through an implausibly high burst sample', async () => {
  const dir = await makeHome();
  const file = path.join(dir, 's.jsonl');
  // 453 tokens in 130ms = 3485 tps (buffered upstream dumping); must not overwrite 250 tps
  await writeFile(
    file,
    `${sampleLine({ outputTokens: 250, durationMs: 1150, ttftMs: 150 })}\n${sampleLine({ outputTokens: 453, durationMs: 4416, ttftMs: 4286 })}\n`,
    'utf8',
  );

  const s = readLastSample(file);
  assert.equal(s.outputTokens, 250);
  await rm(dir, { recursive: true, force: true });
});

test('getOtelTps keeps the previous rate when the newest sample is unusable', async () => {
  const home = await makeHome();
  await mkdir(path.join(home, '.claude/plugins/claude-hud/otel'), { recursive: true });
  await writeFile(
    path.join(home, '.claude/plugins/claude-hud/otel/sess-1.jsonl'),
    `${sampleLine()}\n${sampleLine({ outputTokens: 0 })}\n`,
    'utf8',
  );

  const tps = getOtelTps(home, 'sess-1');
  assert.ok(Math.abs(tps - 170.06) < 0.1, `got ${tps}`);
  await rm(home, { recursive: true, force: true });
});

test('readLastSample keeps a complete first line when the tail window starts on a boundary', async () => {
  const dir = await makeHome();
  const file = path.join(dir, 's.jsonl');

  const good = sampleLine({ outputTokens: 555 });
  const prefix = 'x'.repeat(10);
  // Size the filler so the 8192-byte tail window begins exactly at `good`,
  // leaving the newline that precedes it just outside the window. A window that
  // starts by skipping `lines[0]` would discard `good` and return null.
  const fillerLength = 8192 - good.length - 1;
  await writeFile(file, `${prefix}\n${good}\n${'y'.repeat(fillerLength)}`, 'utf8');

  const s = readLastSample(file);
  assert.equal(s?.outputTokens, 555);
  await rm(dir, { recursive: true, force: true });
});

test('getOtelTps returns the computed rate', async () => {
  const home = await makeHome();
  await mkdir(path.join(home, '.claude/plugins/claude-hud/otel'), { recursive: true });
  await writeFile(path.join(home, '.claude/plugins/claude-hud/otel/sess-1.jsonl'), `${sampleLine()}\n`, 'utf8');
  const tps = getOtelTps(home, 'sess-1');
  assert.ok(Math.abs(tps - 170.06) < 0.1, `got ${tps}`);
  await rm(home, { recursive: true, force: true });
});

test('getOtelTps keeps reporting an old sample instead of expiring it', async () => {
  const home = await makeHome();
  await mkdir(path.join(home, '.claude/plugins/claude-hud/otel'), { recursive: true });
  await writeFile(
    path.join(home, '.claude/plugins/claude-hud/otel/sess-1.jsonl'),
    `${sampleLine({ ts: '2020-01-01T00:00:00.000Z' })}\n`,
    'utf8',
  );
  const tps = getOtelTps(home, 'sess-1');
  assert.ok(Math.abs(tps - 170.06) < 0.1, `got ${tps}`);
  await rm(home, { recursive: true, force: true });
});

test('getOtelTps returns null for an invalid session id instead of throwing', async () => {
  const home = await makeHome();
  assert.equal(getOtelTps(home, '../evil'), null);
  await rm(home, { recursive: true, force: true });
});
