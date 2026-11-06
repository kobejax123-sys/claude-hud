import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createProbes, ensureReceiver, isPortInUse, isReceiverProcess, isTelemetryEnabled, otlpEndpoint, readTail, receiverArgs, speedSamples,
} from '../collector.mjs';
import * as otel from '../otel-receiver.mjs';
import { getOutputSpeed } from '../src/speed.ts';

const ON = { CLAUDE_CODE_ENABLE_TELEMETRY: '1' };
const LOOPBACK = { port: 4318, loopback: true };

async function withDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'hud-otelc-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function fakeSpawn() {
  const calls = [];
  const impl = (file, args, options) => {
    calls.push({ file, args, options });
    const child = new EventEmitter();
    child.unref = () => {};
    return child;
  };
  return { calls, impl };
}

const freePort = () => new Promise((resolve) => {
  const server = http.createServer();
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

const sleeper = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
const exited = (child) => new Promise((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', resolve)));

test('isTelemetryEnabled needs the enable flag set to something truthy', () => {
  assert.equal(isTelemetryEnabled({}), false);
  for (const off of ['', '0', 'false', 'OFF', ' no ']) assert.equal(isTelemetryEnabled({ CLAUDE_CODE_ENABLE_TELEMETRY: off }), false, off);
  for (const on of ['1', 'true', 'yes']) assert.equal(isTelemetryEnabled({ CLAUDE_CODE_ENABLE_TELEMETRY: on }), true, on);
});

test('otlpEndpoint reads the environment, logs-specific first, and tells loopback from remote', () => {
  const paths = { configDir: '/nonexistent' };
  assert.deepEqual(otlpEndpoint(paths, {}), LOOPBACK, 'unset is the exporter default');
  assert.deepEqual(otlpEndpoint(paths, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4319' }), { port: 4319, loopback: true });
  assert.deepEqual(otlpEndpoint(paths, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1', OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://localhost:2' }), { port: 2, loopback: true });
  assert.deepEqual(otlpEndpoint(paths, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.example:4318' }), { port: 4318, loopback: false });
  assert.deepEqual(otlpEndpoint(paths, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://[::1]:4318' }), { port: 4318, loopback: false }, '::1 is not where it listens');
  assert.deepEqual(otlpEndpoint(paths, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1' }), LOOPBACK, 'no port is the OTLP default');
  assert.deepEqual(otlpEndpoint(paths, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:80' }), { port: 80, loopback: true }, 'a scheme-default port stays');
  assert.deepEqual(otlpEndpoint(paths, { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example' }), { port: 443, loopback: false });
  assert.deepEqual(otlpEndpoint(paths, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://u:p@127.0.0.1:4320/v1' }), { port: 4320, loopback: true });
  assert.equal(otlpEndpoint(paths, { OTEL_EXPORTER_OTLP_ENDPOINT: 'not a url' }), null);
  assert.equal(otlpEndpoint(paths, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:70000' }), null);
});

test("otlpEndpoint falls back to the user's settings, local over shared, and never reads a project's", () => withDir(async (dir) => {
  const configDir = path.join(dir, '.claude');
  await mkdir(configDir);
  assert.deepEqual(otlpEndpoint({ configDir }, {}), LOOPBACK);
  await writeFile(path.join(configDir, 'settings.json'), JSON.stringify({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:5000' } }));
  assert.deepEqual(otlpEndpoint({ configDir }, {}), { port: 5000, loopback: true });
  await writeFile(path.join(configDir, 'settings.local.json'), JSON.stringify({ env: { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://remote.example:6000' } }));
  assert.deepEqual(otlpEndpoint({ configDir }, {}), { port: 6000, loopback: false });
  assert.deepEqual(otlpEndpoint({ configDir }, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:7000' }), { port: 7000, loopback: true }, 'the environment wins');
  // otlpEndpoint takes no cwd at all, so a repo's .claude/settings.json has no way in.
  assert.equal(otlpEndpoint.length, 1);
}));

test('isPortInUse tells a listening port from a closed one', async () => {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  assert.equal(await isPortInUse(port), true);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await isPortInUse(port), false);
});

test('receiverArgs cages the receiver to its own file and directory, and grants the network from Node 25', () => {
  const args = receiverArgs('/p/otel-receiver.mjs', '/h/otel', 4318, '24.19.0');
  assert.deepEqual(args, ['--permission', '--allow-fs-read=/p/otel-receiver.mjs', '--allow-fs-read=/h/otel', '--allow-fs-write=/h/otel',
    '/p/otel-receiver.mjs', '/h/otel', '4318', '7']);
  assert.ok(!args.some((a) => a.startsWith('--allow-child-process') || a.startsWith('--allow-worker')));
  assert.ok(receiverArgs('/p/r.mjs', '/h/otel', 4318, '25.1.0').includes('--allow-net'));
});

test('isReceiverProcess checks the command line, and says no where it cannot see one', async () => {
  const child = sleeper();
  try {
    await new Promise((resolve) => child.once('spawn', resolve));
    assert.equal(isReceiverProcess(child.pid, process.execPath, 'darwin'), false);
    if (process.platform === 'linux') {
      assert.equal(isReceiverProcess(child.pid, '/not/its/entry.mjs'), false);
      assert.equal(isReceiverProcess(child.pid, await realpath(process.execPath)), true);
    }
  } finally {
    child.kill();
  }
});

test('ensureReceiver spawns a caged, detached receiver with none of the environment when the port is free', () => withDir(async (dir) => {
  const spawned = fakeSpawn();
  const otelDir = path.join(dir, 'otel');
  await ensureReceiver({ otel, dir: otelDir, statePath: path.join(dir, 'state.json'), endpoint: LOOPBACK, spawnImpl: spawned.impl,
    portInUse: async () => false, env: { SECRET: 'x' } });
  assert.equal(spawned.calls.length, 1);
  const [{ file, args, options }] = spawned.calls;
  assert.equal(file, process.execPath);
  assert.deepEqual(args, receiverArgs(otel.SELF, await realpath(otelDir), 4318));
  assert.equal(options.detached, true);
  assert.equal(options.stdio, 'ignore');
  if (process.platform !== 'win32') assert.deepEqual(options.env, {});
  assert.equal(JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8')).attempts, 1);
}));

test('ensureReceiver leaves the port alone when something serves it, or the endpoint is remote', () => withDir(async (dir) => {
  const spawned = fakeSpawn();
  const base = { otel, dir: path.join(dir, 'otel'), statePath: path.join(dir, 'state.json'), spawnImpl: spawned.impl };
  await ensureReceiver({ ...base, endpoint: LOOPBACK, portInUse: async () => true });
  await ensureReceiver({ ...base, endpoint: { port: 4318, loopback: false }, portInUse: async () => false });
  await ensureReceiver({ ...base, endpoint: null, portInUse: async () => false });
  assert.equal(spawned.calls.length, 0);
}));

test('ensureReceiver survives a spawn that fails asynchronously', () => withDir(async (dir) => {
  const impl = () => {
    const child = new EventEmitter();
    child.unref = () => {};
    setImmediate(() => child.emit('error', Object.assign(new Error('EAGAIN'), { code: 'EAGAIN' })));
    return child;
  };
  await ensureReceiver({ otel, dir: path.join(dir, 'otel'), statePath: path.join(dir, 'state.json'), endpoint: LOOPBACK, spawnImpl: impl, portInUse: async () => false });
  await new Promise((resolve) => setImmediate(resolve));
}));

test('ensureReceiver keeps a serving receiver from this install, and clears the backoff record', () => withDir(async (dir) => {
  const otelDir = path.join(dir, 'otel');
  await mkdir(otelDir);
  await writeFile(path.join(otelDir, 'receiver.pid'), JSON.stringify({ pid: process.pid, entry: otel.SELF, port: 4318 }));
  await writeFile(path.join(dir, 'state.json'), JSON.stringify({ attempts: 3, lastAttemptMs: Date.now() }));
  const spawned = fakeSpawn();
  await ensureReceiver({ otel, dir: otelDir, statePath: path.join(dir, 'state.json'), endpoint: LOOPBACK, spawnImpl: spawned.impl, portInUse: async () => false });
  assert.equal(spawned.calls.length, 0);
  await assert.rejects(stat(path.join(dir, 'state.json')));
}));

test('ensureReceiver replaces a receiver another version left, and never signals a process that is not one', () => withDir(async (dir) => {
  const otelDir = path.join(dir, 'otel');
  await mkdir(otelDir);
  const pidPath = path.join(otelDir, 'receiver.pid');
  const base = { otel, dir: otelDir, statePath: path.join(dir, 'state.json'), endpoint: LOOPBACK, portInUse: async () => false };

  const stranger = sleeper();
  const old = sleeper();
  try {
    await Promise.all([stranger, old].map((c) => new Promise((resolve) => c.once('spawn', resolve))));
    await writeFile(pidPath, JSON.stringify({ pid: stranger.pid, entry: '/old/dist/otel/entry.js', port: 4318 }));
    let spawned = fakeSpawn();
    await ensureReceiver({ ...base, spawnImpl: spawned.impl, isReceiver: () => false });
    assert.equal(stranger.exitCode, null, 'a recycled pid is left alone');
    assert.equal(spawned.calls.length, 1);

    await writeFile(pidPath, JSON.stringify({ pid: old.pid, entry: '/old/dist/otel/entry.js', port: 4318 }));
    spawned = fakeSpawn();
    await ensureReceiver({ ...base, spawnImpl: spawned.impl, isReceiver: (pid, entry) => pid === old.pid && entry === '/old/dist/otel/entry.js' });
    await exited(old);
    assert.equal(old.signalCode, 'SIGTERM');
    assert.equal(spawned.calls.length, 1);
    await assert.rejects(stat(pidPath), 'the old pidfile goes');
  } finally {
    stranger.kill();
    old.kill();
  }
}));

test('ensureReceiver backs off after three spawns that never served, for five minutes', () => withDir(async (dir) => {
  const statePath = path.join(dir, 'state.json');
  const base = { otel, dir: path.join(dir, 'otel'), statePath, endpoint: LOOPBACK, portInUse: async () => false };
  const now = Date.now();
  await writeFile(statePath, JSON.stringify({ attempts: 3, lastAttemptMs: now - 60_000 }));
  let spawned = fakeSpawn();
  await ensureReceiver({ ...base, now, spawnImpl: spawned.impl });
  assert.equal(spawned.calls.length, 0);
  await writeFile(statePath, JSON.stringify({ attempts: 3, lastAttemptMs: now - 6 * 60_000 }));
  spawned = fakeSpawn();
  await ensureReceiver({ ...base, now, spawnImpl: spawned.impl });
  assert.equal(spawned.calls.length, 1);
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).attempts, 4);
}));

test('readTail returns whole lines only, keeping a first line that starts on the boundary', () => withDir(async (dir) => {
  const file = path.join(dir, 's.jsonl');
  assert.equal(readTail(file), null);
  await writeFile(file, '');
  assert.equal(readTail(file), null);
  await writeFile(file, 'aaaa\nbbbb\ncccc\n');
  assert.equal(readTail(file, 100), 'aaaa\nbbbb\ncccc\n');
  assert.equal(readTail(file, 7), 'cccc\n', 'mid-line start drops the fragment');
  assert.equal(readTail(file, 10), 'bbbb\ncccc\n', 'a start right after a newline keeps the line');
}));

test('the otel.speed probe answers null with telemetry off or a bad session id, and the tail otherwise', () => withDir(async (dir) => {
  const paths = { hudDir: dir, configDir: dir };
  await mkdir(path.join(dir, 'otel'));
  await writeFile(path.join(dir, 'otel', 'sess-1.jsonl'), '{"a":1}\n');
  const ensured = [];
  const ensure = async (options) => ensured.push(options);
  assert.equal(await speedSamples({ paths, sessionId: 'sess-1', env: {}, ensure }), null);
  assert.equal(ensured.length, 0, 'telemetry off starts nothing');
  assert.equal(await speedSamples({ paths, sessionId: '../x', env: ON, ensure }), null);
  assert.equal(await speedSamples({ paths, sessionId: 'sess-1', env: ON, ensure }), '{"a":1}\n');
  assert.equal(ensured.at(-1).dir, path.join(dir, 'otel'));
  assert.equal(await speedSamples({ paths: null, sessionId: 'sess-1', env: ON, ensure }), null);
  // Through createProbes, with no paths given (as an old caller would), it answers null.
  assert.deepEqual(await createProbes({ argv: [], env: ON })(['otel.speed']), { 'otel.speed': null });
}));

test('end to end: the probe starts a caged receiver, which measures a request Claude Code exports', { timeout: 20_000 }, () => withDir(async (dir) => {
  const port = await freePort();
  const paths = { hudDir: dir, configDir: dir };
  const env = { ...ON, OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}` };
  let started;
  const ensure = (options) => (started = ensureReceiver(options));
  assert.equal(await speedSamples({ paths, sessionId: 'sess-e2e', env, ensure }), null);
  await started;

  const pidPath = path.join(dir, 'otel', 'receiver.pid');
  let pid;
  try {
    for (let i = 0; i < 100 && !(otel.readPidRecord(pidPath) && await isPortInUse(port)); i++) await new Promise((r) => setTimeout(r, 50));
    ({ pid } = otel.readPidRecord(pidPath));
    assert.equal(otel.readPidRecord(pidPath).entry, otel.SELF);
    if (process.platform === 'linux') assert.ok((await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').includes('--permission'), 'it runs caged');

    const body = JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: [{
      body: { stringValue: 'claude_code.api_request' },
      attributes: [['session.id', 'sess-e2e'], ['event.timestamp', '2026-09-11T02:52:24.425Z'], ['query_source', 'repl_main_thread']]
        .map(([key, v]) => ({ key, value: { stringValue: v } }))
        .concat([['output_tokens', 217], ['duration_ms', 1426], ['ttft_ms', 150]].map(([key, v]) => ({ key, value: { intValue: v } }))),
    }] }] }] });
    await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/v1/logs', method: 'POST' }, (res) => res.resume().on('end', resolve));
      req.on('error', reject);
      req.end(body);
    });

    const samples = await speedSamples({ paths, sessionId: 'sess-e2e', env, ensure: async () => {} });
    const tps = getOutputSpeed(samples, { tools: [], skills: [], mcpServers: [], mcpErrors: [], agents: [], todos: [] });
    assert.ok(Math.abs(tps - 217 / 1.276) < 0.1, `got ${tps}`);

    // A second render finds it serving and starts nothing.
    const spawned = fakeSpawn();
    await ensureReceiver({ otel, dir: path.join(dir, 'otel'), statePath: path.join(dir, 'otel-spawn.json'), endpoint: { port, loopback: true }, spawnImpl: spawned.impl });
    assert.equal(spawned.calls.length, 0);
  } finally {
    if (pid) process.kill(pid, 'SIGTERM');
  }
}));
