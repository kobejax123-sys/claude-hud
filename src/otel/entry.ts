import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MAX_BODY_BYTES, appendSamples, extractSamples, pruneOldSamples } from './receiver.js';
import { getOtelDir, getPidFilePath } from './paths.js';
import {
  isProcessAlive, readPidRecord, readSettingsOtelEndpoint, resolveOtelEndpoint, resolveReceiverEntry,
} from './lifecycle.js';

const DEFAULT_RETENTION_DAYS = 7;

/**
 * `Number(raw) || DEFAULT` would turn a valid 0 into the default and let a
 * negative through, and a negative retention prunes every sample the moment it is
 * written, so the rate could never accumulate.
 */
export function resolveRetentionDays(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_RETENTION_DAYS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return DEFAULT_RETENTION_DAYS;
  return parsed;
}

export interface StartReceiverOptions {
  homeDir: string;
  port: number;
  retentionDays: number;
  now?: () => number;
}

function errnoOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Claims the pidfile with a hard link to an already-written temporary file.
 *
 * `open(..., 'wx')` would be the natural primitive, but it publishes a zero-byte
 * file before the record is written: a concurrent reader would parse '' as an
 * absent holder and could delete a live receiver's pidfile. Linking is just as
 * atomic and publishes the record complete.
 */
function claimPidFile(pidPath: string, payload: string): void {
  const stagingPath = `${pidPath}.${process.pid}.claim`;
  fs.writeFileSync(stagingPath, payload, { mode: 0o600 });
  try {
    fs.linkSync(stagingPath, pidPath);
  } finally {
    try {
      fs.unlinkSync(stagingPath);
    } catch {
      // A leftover staging file is inert; the claim itself already resolved.
    }
  }
}

function writePidFile(homeDir: string, port: number): void {
  const pidPath = getPidFilePath(homeDir);
  fs.mkdirSync(getOtelDir(homeDir), { recursive: true, mode: 0o700 });

  const payload = JSON.stringify({ pid: process.pid, entry: resolveReceiverEntry(), port });

  try {
    claimPidFile(pidPath, payload);
    return;
  } catch (claimError) {
    if (errnoOf(claimError) !== 'EEXIST') throw claimError;
  }

  // The link was refused, so someone holds the pidfile. That is the arbiter when
  // several sessions race to start the receiver: exactly one claimant wins,
  // everyone else backs off.
  const holder = readPidRecord(pidPath);
  if (holder && isProcessAlive(holder.pid)) {
    throw new Error(`receiver already running (pid ${holder.pid})`);
  }

  try {
    fs.unlinkSync(pidPath);
  } catch (unlinkError) {
    // Another claimant removed it first, which is the state we wanted anyway.
    if (errnoOf(unlinkError) !== 'ENOENT') throw unlinkError;
  }

  try {
    claimPidFile(pidPath, payload);
  } catch (retryError) {
    if (errnoOf(retryError) === 'EEXIST') {
      throw new Error('receiver already running (another process claimed the pidfile)');
    }
    throw retryError;
  }
}

export async function startReceiver(options: StartReceiverOptions): Promise<http.Server> {
  const { homeDir, port, retentionDays } = options;
  const now = options.now ?? (() => Date.now());

  writePidFile(homeDir, port);

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }

    // Anything that is not logs is acknowledged and dropped so the exporter does
    // not retry it forever and flood the log.
    if (!req.url || !req.url.startsWith('/v1/logs')) {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;

    // 'end' and 'error' can both arrive for one request, and a response that has
    // already been written must not be written again: a second writeHead throws
    // ERR_HTTP_HEADERS_SENT inside an event handler, which is an uncaught
    // exception that takes the receiver down.
    let responded = false;
    const respond = (after?: () => void) => {
      if (responded) return;
      responded = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}', after);
    };
    res.on('error', () => {
      // A client that vanishes mid-response must not surface as a receiver crash.
    });

    req.on('data', (chunk: Buffer) => {
      if (oversized) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        oversized = true;
        chunks.length = 0;
        // Answer now and drop the connection once the response has flushed.
        // Waiting for 'end' would let a client that never ends the request hold
        // the socket until the server's request timeout.
        respond(() => req.destroy());
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (!oversized) {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const samples = extractSamples(payload);
          appendSamples(homeDir, samples);
          pruneOldSamples(homeDir, retentionDays, now());
        } catch {
          // A malformed batch is dropped; the exporter sees a success response.
        }
      }
      respond();
    });

    req.on('error', () => respond());
  });

  const cleanup = () => {
    try {
      if (readPidRecord(getPidFilePath(homeDir))?.pid === process.pid) {
        fs.unlinkSync(getPidFilePath(homeDir));
      }
    } catch {
      // Leaving a stale pidfile behind is harmless — a dead pid is detected.
    }
  };

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        // Errors after a successful listen are transient accept failures (EMFILE
        // and the like). Without a listener they are uncaught exceptions that
        // take the receiver down and drop telemetry until the next lazy start, so
        // the rejecting handler is swapped for a continuing one right here, with
        // no window in between.
        server.on('error', () => {});
        resolve();
      });
    });
  } catch (err) {
    // Binding failed (most often EADDRINUSE). Drop the pidfile claimed above so a
    // later attempt is not misled by a record for a process that never served.
    cleanup();
    throw err;
  }

  server.on('close', cleanup);
  process.once('SIGTERM', () => server.close(() => process.exit(0)));
  process.once('SIGINT', () => server.close(() => process.exit(0)));

  return server;
}

const scriptPath = fileURLToPath(import.meta.url);
const argvPath = process.argv[1];
const isSamePath = (a: string, b: string): boolean => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
};

if (argvPath && isSamePath(argvPath, scriptPath)) {
  const homeDir = os.homedir();
  const endpoint = resolveOtelEndpoint(
    process.env,
    readSettingsOtelEndpoint(homeDir, process.cwd()),
  );
  const port = endpoint?.port ?? 4318;
  void startReceiver({
    homeDir,
    port,
    retentionDays: resolveRetentionDays(process.env.CLAUDE_HUD_OTEL_RETENTION_DAYS),
  }).catch((err: unknown) => {
    process.stderr.write(`[claude-hud] otel receiver: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
