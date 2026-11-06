// The OTLP receiver behind display.showSpeed: a long-lived loopback HTTP server that takes Claude
// Code's OpenTelemetry log export and keeps each api_request's timing in one file per session.
// collector.mjs starts it (see ensureReceiver there) as
//   node --permission --allow-fs-read=<this file> --allow-fs-read=<dir> --allow-fs-write=<dir> \
//     otel-receiver.mjs <dir> <port> <retention days>
// so it can't run a program, and can read and write only its sample directory. Its input is network
// input. Imports nothing from this repo: the grants name this file alone.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** OTLP export bodies are small log batches; anything larger is treated as hostile. */
export const MAX_BODY_BYTES = 1_000_000;

/**
 * Ceiling for one session's sample file. Age-based pruning can't bound a file still being written:
 * every append refreshes its mtime. A streaming session writes about 100 KB per thousand requests.
 */
export const MAX_SAMPLE_FILE_BYTES = 8 * 1024 * 1024;

/** A trimmed file keeps this much tail: no less than the collector reads (SPEED_TAIL_BYTES). */
const TRIM_KEEP_BYTES = 64 * 1024;

/** Ceilings for the directory: sample files can be made for any number of session ids. */
export const MAX_SAMPLE_FILES = 100;
export const MAX_SAMPLE_DIR_BYTES = 64 * 1024 * 1024;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Session ids arrive in payloads and become file names. collector.mjs checks the same pattern. */
export const isValidSessionId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);

export const SELF = fs.realpathSync(fileURLToPath(import.meta.url));

// OTLP JSON encodes numbers as `intValue: 1426` or `stringValue: "1426"` depending on the exporter.
function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function readAttributes(record) {
  const attrs = {};
  if (!Array.isArray(record.attributes)) return attrs;
  for (const entry of record.attributes) {
    if (typeof entry !== 'object' || entry === null || typeof entry.key !== 'string') continue;
    const v = entry.value;
    attrs[entry.key] = typeof v === 'object' && v !== null ? v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue : undefined;
  }
  return attrs;
}

/** The claude_code.api_request records in an OTLP logs payload, as { sessionId, line }. */
export function extractSamples(payload) {
  const out = [];
  const resourceLogs = payload?.resourceLogs;
  if (!Array.isArray(resourceLogs)) return out;
  for (const resourceLog of resourceLogs) {
    const scopeLogs = resourceLog?.scopeLogs;
    if (!Array.isArray(scopeLogs)) continue;
    for (const scopeLog of scopeLogs) {
      const records = scopeLog?.logRecords;
      if (!Array.isArray(records)) continue;
      for (const record of records) {
        if (typeof record !== 'object' || record === null || record.body?.stringValue !== 'claude_code.api_request') continue;
        const attrs = readAttributes(record);
        const sessionId = attrs['session.id'];
        const ts = attrs['event.timestamp'];
        if (!isValidSessionId(sessionId) || typeof ts !== 'string' || ts === '') continue;
        const outputTokens = toNumber(attrs.output_tokens);
        const durationMs = toNumber(attrs.duration_ms);
        const ttftMs = toNumber(attrs.ttft_ms);
        if (outputTokens === null || durationMs === null || ttftMs === null) continue;
        const model = typeof attrs.model === 'string' && attrs.model !== '' ? attrs.model : undefined;
        // Which chain issued the request (main thread, a subagent, compaction, ...). Recorded, not
        // filtered on, so the raw measurement survives a change in what the reader includes.
        const querySource = typeof attrs.query_source === 'string' && attrs.query_source !== '' ? attrs.query_source : undefined;
        out.push({ sessionId, line: JSON.stringify({ ts, ...(model ? { model } : {}), ...(querySource ? { querySource } : {}), outputTokens, durationMs, ttftMs }) });
      }
    }
  }
  return out;
}

// Rewrites an over-long file down to its tail, through a rename so a reader never sees half of it.
function capSampleFile(file) {
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return;
  }
  if (size <= MAX_SAMPLE_FILE_BYTES) return;
  const fd = fs.openSync(file, 'r');
  let tail;
  try {
    const buf = Buffer.alloc(TRIM_KEEP_BYTES);
    tail = buf.subarray(0, fs.readSync(fd, buf, 0, TRIM_KEEP_BYTES, size - TRIM_KEEP_BYTES));
  } finally {
    fs.closeSync(fd);
  }
  const newline = tail.indexOf(0x0a);
  // A kept fragment with no terminator would fuse with the next sample, so it gets one.
  const keep = newline >= 0 ? tail.subarray(newline + 1) : Buffer.concat([Buffer.from('\n'), tail]);
  fs.writeFileSync(`${file}.tmp`, keep, { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

export function appendSamples(dir, samples) {
  if (samples.length === 0) return;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    return;
  }
  const touched = new Set();
  for (const { sessionId, line } of samples) {
    if (!isValidSessionId(sessionId)) continue;
    const file = path.join(dir, `${sessionId}.jsonl`);
    try {
      fs.appendFileSync(file, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
      touched.add(file);
    } catch { /* one lost sample costs one refresh */ }
  }
  for (const file of touched) {
    try {
      capSampleFile(file);
    } catch { /* retried on the next batch */ }
  }
}

/** Drops files past the retention, then the oldest until both directory ceilings hold. */
export function pruneOldSamples(dir, retentionDays, now) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const survivors = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      if (now - stat.mtimeMs > retentionDays * DAY_MS) fs.unlinkSync(file);
      else survivors.push({ file, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch { /* vanished mid-scan */ }
  }
  // Oldest first is safe: a render only reads its own session's file.
  survivors.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let count = survivors.length;
  let total = survivors.reduce((sum, s) => sum + s.size, 0);
  for (const { file, size } of survivors) {
    if (count <= MAX_SAMPLE_FILES && total <= MAX_SAMPLE_DIR_BYTES) break;
    try {
      fs.unlinkSync(file);
    } catch { /* already gone; it stops counting either way */ }
    count -= 1;
    total -= size;
  }
}

/** `receiver.pid` in the sample directory: { pid, entry, port }, or null. */
export function readPidRecord(file) {
  try {
    const r = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Number.isInteger(r?.pid) && r.pid > 0 && typeof r.entry === 'string' && r.entry !== '' && Number.isInteger(r.port)
      ? { pid: r.pid, entry: r.entry, port: r.port }
      : null;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM'; // alive, another user's
  }
}

// A hard link to a written file publishes the record whole; open('wx') would show '' first.
function claimPidFile(pidPath, payload) {
  const staging = `${pidPath}.${process.pid}.claim`;
  fs.writeFileSync(staging, payload, { mode: 0o600 });
  try {
    fs.linkSync(staging, pidPath);
  } finally {
    try {
      fs.unlinkSync(staging);
    } catch { /* inert */ }
  }
}

// The pidfile is the arbiter when several sessions race to start a receiver: one claim wins.
function writePidFile(pidPath, port) {
  const payload = JSON.stringify({ pid: process.pid, entry: SELF, port });
  try {
    return claimPidFile(pidPath, payload);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const holder = readPidRecord(pidPath);
  if (holder && isProcessAlive(holder.pid)) throw new Error(`receiver already running (pid ${holder.pid})`);
  try {
    fs.unlinkSync(pidPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  claimPidFile(pidPath, payload);
}

export async function startReceiver({ dir, port, retentionDays, now = () => Date.now() }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pidPath = path.join(dir, 'receiver.pid');
  writePidFile(pidPath, port);

  const server = http.createServer((req, res) => {
    // Anything but a logs POST is acknowledged and dropped, so the exporter doesn't retry it.
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/logs')) {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    const chunks = [];
    let size = 0;
    let oversized = false;
    // 'end' and 'error' can both come; a second writeHead would throw and take the receiver down.
    let responded = false;
    const respond = (after) => {
      if (responded) return;
      responded = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}', after);
    };
    res.on('error', () => {});
    req.on('data', (chunk) => {
      if (oversized) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        oversized = true;
        chunks.length = 0;
        // Answer now and drop the socket, so a client that never ends can't hold it.
        respond(() => req.destroy());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!oversized) {
        try {
          appendSamples(dir, extractSamples(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
          pruneOldSamples(dir, retentionDays, now());
        } catch { /* a malformed batch is dropped; the exporter sees success */ }
      }
      respond();
    });
    req.on('error', () => respond());
  });

  const cleanup = () => {
    try {
      if (readPidRecord(pidPath)?.pid === process.pid) fs.unlinkSync(pidPath);
    } catch { /* a stale pidfile names a dead pid, which is detected */ }
  };
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        // After listen, errors are transient accept failures (EMFILE); without a listener they'd crash it.
        server.on('error', () => {});
        resolve();
      });
    });
  } catch (error) {
    cleanup();
    throw error;
  }
  server.on('close', cleanup);
  process.once('SIGTERM', () => server.close(() => process.exit(0)));
  process.once('SIGINT', () => server.close(() => process.exit(0)));
  return server;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === SELF) {
  const [dir, port, retention] = process.argv.slice(2);
  const portNumber = Number(port);
  const retentionDays = Number(retention);
  if (!dir || !path.isAbsolute(dir) || !Number.isInteger(portNumber) || portNumber <= 0 || portNumber > 65535
    || !Number.isInteger(retentionDays) || retentionDays < 0) {
    process.exit(2);
  }
  startReceiver({ dir, port: portNumber, retentionDays }).catch((error) => {
    process.stderr.write(`[claude-hud] otel receiver: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
