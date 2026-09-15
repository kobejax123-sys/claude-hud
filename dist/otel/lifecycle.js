import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getPidFilePath, getSpawnStatePath } from './paths.js';
import { getClaudeConfigDir } from '../claude-config-dir.js';
const DEFAULT_OTLP_PORT = 4318;
/**
 * Hosts the receiver considers its own. An IPv6 loopback address is deliberately
 * absent: the receiver binds 127.0.0.1 only, so classifying `::1` as loopback
 * would start a process the exporter can never reach.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);
const RETENTION_ENV_VAR = 'CLAUDE_HUD_OTEL_RETENTION_DAYS';
/**
 * A connect to loopback either completes or is refused immediately; the timeout
 * only bounds a pathological case. The statusLine process stays alive until this
 * settles, so it is deliberately short.
 */
const PORT_PROBE_TIMEOUT_MS = 200;
/**
 * Consecutive spawns that never produce a serving receiver are retried only after
 * a cooldown. A receiver that cannot start at all — an unwritable sample
 * directory, a broken build — would otherwise be forked again on every
 * statusLine refresh, which is hundreds of doomed processes per minute while
 * tokens stream.
 */
const SPAWN_ATTEMPT_LIMIT = 3;
const SPAWN_BACKOFF_MS = 5 * 60 * 1000;
const FALSY = new Set(['', '0', 'false', 'off', 'no']);
export function isTelemetryEnabled(env) {
    const value = env.CLAUDE_CODE_ENABLE_TELEMETRY?.trim().toLowerCase();
    if (value === undefined)
        return false;
    return !FALSY.has(value);
}
function endpointFromSettingsFile(filePath) {
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (typeof parsed !== 'object' || parsed === null)
            return null;
        const env = parsed.env;
        if (typeof env !== 'object' || env === null)
            return null;
        const block = env;
        // Signal-specific wins over the generic one, matching the OTel spec.
        for (const key of ['OTEL_EXPORTER_OTLP_LOGS_ENDPOINT', 'OTEL_EXPORTER_OTLP_ENDPOINT']) {
            const value = block[key];
            if (typeof value === 'string' && value.trim() !== '')
                return value.trim();
        }
        return null;
    }
    catch {
        return null;
    }
}
/**
 * The OTLP endpoint configured in the settings files, or null when none is.
 *
 * Claude Code consumes the OTEL_* variables itself and removes them from the
 * environment it hands to the statusLine, so the statusLine normally sees no
 * endpoint at all — the settings file is the only place the configured endpoint
 * is observable from a render. Without it a remote collector is indistinguishable
 * from an unset endpoint, and the HUD would start a receiver that can never
 * receive anything.
 *
 * More specific scopes win, mirroring how Claude Code merges them.
 */
export function readSettingsOtelEndpoint(homeDir, cwd) {
    const claudeDir = getClaudeConfigDir(homeDir);
    const files = [
        path.join(claudeDir, 'settings.json'),
        path.join(claudeDir, 'settings.local.json'),
    ];
    if (cwd) {
        files.push(path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json'));
    }
    let found = null;
    for (const file of files) {
        const value = endpointFromSettingsFile(file);
        if (value !== null)
            found = value;
    }
    return found;
}
/**
 * Resolves the OTLP endpoint the HUD should listen on. Returns the endpoint even
 * when it is remote, so the caller can distinguish "telemetry is off" from
 * "telemetry points somewhere we cannot read from".
 *
 * `settingsEndpoint` is the value found in the settings files; it is only
 * consulted when the environment carries nothing, which is the normal case (see
 * `readSettingsOtelEndpoint`).
 */
export function resolveOtelEndpoint(env, settingsEndpoint) {
    const raw = env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?.trim()
        || env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()
        || settingsEndpoint?.trim()
        || '';
    // Nothing configured anywhere. The OTLP exporter's own default endpoint is
    // loopback, so assume that rather than refusing to start a receiver.
    if (!raw) {
        return { host: '127.0.0.1', port: DEFAULT_OTLP_PORT, loopback: true };
    }
    let url;
    try {
        url = new URL(raw);
    }
    catch {
        return null;
    }
    const port = explicitPort(raw) ?? (url.protocol === 'https:' ? 443 : DEFAULT_OTLP_PORT);
    if (!Number.isInteger(port) || port <= 0 || port > 65535)
        return null;
    const host = url.hostname;
    return { host, port, loopback: LOOPBACK_HOSTS.has(host) };
}
/**
 * The port written literally in the endpoint, or null when none was.
 *
 * `url.port` cannot answer this: it normalises a port that matches the scheme
 * default (`:80` for http, `:443` for https) to the empty string, which is
 * indistinguishable from "no port at all" — and those two mean different things
 * here, because the OTLP default is 4318 rather than the scheme default.
 */
function explicitPort(raw) {
    const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(raw)?.[1];
    if (authority === undefined)
        return null;
    // After the last colon, which for a bracketed IPv6 host is the one that
    // precedes the port rather than one inside the address.
    const colon = authority.lastIndexOf(':');
    if (colon < 0)
        return null;
    const digits = authority.slice(colon + 1);
    return /^\d+$/.test(digits) ? Number(digits) : null;
}
export function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        // EPERM means the pid exists but belongs to another user — still alive.
        return err.code === 'EPERM';
    }
}
export function readPidRecord(filePath) {
    let raw;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    }
    catch {
        return null;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null)
        return null;
    const r = parsed;
    if (typeof r.pid !== 'number' || !Number.isInteger(r.pid) || r.pid <= 0)
        return null;
    if (typeof r.entry !== 'string' || r.entry === '')
        return null;
    if (typeof r.port !== 'number' || !Number.isInteger(r.port))
        return null;
    return { pid: r.pid, entry: r.entry, port: r.port };
}
function readSpawnState(filePath) {
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (typeof parsed !== 'object' || parsed === null)
            return null;
        const s = parsed;
        if (typeof s.attempts !== 'number' || !Number.isInteger(s.attempts) || s.attempts < 0)
            return null;
        if (typeof s.lastAttemptMs !== 'number' || !Number.isFinite(s.lastAttemptMs))
            return null;
        return { attempts: s.attempts, lastAttemptMs: s.lastAttemptMs };
    }
    catch {
        return null;
    }
}
function writeSpawnState(filePath, state) {
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
        fs.writeFileSync(filePath, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    }
    catch {
        // Losing the record only costs the backoff, never a render.
    }
}
function clearSpawnState(filePath) {
    try {
        fs.unlinkSync(filePath);
    }
    catch {
        // Absent is the desired state.
    }
}
/**
 * Absolute path of the compiled receiver entry. Comparing this against the entry
 * recorded in the pidfile is how an upgraded plugin detects and replaces a
 * receiver left over from the previous version directory.
 */
export function resolveReceiverEntry() {
    return fileURLToPath(new URL('./entry.js', import.meta.url));
}
function samePath(a, b) {
    if (a === b)
        return true;
    try {
        return fs.realpathSync(a) === fs.realpathSync(b);
    }
    catch {
        return false;
    }
}
/**
 * True when `pid` is running the receiver recorded in the pidfile.
 *
 * A pid outlives the process it was written for — the OS recycles identifiers —
 * so a record left behind by a receiver that was killed outright can end up
 * naming an unrelated process. Signalling it would kill a stranger, so the command
 * line is checked before anything is sent.
 *
 * Only Linux exposes another process's command line (/proc). Where it is not
 * available the check reports false and the caller leaves the process alone: an
 * older receiver that keeps serving is a far milder outcome than killing an
 * innocent process, and it still writes samples the HUD can read.
 */
export function isReceiverProcess(pid, entry) {
    if (process.platform !== 'linux')
        return false;
    try {
        return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
            .split('\0')
            .some((arg) => arg !== '' && samePath(arg, entry));
    }
    catch {
        return false;
    }
}
/**
 * True when something already accepts connections on the loopback port. Used to
 * avoid spawning a receiver that is guaranteed to die with EADDRINUSE — spawning
 * blindly in that case would repeat on every statusLine refresh.
 *
 * An unanswered connect counts as in use: a closed loopback port is refused
 * immediately, so a connect that merely times out means a listener is there but
 * not accepting. Reporting it as free would trade a skipped start (mild) for a
 * spawn that must die (a doomed process per refresh).
 */
export function isPortInUse(port, timeoutMs = PORT_PROBE_TIMEOUT_MS) {
    return new Promise((resolve) => {
        const socket = net.connect({ port, host: '127.0.0.1' });
        let settled = false;
        const finish = (inUse) => {
            if (settled)
                return;
            settled = true;
            socket.removeAllListeners();
            socket.destroy();
            resolve(inUse);
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(true));
        socket.once('error', () => finish(false));
    });
}
/**
 * Best-effort: makes sure a receiver is running for this endpoint. Never throws
 * and never blocks the render — a failure here only costs samples, and the
 * statusLine must return within its debounce budget.
 *
 * The returned promise resolves once the port probe has settled. Callers on the
 * render path fire and forget it; the process stays alive until it settles.
 * Tests await it.
 */
export async function ensureReceiver(options) {
    const { homeDir, endpoint, retentionDays } = options;
    if (!endpoint || !endpoint.loopback)
        return;
    const entry = resolveReceiverEntry();
    const pidPath = getPidFilePath(homeDir);
    const statePath = getSpawnStatePath(homeDir);
    const existing = readPidRecord(pidPath);
    if (existing && isProcessAlive(existing.pid) && existing.entry === entry && existing.port === endpoint.port) {
        // A serving receiver clears the failure record, so a one-off spawn failure
        // never accumulates into a backoff.
        clearSpawnState(statePath);
        return;
    }
    if (existing && isProcessAlive(existing.pid)) {
        // A pidfile left by a receiver that was killed outright can name a recycled
        // pid, so the process is identified before it is signalled.
        if (isReceiverProcess(existing.pid, existing.entry)) {
            try {
                process.kill(existing.pid, 'SIGTERM');
            }
            catch {
                // Already gone; the child's pidfile claim settles it.
            }
        }
        try {
            fs.unlinkSync(pidPath);
        }
        catch {
            // A missing pidfile is the desired state anyway.
        }
    }
    const state = readSpawnState(statePath);
    const now = Date.now();
    if (state
        && state.attempts >= SPAWN_ATTEMPT_LIMIT
        && now - state.lastAttemptMs < SPAWN_BACKOFF_MS) {
        return;
    }
    // Something may already serve this port: a receiver whose pidfile was lost, a
    // receiver from a previous plugin version, or an unrelated OTLP collector the
    // user pointed telemetry at. In all of those cases a new process could only die
    // with EADDRINUSE, so leave the endpoint alone.
    if (await isPortInUse(endpoint.port))
        return;
    const spawnImpl = options.spawnImpl ?? spawn;
    try {
        const child = spawnImpl(process.execPath, [entry], {
            detached: true,
            stdio: 'ignore',
            env: retentionDays === undefined
                ? process.env
                : { ...process.env, [RETENTION_ENV_VAR]: String(retentionDays) },
        });
        // A spawn failure that is reported asynchronously (EAGAIN, EMFILE, EACCES)
        // arrives as an 'error' event. With no listener it is an uncaught exception,
        // which would take the statusLine process down instead of losing one spawn.
        child.on('error', () => { });
        child.unref();
        writeSpawnState(statePath, { attempts: (state?.attempts ?? 0) + 1, lastAttemptMs: now });
    }
    catch {
        // Spawning is best-effort; the next refresh tries again.
    }
}
//# sourceMappingURL=lifecycle.js.map