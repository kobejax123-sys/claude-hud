import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  MAX_BODY_BYTES, MAX_SAMPLE_FILE_BYTES, MAX_SAMPLE_FILES, SELF, appendSamples, extractSamples, isValidSessionId,
  pruneOldSamples, readPidRecord, startReceiver,
} from '../otel-receiver.mjs';

const attr = (key, value) => ({ key, value: typeof value === 'number' ? { intValue: value } : { stringValue: value } });
const record = (attrs, body = 'claude_code.api_request') => ({ body: { stringValue: body }, attributes: Object.entries(attrs).map(([k, v]) => attr(k, v)) });
const payload = (...records) => ({ resourceLogs: [{ scopeLogs: [{ logRecords: records }] }] });
const REQUEST = { 'session.id': 'sess-1', 'event.timestamp': '2026-09-11T02:52:24.425Z', model: 'm', output_tokens: 217, duration_ms: 1426, ttft_ms: 150 };

async function withDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'hud-otel-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const post = (port, urlPath, body) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
    res.resume();
    res.on('end', () => resolve(res.statusCode));
  });
  req.on('error', reject);
  req.end(body);
});

test('isValidSessionId takes uuid-style ids and refuses anything that could leave the directory', () => {
  assert.equal(isValidSessionId('0b7c3d0e-1f2a-4b5c-8d9e-0f1a2b3c4d5e'), true);
  assert.equal(isValidSessionId('a'.repeat(64)), true);
  for (const bad of ['../x', 'a/b', 'a\\b', '..', '.', '', 'a'.repeat(65), 7, null, undefined]) assert.equal(isValidSessionId(bad), false, String(bad));
});

test('extractSamples keeps the api_request timings and which chain asked', () => {
  assert.deepEqual(extractSamples(payload(record({ ...REQUEST, query_source: 'repl_main_thread' }))), [{
    sessionId: 'sess-1',
    line: JSON.stringify({ ts: '2026-09-11T02:52:24.425Z', model: 'm', querySource: 'repl_main_thread', outputTokens: 217, durationMs: 1426, ttftMs: 150 }),
  }]);
  const { model, ...noModel } = REQUEST;
  assert.equal(JSON.parse(extractSamples(payload(record(noModel)))[0].line).model, undefined, 'model and source are optional');
  assert.equal(JSON.parse(extractSamples(payload(record({ ...REQUEST, output_tokens: '217' })))[0].line).outputTokens, 217, 'a number sent as a string');
});

test('extractSamples drops other events, bad session ids, missing numbers and malformed payloads', () => {
  assert.deepEqual(extractSamples(payload(record(REQUEST, 'claude_code.tool_result'))), []);
  assert.deepEqual(extractSamples(payload(record({ ...REQUEST, 'session.id': '../../etc/x' }))), []);
  const { ttft_ms, ...noTtft } = REQUEST;
  assert.deepEqual(extractSamples(payload(record(noTtft))), []);
  for (const bad of [null, 'x', {}, { resourceLogs: 'x' }, { resourceLogs: [null, { scopeLogs: [null, { logRecords: [null, 7] }] }] }]) {
    assert.deepEqual(extractSamples(bad), []);
  }
});

test('appendSamples writes one line per sample in the session file, and trims a file past the cap', () => withDir(async (dir) => {
  appendSamples(dir, [{ sessionId: 'a', line: '{"n":1}' }, { sessionId: 'a', line: '{"n":2}' }, { sessionId: '../b', line: '{}' }]);
  assert.equal(await readFile(path.join(dir, 'a.jsonl'), 'utf8'), '{"n":1}\n{"n":2}\n');
  assert.deepEqual(await readdir(dir), ['a.jsonl']);

  const big = path.join(dir, 'big.jsonl');
  const line = `${JSON.stringify({ pad: 'x'.repeat(100) })}\n`;
  await writeFile(big, line.repeat(Math.ceil(MAX_SAMPLE_FILE_BYTES / line.length) + 10));
  appendSamples(dir, [{ sessionId: 'big', line: '{"last":true}' }]);
  const trimmed = await readFile(big, 'utf8');
  assert.ok(trimmed.length <= 64 * 1024 && trimmed.endsWith('{"last":true}\n'));
  assert.ok(trimmed.split('\n').slice(0, -1).every((l) => JSON.parse(l)), 'only whole lines are kept');
}));

test('pruneOldSamples removes files past the retention, then the oldest past either ceiling', () => withDir(async (dir) => {
  const now = Date.now();
  const make = async (name, ageMs) => {
    const file = path.join(dir, name);
    await writeFile(file, '{}\n');
    await utimes(file, (now - ageMs) / 1000, (now - ageMs) / 1000);
  };
  await make('old.jsonl', 8 * 86_400_000);
  await make('fresh.jsonl', 1000);
  await make('receiver.pid', 30 * 86_400_000);
  pruneOldSamples(dir, 7, now);
  assert.deepEqual((await readdir(dir)).sort(), ['fresh.jsonl', 'receiver.pid']);

  for (let i = 0; i < MAX_SAMPLE_FILES + 2; i++) await make(`s${String(i).padStart(3, '0')}.jsonl`, 10_000 + (MAX_SAMPLE_FILES + 2 - i) * 1000);
  pruneOldSamples(dir, 7, now);
  const left = (await readdir(dir)).filter((n) => n.endsWith('.jsonl'));
  assert.equal(left.length, MAX_SAMPLE_FILES);
  assert.ok(!left.includes('s000.jsonl') && !left.includes('s001.jsonl') && left.includes('fresh.jsonl'), 'the oldest go first');
  pruneOldSamples(path.join(dir, 'missing'), 7, now);
}));

test('the receiver writes a logs POST, answers everything else with 200, and drops what it cannot use', () => withDir(async (dir) => {
  const server = await startReceiver({ dir, port: 0, retentionDays: 7 });
  const { port } = server.address();
  try {
    assert.equal(await post(port, '/v1/logs', JSON.stringify(payload(record(REQUEST)))), 200);
    assert.match(await readFile(path.join(dir, 'sess-1.jsonl'), 'utf8'), /"outputTokens":217/);
    assert.equal(await post(port, '/v1/metrics', JSON.stringify(payload(record({ ...REQUEST, 'session.id': 'm' })))), 200);
    assert.equal(await post(port, '/v1/logs', '{not json'), 200);
    // An oversized body is answered and the socket dropped, so the client sees 200 or a reset.
    const oversized = await post(port, '/v1/logs', JSON.stringify(payload(record({ ...REQUEST, 'session.id': 'big', pad: 'x'.repeat(MAX_BODY_BYTES) })))).catch(() => 'reset');
    assert.ok(oversized === 200 || oversized === 'reset', String(oversized));
    assert.deepEqual((await readdir(dir)).sort(), ['receiver.pid', 'sess-1.jsonl']);
    assert.deepEqual(readPidRecord(path.join(dir, 'receiver.pid')), { pid: process.pid, entry: SELF, port: 0 });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.ok(!(await readdir(dir)).includes('receiver.pid'), 'closing removes its own pidfile');
}));

test('a receiver refuses a pidfile a live process holds, and takes over one a dead process left', () => withDir(async (dir) => {
  const pidPath = path.join(dir, 'receiver.pid');
  await writeFile(pidPath, JSON.stringify({ pid: process.pid, entry: '/other/otel-receiver.mjs', port: 1 }));
  await assert.rejects(startReceiver({ dir, port: 0, retentionDays: 7 }), /already running/);

  const dead = spawn(process.execPath, ['-e', '']);
  await new Promise((resolve) => dead.on('close', resolve));
  await writeFile(pidPath, JSON.stringify({ pid: dead.pid, entry: '/other/otel-receiver.mjs', port: 1 }));
  const server = await startReceiver({ dir, port: 0, retentionDays: 7 });
  try {
    assert.equal(readPidRecord(pidPath).pid, process.pid);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}));

test('a receiver that cannot bind drops the pidfile it claimed', () => withDir(async (dir) => {
  const holder = http.createServer();
  await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(startReceiver({ dir, port: holder.address().port, retentionDays: 7 }), /EADDRINUSE/);
    await assert.rejects(stat(path.join(dir, 'receiver.pid')));
  } finally {
    holder.close();
  }
}));

test('readPidRecord takes a whole record and nothing else', () => withDir(async (dir) => {
  const file = path.join(dir, 'p');
  for (const bad of ['', 'x', '{"pid":0,"entry":"e","port":1}', '{"pid":1,"entry":"","port":1}', '{"pid":1,"entry":"e"}']) {
    await writeFile(file, bad);
    assert.equal(readPidRecord(file), null, bad);
  }
  assert.equal(readPidRecord(path.join(dir, 'missing')), null);
}));
