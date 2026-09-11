import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startReceiver, resolveRetentionDays } from '../dist/otel/entry.js';
import { getPidFilePath } from '../dist/otel/paths.js';

// getClaudeConfigDir() lets CLAUDE_CONFIG_DIR override the passed homeDir,
// which would break every path assertion below. node --test runs each file in
// its own process, so clearing it here is safe.
delete process.env.CLAUDE_CONFIG_DIR;

const SID = '8c494970-8798-4160-9882-ff4611d1b747';

function body(sessionId = SID) {
  return JSON.stringify({
    resourceLogs: [{
      scopeLogs: [{
        logRecords: [{
          body: { stringValue: 'claude_code.api_request' },
          attributes: [
            { key: 'session.id', value: { stringValue: sessionId } },
            { key: 'event.timestamp', value: { stringValue: new Date().toISOString() } },
            { key: 'model', value: { stringValue: 'deepseek-flash' } },
            { key: 'output_tokens', value: { intValue: 217 } },
            { key: 'duration_ms', value: { intValue: 1426 } },
            { key: 'ttft_ms', value: { intValue: 150 } },
          ],
        }],
      }],
    }],
  });
}

async function makeHome() {
  return await mkdtemp(path.join(tmpdir(), 'claude-hud-otel-entry-'));
}

async function withServer(home, fn) {
  const server = await startReceiver({ homeDir: home, port: 0, retentionDays: 7 });
  const port = server.address().port;
  try {
    await fn(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('receiver accepts a logs payload and writes a sample', async () => {
  const home = await makeHome();
  await withServer(home, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body(),
    });
    assert.equal(res.status, 200);
    const content = await readFile(path.join(home, '.claude/plugins/claude-hud/otel', `${SID}.jsonl`), 'utf8');
    assert.equal(JSON.parse(content.trim()).outputTokens, 217);
  });
  await rm(home, { recursive: true, force: true });
});

test('receiver answers 200 on metrics and traces without writing samples', async () => {
  const home = await makeHome();
  await withServer(home, async (port) => {
    for (const p of ['/v1/metrics', '/v1/traces']) {
      const res = await fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', body: '{}' });
      assert.equal(res.status, 200);
    }
  });
  await rm(home, { recursive: true, force: true });
});

test('receiver answers 200 but drops an oversized body', async () => {
  const home = await makeHome();
  await withServer(home, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: 'POST',
      body: 'x'.repeat(1_100_000),
    });
    assert.equal(res.status, 200);

    // The receiver must survive the oversized request: answering it in the data
    // handler and again on 'end' would write the head twice, and that throws
    // inside the event handler.
    const after = await fetch(`http://127.0.0.1:${port}/v1/logs`, { method: 'POST', body: '{}' });
    assert.equal(after.status, 200);
  });
  await rm(home, { recursive: true, force: true });
});

test('receiver answers 200 on a payload that is not valid json', async () => {
  const home = await makeHome();
  await withServer(home, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/logs`, { method: 'POST', body: 'not json' });
    assert.equal(res.status, 200);
  });
  await rm(home, { recursive: true, force: true });
});

test('receiver refuses to start when a live receiver already claimed the pidfile', async () => {
  const home = await makeHome();
  const first = await startReceiver({ homeDir: home, port: 0, retentionDays: 7 });
  try {
    await assert.rejects(
      startReceiver({ homeDir: home, port: 0, retentionDays: 7 }),
      /already running/,
    );
  } finally {
    await new Promise((resolve) => first.close(resolve));
  }
  await rm(home, { recursive: true, force: true });
});

test('startReceiver replaces a pidfile left by a dead process', async () => {
  const home = await makeHome();
  const pidPath = getPidFilePath(home);
  await mkdir(path.dirname(pidPath), { recursive: true });
  await writeFile(
    pidPath,
    JSON.stringify({ pid: 2147483646, entry: '/gone/entry.js', port: 4318 }),
    'utf8',
  );

  const server = await startReceiver({ homeDir: home, port: 0, retentionDays: 7 });
  try {
    const record = JSON.parse(await readFile(pidPath, 'utf8'));
    assert.equal(record.pid, process.pid);

    // The claim goes through a staging file; leaving one behind would accumulate
    // clutter in the sample directory.
    const staging = (await readdir(path.dirname(pidPath))).filter((name) => name.includes('.claim'));
    assert.deepEqual(staging, []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  await rm(home, { recursive: true, force: true });
});

test('startReceiver records its own pid in the pidfile', async () => {
  const home = await makeHome();
  const server = await startReceiver({ homeDir: home, port: 0, retentionDays: 7 });
  try {
    const record = JSON.parse(await readFile(getPidFilePath(home), 'utf8'));
    assert.equal(record.pid, process.pid);
    assert.ok(record.entry.endsWith(path.join('otel', 'entry.js')));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  await rm(home, { recursive: true, force: true });
});

test('a server error after listen does not become an uncaught exception', async () => {
  const home = await makeHome();
  const server = await startReceiver({ homeDir: home, port: 0, retentionDays: 7 });
  try {
    // An 'error' event with no listener throws, taking the receiver down and
    // dropping telemetry until the next lazy start.
    assert.doesNotThrow(() => server.emit('error', new Error('accept EMFILE')));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  await rm(home, { recursive: true, force: true });
});

test('resolveRetentionDays accepts a configured value and rejects anything unusable', () => {
  assert.equal(resolveRetentionDays('3'), 3);
  assert.equal(resolveRetentionDays('0'), 0);

  // A negative retention prunes every sample the instant it is written, so the
  // rate could never accumulate; it must fall back rather than propagate.
  assert.equal(resolveRetentionDays('-1'), 7);
  assert.equal(resolveRetentionDays('1.5'), 7);
  assert.equal(resolveRetentionDays('nonsense'), 7);
  assert.equal(resolveRetentionDays(''), 7);
  assert.equal(resolveRetentionDays(undefined), 7);
});
