import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getOutputSpeed } from '../dist/speed.js';

// getClaudeConfigDir() lets CLAUDE_CONFIG_DIR override the passed homeDir.
delete process.env.CLAUDE_CONFIG_DIR;
// A remote endpoint keeps getOutputSpeed from spawning a real receiver.
process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = 'http://collector.invalid:4318';

const NO_TURNS = { tools: [], skills: [], mcpServers: [], mcpErrors: [], agents: [], todos: [] };

async function homeWith(sessionId, samples) {
  const home = await mkdtemp(path.join(tmpdir(), 'hud-speed-'));
  const dir = path.join(home, '.claude/plugins/claude-hud/otel');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${sessionId}.jsonl`), samples.map((s) => `${JSON.stringify(s)}\n`).join(''), 'utf8');
  return home;
}

async function withTelemetry(value, fn) {
  const prev = process.env.CLAUDE_CODE_ENABLE_TELEMETRY;
  if (value === undefined) delete process.env.CLAUDE_CODE_ENABLE_TELEMETRY;
  else process.env.CLAUDE_CODE_ENABLE_TELEMETRY = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_ENABLE_TELEMETRY;
    else process.env.CLAUDE_CODE_ENABLE_TELEMETRY = prev;
  }
}

const SAMPLE = { ts: '2026-09-11T02:52:24.425Z', outputTokens: 217, durationMs: 1426, ttftMs: 150 };

test('speed is the measured output over the decode window', async () => {
  const home = await homeWith('sess-otel', [SAMPLE]);
  try {
    const tps = await withTelemetry('1', () => getOutputSpeed({ session_id: 'sess-otel' }, home, NO_TURNS));
    assert.ok(Math.abs(tps - 217 / 1.276) < 0.1, `got ${tps}`);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('speed is null until a request has been measured', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'hud-speed-'));
  try {
    assert.equal(await withTelemetry('1', () => getOutputSpeed({ session_id: 'sess-none' }, home, NO_TURNS)), null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('speed is null when telemetry is off or the session id is unusable', async () => {
  const home = await homeWith('sess-otel', [SAMPLE]);
  try {
    assert.equal(await withTelemetry(undefined, () => getOutputSpeed({ session_id: 'sess-otel' }, home, NO_TURNS)), null);
    assert.equal(await withTelemetry('0', () => getOutputSpeed({ session_id: 'sess-otel' }, home, NO_TURNS)), null);
    assert.equal(await withTelemetry('1', () => getOutputSpeed({ session_id: '../x' }, home, NO_TURNS)), null);
    assert.equal(await withTelemetry('1', () => getOutputSpeed({}, home, NO_TURNS)), null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('speed aggregates the turn in progress, after the last turn boundary', async () => {
  const before = { ts: '2026-09-11T02:00:00.000Z', outputTokens: 1000, durationMs: 11000, ttftMs: 1000 }; // 100 tps
  const after = { ts: '2026-09-11T03:00:00.000Z', outputTokens: 1000, durationMs: 6000, ttftMs: 1000 }; // 200 tps
  const home = await homeWith('sess-turn', [before, after]);
  try {
    const transcript = { ...NO_TURNS, lastTurnEndAt: new Date('2026-09-11T02:30:00.000Z') };
    const tps = await withTelemetry('1', () => getOutputSpeed({ session_id: 'sess-turn' }, home, transcript));
    assert.equal(Math.round(tps), 200);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
