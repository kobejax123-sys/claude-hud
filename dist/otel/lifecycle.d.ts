import { spawn } from 'node:child_process';
export interface PidRecord {
    pid: number;
    entry: string;
    port: number;
}
export interface OtelEndpoint {
    host: string;
    port: number;
    loopback: boolean;
}
export declare function isTelemetryEnabled(env: NodeJS.ProcessEnv): boolean;
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
export declare function readSettingsOtelEndpoint(homeDir: string, cwd?: string): string | null;
/**
 * Resolves the OTLP endpoint the HUD should listen on. Returns the endpoint even
 * when it is remote, so the caller can distinguish "telemetry is off" from
 * "telemetry points somewhere we cannot read from".
 *
 * `settingsEndpoint` is the value found in the settings files; it is only
 * consulted when the environment carries nothing, which is the normal case (see
 * `readSettingsOtelEndpoint`).
 */
export declare function resolveOtelEndpoint(env: NodeJS.ProcessEnv, settingsEndpoint?: string | null): OtelEndpoint | null;
export declare function isProcessAlive(pid: number): boolean;
export declare function readPidRecord(filePath: string): PidRecord | null;
/**
 * Absolute path of the compiled receiver entry. Comparing this against the entry
 * recorded in the pidfile is how an upgraded plugin detects and replaces a
 * receiver left over from the previous version directory.
 */
export declare function resolveReceiverEntry(): string;
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
export declare function isReceiverProcess(pid: number, entry: string): boolean;
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
export declare function isPortInUse(port: number, timeoutMs?: number): Promise<boolean>;
export interface EnsureReceiverOptions {
    homeDir: string;
    endpoint: OtelEndpoint | null;
    /**
     * Forwarded to the child: the receiver has no other way to learn the configured
     * retention, and its own default would silently disagree with the config file.
     */
    retentionDays?: number;
    spawnImpl?: typeof spawn;
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
export declare function ensureReceiver(options: EnsureReceiverOptions): Promise<void>;
//# sourceMappingURL=lifecycle.d.ts.map