import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  isTelemetryEnabled, resolveOtelEndpoint, isProcessAlive, readPidRecord, resolveReceiverEntry,
  isPortInUse, ensureReceiver, readSettingsOtelEndpoint,
} from '../dist/otel/lifecycle.js';

// getClaudeConfigDir() lets CLAUDE_CONFIG_DIR override the passed homeDir,
// which would misplace the pidfile these tests exercise. node --test runs each
// file in its own process, so clearing it here is safe.
delete process.env.CLAUDE_CONFIG_DIR;

async function makeHome() {
  return await mkdtemp(path.join(tmpdir(), 'claude-hud-otel-life-'));
}

test('isTelemetryEnabled requires the enable flag', () => {
  assert.equal(isTelemetryEnabled({}), false);
  assert.equal(isTelemetryEnabled({ CLAUDE_CODE_ENABLE_TELEMETRY: '0' }), false);
  assert.equal(isTelemetryEnabled({ CLAUDE_CODE_ENABLE_TELEMETRY: '' }), false);
  assert.equal(isTelemetryEnabled({ CLAUDE_CODE_ENABLE_TELEMETRY: '1' }), true);
  assert.equal(isTelemetryEnabled({ CLAUDE_CODE_ENABLE_TELEMETRY: 'true' }), true);
});

test('resolveOtelEndpoint reads the base endpoint and marks loopback', () => {
  const ep = resolveOtelEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' });
  assert.deepEqual(ep, { host: '127.0.0.1', port: 4318, loopback: true });
});

test('resolveOtelEndpoint prefers the logs-specific endpoint', () => {
  const ep = resolveOtelEndpoint({
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://10.0.0.5:4318',
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://127.0.0.1:4319/v1/logs',
  });
  assert.deepEqual(ep, { host: '127.0.0.1', port: 4319, loopback: true });
});

test('resolveOtelEndpoint flags a remote endpoint as non-loopback', () => {
  const ep = resolveOtelEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://10.0.0.5:4318' });
  assert.equal(ep.loopback, false);
});

test('resolveOtelEndpoint falls back to the loopback default when unset', () => {
  // Claude Code strips OTEL_* from the child environment, so the statusLine
  // normally sees no endpoint and must assume the documented default.
  assert.deepEqual(resolveOtelEndpoint({}), { host: '127.0.0.1', port: 4318, loopback: true });
});

test('resolveOtelEndpoint returns null for an unparsable endpoint', () => {
  assert.equal(resolveOtelEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: 'not a url' }), null);
});

test('resolveOtelEndpoint defaults the port when the url omits it', () => {
  assert.equal(resolveOtelEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1' }).port, 4318);
});

test('resolveOtelEndpoint keeps an explicit scheme-default port', () => {
  // `url.port` normalises ":80" for http to '', which is indistinguishable from
  // "no port" — and those differ here, because the OTLP default is 4318.
  const http = resolveOtelEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.corp:80/v1/logs' });
  assert.equal(http.port, 80);

  const https = resolveOtelEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.corp:443' });
  assert.equal(https.port, 443);
});

test('resolveOtelEndpoint defaults the port from the scheme', () => {
  assert.equal(resolveOtelEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.corp' }).port, 443);
  assert.equal(resolveOtelEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.corp' }).port, 4318);
});

test('resolveOtelEndpoint reads the port past credentials and IPv6 brackets', () => {
  assert.equal(
    resolveOtelEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://user:pass@127.0.0.1:4319/' }).port,
    4319,
  );
  // The last colon is the one before the port, not either of the address's own.
  assert.equal(resolveOtelEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://[::1]:4319' }).port, 4319);
});

test('resolveOtelEndpoint rejects an out-of-range port', () => {
  assert.equal(resolveOtelEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:99999' }), null);
});

test('resolveOtelEndpoint does not call an IPv6 loopback servable', () => {
  // The receiver binds 127.0.0.1 only, so treating ::1 as loopback would start a
  // process the exporter can never reach.
  const ep = resolveOtelEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://[::1]:4318' });
  assert.equal(ep.loopback, false);
});

test('resolveOtelEndpoint uses the endpoint configured in the settings files', () => {
  // The statusLine environment has OTEL_* stripped, so this is the only path by
  // which a loopback endpoint is actually discovered.
  assert.deepEqual(
    resolveOtelEndpoint({}, 'http://127.0.0.1:4318'),
    { host: '127.0.0.1', port: 4318, loopback: true },
  );
});

test('resolveOtelEndpoint flags a remote settings endpoint as non-loopback', () => {
  // Otherwise the HUD starts a loopback receiver for a remote collector and it
  // stays resident forever without ever receiving a sample.
  assert.equal(resolveOtelEndpoint({}, 'https://collector.corp:4318').loopback, false);
});

test('resolveOtelEndpoint prefers the environment over the settings files', () => {
  assert.deepEqual(
    resolveOtelEndpoint(
      { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4319' },
      'https://collector.corp:4318',
    ),
    { host: '127.0.0.1', port: 4319, loopback: true },
  );
});

test('readSettingsOtelEndpoint reads the user settings env block', async () => {
  const home = await makeHome();
  const claudeDir = path.join(home, '.claude');
  await mkdir(claudeDir, { recursive: true });
  await writeFile(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' } }),
    'utf8',
  );

  assert.equal(readSettingsOtelEndpoint(home), 'http://127.0.0.1:4318');
  await rm(home, { recursive: true, force: true });
});

test('readSettingsOtelEndpoint prefers the more specific scope and the logs-specific variable', async () => {
  const home = await makeHome();
  const cwd = await mkdtemp(path.join(tmpdir(), 'claude-hud-otel-cwd-'));
  await mkdir(path.join(home, '.claude'), { recursive: true });
  await mkdir(path.join(cwd, '.claude'), { recursive: true });

  await writeFile(
    path.join(home, '.claude/settings.json'),
    JSON.stringify({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://10.0.0.5:4318' } }),
    'utf8',
  );
  await writeFile(
    path.join(cwd, '.claude/settings.json'),
    JSON.stringify({ env: { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://127.0.0.1:4319/v1/logs' } }),
    'utf8',
  );

  assert.equal(readSettingsOtelEndpoint(home, cwd), 'http://127.0.0.1:4319/v1/logs');
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

test('readSettingsOtelEndpoint returns null without a usable env block', async () => {
  const home = await makeHome();
  assert.equal(readSettingsOtelEndpoint(home), null);

  await mkdir(path.join(home, '.claude'), { recursive: true });
  await writeFile(path.join(home, '.claude/settings.json'), JSON.stringify({ env: {} }), 'utf8');
  assert.equal(readSettingsOtelEndpoint(home), null);

  await writeFile(path.join(home, '.claude/settings.json'), 'not json', 'utf8');
  assert.equal(readSettingsOtelEndpoint(home), null);
  await rm(home, { recursive: true, force: true });
});

test('isProcessAlive reports false for a pid that cannot exist', () => {
  assert.equal(isProcessAlive(2147483646), false);
});

test('readPidRecord parses a valid file and rejects garbage', async () => {
  const home = await makeHome();
  const dir = path.join(home, '.claude/plugins/claude-hud/otel');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'receiver.pid');

  await writeFile(file, JSON.stringify({ pid: 1234, entry: '/a/b/entry.js', port: 4318 }), 'utf8');
  assert.deepEqual(readPidRecord(file), { pid: 1234, entry: '/a/b/entry.js', port: 4318 });

  await writeFile(file, 'not json', 'utf8');
  assert.equal(readPidRecord(file), null);

  await writeFile(file, JSON.stringify({ pid: 'x', entry: 1, port: 2 }), 'utf8');
  assert.equal(readPidRecord(file), null);

  assert.equal(readPidRecord(path.join(dir, 'missing.pid')), null);
  await rm(home, { recursive: true, force: true });
});

test('resolveReceiverEntry points at the compiled entry module beside lifecycle.js', () => {
  const entry = resolveReceiverEntry();
  assert.ok(entry.endsWith(path.join('otel', 'entry.js')), `got ${entry}`);
  assert.ok(path.isAbsolute(entry));
});

async function withEphemeralPort(fn) {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await fn(port, server);
  await new Promise((resolve) => server.close(resolve));
}

async function freePort() {
  let port;
  await withEphemeralPort((p) => {
    port = p;
  });
  return port;
}

test('isPortInUse recognises a listening port', async () => {
  await withEphemeralPort(async (port) => {
    assert.equal(await isPortInUse(port, 1000), true);
  });
});

test('isPortInUse reports a closed port as free', async () => {
  const port = await freePort();
  assert.equal(await isPortInUse(port, 1000), false);
});

test('ensureReceiver does not spawn when something already serves the port', async () => {
  const home = await makeHome();
  await withEphemeralPort(async (port) => {
    let spawned = 0;
    await ensureReceiver({
      homeDir: home,
      endpoint: { host: '127.0.0.1', port, loopback: true },
      spawnImpl: () => {
        spawned += 1;
        return { on() {}, unref() {} };
      },
    });
    assert.equal(spawned, 0, 'a bound port must not produce an EADDRINUSE attempt');
  });
  await rm(home, { recursive: true, force: true });
});

test('ensureReceiver spawns when the port is free', async () => {
  const home = await makeHome();
  const port = await freePort();
  let spawned = 0;
  await ensureReceiver({
    homeDir: home,
    endpoint: { host: '127.0.0.1', port, loopback: true },
    spawnImpl: () => {
      spawned += 1;
      return { on() {}, unref() {} };
    },
  });
  assert.equal(spawned, 1);
  await rm(home, { recursive: true, force: true });
});

test('ensureReceiver never spawns for a remote endpoint', async () => {
  const home = await makeHome();
  const port = await freePort();
  let spawned = 0;
  await ensureReceiver({
    homeDir: home,
    endpoint: { host: '10.0.0.5', port, loopback: false },
    spawnImpl: () => {
      spawned += 1;
      return { on() {}, unref() {} };
    },
  });
  assert.equal(spawned, 0);
  await rm(home, { recursive: true, force: true });
});

test('ensureReceiver forwards the configured retention to the child', async () => {
  const home = await makeHome();
  const port = await freePort();
  let childEnv;
  await ensureReceiver({
    homeDir: home,
    endpoint: { host: '127.0.0.1', port, loopback: true },
    retentionDays: 3,
    spawnImpl: (_command, _args, options) => {
      childEnv = options.env;
      return { on() {}, unref() {} };
    },
  });

  assert.equal(childEnv.CLAUDE_HUD_OTEL_RETENTION_DAYS, '3');
  await rm(home, { recursive: true, force: true });
});

test('ensureReceiver survives a child that reports a spawn failure asynchronously', async () => {
  const home = await makeHome();
  const port = await freePort();
  let child;
  await ensureReceiver({
    homeDir: home,
    endpoint: { host: '127.0.0.1', port, loopback: true },
    spawnImpl: () => {
      child = new EventEmitter();
      child.unref = () => {};
      return child;
    },
  });

  // An 'error' event with no listener is an uncaught exception, which would take
  // the whole statusLine process down rather than losing a single spawn.
  assert.doesNotThrow(() => child.emit('error', new Error('spawn EAGAIN')));
  await rm(home, { recursive: true, force: true });
});

test('ensureReceiver does not signal a pid that is not the recorded receiver', async () => {
  const home = await makeHome();
  const otelDir = path.join(home, '.claude/plugins/claude-hud/otel');
  await mkdir(otelDir, { recursive: true });

  // Stands in for a recycled pid: the pidfile names a live process, but it is not
  // a receiver. Signalling it would kill whatever the pid was reused for.
  const bystander = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  try {
    await writeFile(
      path.join(otelDir, 'receiver.pid'),
      JSON.stringify({ pid: bystander.pid, entry: '/nonexistent/old/entry.js', port: 4318 }),
      'utf8',
    );

    const port = await freePort();
    let spawned = 0;
    await ensureReceiver({
      homeDir: home,
      endpoint: { host: '127.0.0.1', port, loopback: true },
      spawnImpl: () => {
        spawned += 1;
        return { on() {}, unref() {} };
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    // exitCode is null for a process killed by a signal too, so signalCode and a
    // liveness probe are what actually distinguish "survived" from "was killed".
    assert.equal(bystander.signalCode, null, 'an unrelated process must not be signalled');
    assert.doesNotThrow(() => process.kill(bystander.pid, 0), 'an unrelated process must survive');
    assert.equal(spawned, 1, 'the receiver still has to be started');
  } finally {
    bystander.kill('SIGKILL');
    await rm(home, { recursive: true, force: true });
  }
});

test('ensureReceiver replaces a receiver left by another version', async () => {
  const home = await makeHome();
  const otelDir = path.join(home, '.claude/plugins/claude-hud/otel');
  await mkdir(otelDir, { recursive: true });

  // Stands in for the previous plugin version's receiver: a live process whose
  // command line really is the entry the pidfile records.
  const scriptPath = path.join(home, 'previous-entry.js');
  await writeFile(scriptPath, 'setTimeout(() => {}, 60000);', 'utf8');
  const previous = spawn(process.execPath, [scriptPath], { stdio: 'ignore' });
  try {
    await writeFile(
      path.join(otelDir, 'receiver.pid'),
      JSON.stringify({ pid: previous.pid, entry: scriptPath, port: 4318 }),
      'utf8',
    );

    await ensureReceiver({
      homeDir: home,
      endpoint: { host: '127.0.0.1', port: await freePort(), loopback: true },
      spawnImpl: () => ({ on() {}, unref() {} }),
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(previous.signalCode, 'SIGTERM', 'a stale receiver must be replaced');
  } finally {
    previous.kill('SIGKILL');
    await rm(home, { recursive: true, force: true });
  }
});

test('ensureReceiver backs off after spawns that never produce a serving receiver', async () => {
  const home = await makeHome();
  const port = await freePort();
  let spawned = 0;
  const options = {
    homeDir: home,
    endpoint: { host: '127.0.0.1', port, loopback: true },
    spawnImpl: () => {
      spawned += 1;
      return { on() {}, unref() {} };
    },
  };

  for (let i = 0; i < 5; i++) await ensureReceiver(options);
  assert.equal(spawned, 3, 'past the attempt limit a spawn must wait for the cooldown');
  await rm(home, { recursive: true, force: true });
});

test('ensureReceiver clears the spawn backoff once a receiver is serving', async () => {
  const home = await makeHome();
  const port = await freePort();
  const entry = resolveReceiverEntry();
  const options = {
    homeDir: home,
    endpoint: { host: '127.0.0.1', port, loopback: true },
    spawnImpl: () => ({ on() {}, unref() {} }),
  };

  const otelDir = path.join(home, '.claude/plugins/claude-hud/otel');
  const statePath = path.join(home, '.claude/plugins/claude-hud/otel-spawn.json');
  await mkdir(otelDir, { recursive: true });

  for (let i = 0; i < 4; i++) await ensureReceiver(options);
  assert.equal(existsSync(statePath), true, 'a failing spawn must be recorded');

  await writeFile(
    path.join(otelDir, 'receiver.pid'),
    JSON.stringify({ pid: process.pid, entry, port }),
    'utf8',
  );
  await ensureReceiver(options);
  assert.equal(existsSync(statePath), false, 'a healthy receiver must reset the failure count');
  await rm(home, { recursive: true, force: true });
});
