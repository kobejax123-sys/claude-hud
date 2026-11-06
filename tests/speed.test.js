import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTps, getOutputSpeed, isMainChainQuery, parseSample } from '../src/speed.ts';

const NO_TURNS = { tools: [], skills: [], mcpServers: [], mcpErrors: [], agents: [], todos: [] };
const turns = (last, previous) => ({ ...NO_TURNS, lastTurnEndAt: new Date(last), ...(previous ? { previousTurnEndAt: new Date(previous) } : {}) });
const text = (...samples) => samples.map((s) => (typeof s === 'string' ? s : JSON.stringify(s))).join('\n') + '\n';
// outputTokens over (durationMs - ttftMs): 100 tps and 200 tps.
const at = (ts, tps, extra = {}) => ({ ts, outputTokens: 1000, durationMs: 1000 + 1_000_000 / tps, ttftMs: 1000, ...extra });

test('parseSample takes a well-formed line and refuses anything else', () => {
  assert.deepEqual(parseSample('{"ts":"2026-09-11T02:52:24.425Z","model":"m","querySource":"sdk","outputTokens":217,"durationMs":1426,"ttftMs":150}'),
    { ts: '2026-09-11T02:52:24.425Z', model: 'm', querySource: 'sdk', outputTokens: 217, durationMs: 1426, ttftMs: 150 });
  assert.equal(parseSample('{"ts":"x","outputTokens":'), null);
  assert.equal(parseSample('{"ts":"x","outputTokens":"217","durationMs":1426,"ttftMs":150}'), null);
  assert.equal(parseSample('{"outputTokens":217,"durationMs":1426,"ttftMs":150}'), null);
  assert.equal(parseSample('null'), null);
});

test('computeTps is output over the decode window, behind the floors', () => {
  assert.ok(Math.abs(computeTps({ outputTokens: 217, durationMs: 1426, ttftMs: 150 }) - 217 / 1.276) < 1e-9);
  assert.equal(computeTps({ outputTokens: 149, durationMs: 5000, ttftMs: 0 }), null, 'under 150 tokens');
  assert.equal(computeTps({ outputTokens: 150, durationMs: 1500, ttftMs: 0 }), 100, 'exactly at the token floor');
  assert.equal(computeTps({ outputTokens: 300, durationMs: 100, ttftMs: 200 }), null, 'an inverted timeline');
  assert.equal(computeTps({ outputTokens: 300, durationMs: 1000, ttftMs: -1 }), null, 'a negative first-token wait');
  assert.equal(computeTps({ outputTokens: 195, durationMs: 534, ttftMs: 500 }), null, 'a buffered burst under 500ms');
  assert.equal(computeTps({ outputTokens: Number.MAX_VALUE, durationMs: 1501, ttftMs: 1000 }), null, 'a rate that overflows');
  assert.equal(computeTps({ outputTokens: 5000, durationMs: 6000, ttftMs: 1000 }), 1000, 'a fast model is kept');
});

test('isMainChainQuery keeps the main chain and an absent source, and drops subagents and side calls', () => {
  for (const source of [undefined, 'repl_main_thread', 'repl_main_thread:outputStyle:Concise', 'sdk']) assert.equal(isMainChainQuery(source), true, source);
  for (const source of ['agent:explore', 'hook_agent', 'compact', 'side_question', 'web_search']) assert.equal(isMainChainQuery(source), false, source);
});

test('speed is null without samples: telemetry off, nothing recorded, or nothing measurable', () => {
  assert.equal(getOutputSpeed(null, NO_TURNS), null);
  assert.equal(getOutputSpeed(undefined, NO_TURNS), null);
  assert.equal(getOutputSpeed('', NO_TURNS), null);
  assert.equal(getOutputSpeed(text({ ts: '2026-09-11T02:00:00Z', outputTokens: 12, durationMs: 900, ttftMs: 100 }), NO_TURNS), null);
});

test('speed sums the turn in progress, after the last turn boundary', () => {
  const samples = text(at('2026-09-11T02:00:00Z', 100), at('2026-09-11T03:00:00Z', 200), at('2026-09-11T03:01:00Z', 200));
  assert.equal(Math.round(getOutputSpeed(samples, turns('2026-09-11T02:30:00Z'))), 200);
});

test('speed sums from the session start until the first turn ends', () => {
  // 2000 tokens over 15s: the two requests weighed by their windows, not averaged.
  assert.equal(Math.round(getOutputSpeed(text(at('2026-09-11T02:00:00Z', 100), at('2026-09-11T02:01:00Z', 200)), NO_TURNS)), 133);
});

test('speed holds the last completed turn until the turn in progress has a measured request', () => {
  const samples = text(
    at('2026-09-11T01:00:00Z', 50), // before the previous boundary: not that turn
    at('2026-09-11T02:10:00Z', 100),
    at('2026-09-11T02:20:00Z', 100),
    { ts: '2026-09-11T03:10:00Z', outputTokens: 20, durationMs: 900, ttftMs: 100 }, // this turn, too short to count
  );
  assert.equal(Math.round(getOutputSpeed(samples, turns('2026-09-11T03:00:00Z', '2026-09-11T02:00:00Z'))), 100);
});

test('speed falls back to the last measured request when neither turn has one', () => {
  const samples = text(at('2026-09-11T01:00:00Z', 50), at('2026-09-11T01:30:00Z', 80));
  assert.equal(Math.round(getOutputSpeed(samples, turns('2026-09-11T03:00:00Z', '2026-09-11T02:00:00Z'))), 80);
});

test('speed leaves out subagents, unparseable timestamps and truncated lines', () => {
  const samples = text(
    at('2026-09-11T03:00:00Z', 100, { querySource: 'repl_main_thread' }),
    at('2026-09-11T03:01:00Z', 900, { querySource: 'agent:explore' }),
    at('not a time', 900),
    '{"ts":"2026-09-11T03:02:00Z","outputTokens":1000,"durat',
  );
  assert.equal(Math.round(getOutputSpeed(samples, turns('2026-09-11T02:00:00Z'))), 100);
});
