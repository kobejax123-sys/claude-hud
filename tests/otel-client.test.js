import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseSample, computeTps, readLastSample, readTurnAggregate, getOtelTps, isMainChainQuery,
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

test('computeTps rejects a decode window too short to carry a rate', () => {
  // A relay that buffers the response and flushes it as one frame reports a
  // window that barely moves with the token count, so it measures the flush
  // rather than generation. Every burst in this machine's samples landed under
  // 200ms; genuine streaming never fell below 500ms.
  assert.equal(computeTps({ ts: 'x', outputTokens: 453, durationMs: 4416, ttftMs: 4286 }), null);
  assert.equal(computeTps({ ts: 'x', outputTokens: 200, durationMs: 200, ttftMs: 150 }), null);
  assert.equal(computeTps({ ts: 'x', outputTokens: 680, durationMs: 1000, ttftMs: 950 }), null);
  // The boundary itself is usable.
  assert.equal(computeTps({ ts: 'x', outputTokens: 500, durationMs: 2000, ttftMs: 1500 }), 1000);
});

test('computeTps keeps a fast model rate that a rate ceiling used to discard', () => {
  // 217 tokens over 600ms is 362 tps and 1447 over 1054ms is 1373 tps. Both are
  // real measurements from a fast provider; the ceiling this replaced sat at the
  // 99th percentile of real samples and rejected them for being fast.
  const tps = computeTps({ ts: 'x', outputTokens: 1447, durationMs: 1054, ttftMs: 0 });
  assert.ok(Math.abs(tps - 1372.87) < 0.1, `got ${tps}`);
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
  // 900 tokens in a 3600ms window is a long, well-formed measurement.
  await writeFile(
    file,
    `${sampleLine({ outputTokens: 900, durationMs: 4000, ttftMs: 400 })}\n${sampleLine({ outputTokens: 12, durationMs: 900, ttftMs: 250 })}\n`,
    'utf8',
  );

  const s = readLastSample(file);
  assert.equal(s.outputTokens, 900);
  await rm(dir, { recursive: true, force: true });
});

test('readLastSample holds the last rate through a buffered burst sample', async () => {
  const dir = await makeHome();
  const file = path.join(dir, 's.jsonl');
  // 453 tokens arrive in a 130ms window because the upstream buffered the whole
  // response; the window is the tell, and it must not overwrite the 250 tps.
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

test('readTurnAggregate sums only the samples recorded after the boundary', async () => {
  const dir = await makeHome();
  const file = path.join(dir, 's.jsonl');
  await writeFile(
    file,
    [
      // Previous turn: 600 tokens over a 3000ms window = 200 tps.
      sampleLine({ ts: '2026-09-11T02:00:00.000Z', outputTokens: 600, durationMs: 3100, ttftMs: 100 }),
      // Current turn: 300 over 3000ms=100 tps and 900 over 3000ms=300 tps.
      sampleLine({ ts: '2026-09-11T02:10:00.000Z', outputTokens: 300, durationMs: 3100, ttftMs: 100 }),
      sampleLine({ ts: '2026-09-11T02:11:00.000Z', outputTokens: 900, durationMs: 3100, ttftMs: 100 }),
    ].join('\n') + '\n',
    'utf8',
  );

  const agg = readTurnAggregate(file, Date.parse('2026-09-11T02:05:00.000Z'));
  assert.equal(agg.outputTokens, 1200);
  assert.equal(agg.decodeMs, 6000);
  await rm(dir, { recursive: true, force: true });
});

test('readTurnAggregate skips samples the single-request guards reject', async () => {
  const dir = await makeHome();
  const file = path.join(dir, 's.jsonl');
  // A buffered burst carries real tokens over a window too short to measure.
  // Counting it would drag the turn's rate up, so it is left out of both sums.
  await writeFile(
    file,
    [
      sampleLine({ ts: '2026-09-11T02:10:00.000Z', outputTokens: 500, durationMs: 2000, ttftMs: 1000 }),
      sampleLine({ ts: '2026-09-11T02:11:00.000Z', outputTokens: 680, durationMs: 1050, ttftMs: 1000 }),
    ].join('\n') + '\n',
    'utf8',
  );

  const agg = readTurnAggregate(file, Date.parse('2026-09-11T02:00:00.000Z'));
  assert.equal(agg.outputTokens, 500);
  assert.equal(agg.decodeMs, 1000);
  await rm(dir, { recursive: true, force: true });
});

test('readTurnAggregate returns null when the turn has nothing measurable yet', async () => {
  const dir = await makeHome();
  const file = path.join(dir, 's.jsonl');
  await writeFile(
    file,
    `${sampleLine({ ts: '2026-09-11T02:00:00.000Z' })}\n`,
    'utf8',
  );

  // The only sample predates the boundary, so the caller keeps its old reading.
  assert.equal(readTurnAggregate(file, Date.parse('2026-09-11T02:05:00.000Z')), null);
  assert.equal(readTurnAggregate(path.join(dir, 'missing.jsonl'), 0), null);
  await rm(dir, { recursive: true, force: true });
});

test('readTurnAggregate ignores a sample with an unparseable timestamp', async () => {
  const dir = await makeHome();
  const file = path.join(dir, 's.jsonl');
  // NaN compares false against every bound, so an unguarded comparison would
  // quietly drop the sample rather than reject it on its merits.
  await writeFile(
    file,
    `${sampleLine({ ts: 'not-a-date', outputTokens: 500, durationMs: 2000, ttftMs: 1000 })}\n`,
    'utf8',
  );

  assert.equal(readTurnAggregate(file, 0), null);
  await rm(dir, { recursive: true, force: true });
});

test('getOtelTps aggregates the turn instead of reading the last sample', async () => {
  const home = await makeHome();
  await mkdir(path.join(home, '.claude/plugins/claude-hud/otel'), { recursive: true });
  await writeFile(
    path.join(home, '.claude/plugins/claude-hud/otel/sess-1.jsonl'),
    [
      sampleLine({ ts: '2026-09-11T02:10:00.000Z', outputTokens: 300, durationMs: 3100, ttftMs: 100 }),
      sampleLine({ ts: '2026-09-11T02:11:00.000Z', outputTokens: 900, durationMs: 3100, ttftMs: 100 }),
    ].join('\n') + '\n',
    'utf8',
  );

  // 1200 tokens over 6000ms. The last sample alone would report 300 tps.
  const tps = getOtelTps(home, 'sess-1', Date.parse('2026-09-11T02:05:00.000Z'));
  assert.equal(tps, 200);
  await rm(home, { recursive: true, force: true });
});

test('getOtelTps falls back to the last sample when the turn has none yet', async () => {
  const home = await makeHome();
  await mkdir(path.join(home, '.claude/plugins/claude-hud/otel'), { recursive: true });
  await writeFile(
    path.join(home, '.claude/plugins/claude-hud/otel/sess-1.jsonl'),
    `${sampleLine({ ts: '2026-09-11T02:00:00.000Z' })}\n`,
    'utf8',
  );

  // A newly started turn must hold the previous reading, not blank the segment.
  const tps = getOtelTps(home, 'sess-1', Date.parse('2026-09-11T02:05:00.000Z'));
  assert.ok(Math.abs(tps - 170.06) < 0.1, `got ${tps}`);
  await rm(home, { recursive: true, force: true });
});

test('isMainChainQuery matches the query sources Claude Code calls the main chain', () => {
  // Claude Code classifies these as "main" (Di() in the CLI): the REPL thread
  // with any output-style suffix, and the SDK entrypoint.
  for (const source of ['repl_main_thread', 'repl_main_thread:outputStyle:Concise', 'sdk']) {
    assert.equal(isMainChainQuery(source), true, source);
  }
});

test('isMainChainQuery rejects subagents and auxiliary calls', () => {
  // "subagent" in the CLI's classification.
  for (const source of ['agent:custom', 'agent:default', 'agent:builtin', 'hook_agent']) {
    assert.equal(isMainChainQuery(source), false, source);
  }
  // "auxiliary": not the turn the user is watching.
  for (const source of ['compact', 'side_question', 'web_search_tool', 'auto_mode']) {
    assert.equal(isMainChainQuery(source), false, source);
  }
});

test('isMainChainQuery treats an absent source as main', () => {
  // Samples written before this attribute existed, or by a provider that does
  // not report it, must keep counting rather than silently blank the segment.
  assert.equal(isMainChainQuery(undefined), true);
});

test('readTurnAggregate leaves a subagent out of the turn', async () => {
  const dir = await makeHome();
  const file = path.join(dir, 's.jsonl');
  await writeFile(
    file,
    [
      sampleLine({ ts: '2026-09-11T02:10:00.000Z', outputTokens: 300, durationMs: 3100, ttftMs: 100, querySource: 'repl_main_thread' }),
      // A subagent on the session model: the model name cannot distinguish it,
      // so only the query source keeps it out of the main thread's rate.
      sampleLine({ ts: '2026-09-11T02:10:30.000Z', outputTokens: 5000, durationMs: 6000, ttftMs: 100, querySource: 'agent:default' }),
    ].join('\n') + '\n',
    'utf8',
  );

  const agg = readTurnAggregate(file, Date.parse('2026-09-11T02:00:00.000Z'));
  assert.equal(agg.outputTokens, 300);
  assert.equal(agg.decodeMs, 3000);
  await rm(dir, { recursive: true, force: true });
});

test('readLastSample skips a trailing subagent sample', async () => {
  const dir = await makeHome();
  const file = path.join(dir, 's.jsonl');
  await writeFile(
    file,
    [
      sampleLine({ outputTokens: 900, durationMs: 4000, ttftMs: 400, querySource: 'repl_main_thread' }),
      sampleLine({ outputTokens: 800, durationMs: 4000, ttftMs: 400, querySource: 'agent:builtin' }),
    ].join('\n') + '\n',
    'utf8',
  );

  const s = readLastSample(file);
  assert.equal(s.outputTokens, 900);
  await rm(dir, { recursive: true, force: true });
});

test('getOtelTps returns null for an invalid session id instead of throwing', async () => {
  const home = await makeHome();
  assert.equal(getOtelTps(home, '../evil'), null);
  await rm(home, { recursive: true, force: true });
});
