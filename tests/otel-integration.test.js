import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startReceiver } from '../dist/otel/entry.js';
import { getMeasuredTps } from '../dist/speed-tracker.js';
import { mergeConfig } from '../dist/config.js';

// getClaudeConfigDir() lets CLAUDE_CONFIG_DIR override the passed homeDir,
// which would break every path assertion below. node --test runs each file in
// its own process, so clearing it here is safe.
delete process.env.CLAUDE_CONFIG_DIR;

const SID = '11111111-2222-3333-4444-555555555555';

function payload(ttftMs, durationMs, outputTokens, ts) {
  return JSON.stringify({
    resourceLogs: [{
      scopeLogs: [{
        logRecords: [{
          body: { stringValue: 'claude_code.api_request' },
          attributes: [
            { key: 'session.id', value: { stringValue: SID } },
            { key: 'event.timestamp', value: { stringValue: ts } },
            { key: 'model', value: { stringValue: 'deepseek-flash' } },
            { key: 'output_tokens', value: { intValue: outputTokens } },
            { key: 'duration_ms', value: { intValue: durationMs } },
            { key: 'ttft_ms', value: { intValue: ttftMs } },
          ],
        }],
      }],
    }],
  });
}

test('a request captured over http becomes a measured tps reading', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'claude-hud-otel-int-'));
  const server = await startReceiver({ homeDir: home, port: 0, retentionDays: 7 });
  const port = server.address().port;

  const prev = process.env.CLAUDE_CODE_ENABLE_TELEMETRY;
  process.env.CLAUDE_CODE_ENABLE_TELEMETRY = '1';

  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload(150, 1426, 217, '2026-09-11T02:52:24.425Z'),
    });
    assert.equal(res.status, 200);

    const tps = getMeasuredTps(
      { session_id: SID, transcript_path: path.join(home, 't.jsonl') },
      mergeConfig({ otel: { autoStart: false } }),
      { homeDir: () => home },
    );

    assert.ok(Math.abs(tps - 170.06) < 0.1, `got ${tps}`);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_ENABLE_TELEMETRY;
    else process.env.CLAUDE_CODE_ENABLE_TELEMETRY = prev;
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test('an old measurement is still reported', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'claude-hud-otel-int-'));
  const server = await startReceiver({ homeDir: home, port: 0, retentionDays: 7 });
  const port = server.address().port;

  const prev = process.env.CLAUDE_CODE_ENABLE_TELEMETRY;
  process.env.CLAUDE_CODE_ENABLE_TELEMETRY = '1';

  try {
    await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload(150, 1426, 217, '2026-09-11T02:52:24.425Z'),
    });

    const tps = getMeasuredTps(
      { session_id: SID, transcript_path: path.join(home, 't.jsonl') },
      mergeConfig({ otel: { autoStart: false } }),
      { homeDir: () => home },
    );

    assert.ok(Math.abs(tps - 170.06) < 0.1, `got ${tps}`);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_ENABLE_TELEMETRY;
    else process.env.CLAUDE_CODE_ENABLE_TELEMETRY = prev;
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});
