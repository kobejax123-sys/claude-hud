import { getOtelTps } from './otel/client.js';
import { ensureReceiver, isTelemetryEnabled, readSettingsOtelEndpoint, resolveOtelEndpoint, } from './otel/lifecycle.js';
import { isValidSessionId } from './otel/paths.js';
// How long the receiver keeps a session's sample file.
const SAMPLE_RETENTION_DAYS = 7;
/**
 * Output speed measured from Claude Code's OpenTelemetry api_request events:
 * output tokens over the decode window (request time minus the wait for the
 * first token), aggregated over the turn in progress, or the last completed turn
 * until the current one has a measurable request. Main-chain requests only.
 *
 * Null until a request has been measured, or when telemetry is off. There is no
 * estimate to fall back on: one derived from API time includes the first-token
 * wait and reads well below the real rate on short replies.
 */
export function getOutputSpeed(stdin, homeDir, transcript) {
    if (!isTelemetryEnabled(process.env))
        return null;
    const sessionId = stdin.session_id;
    if (!isValidSessionId(sessionId))
        return null;
    // The statusLine's environment is stripped of OTEL_*, so the settings files are
    // what tells a loopback endpoint from a remote one.
    const endpoint = resolveOtelEndpoint(process.env, readSettingsOtelEndpoint(homeDir, stdin.cwd));
    // Fire and forget: the render must not wait on the receiver's port probe.
    void ensureReceiver({ homeDir, endpoint, retentionDays: SAMPLE_RETENTION_DAYS }).catch(() => {
        // Lazy start never fails the render.
    });
    return getOtelTps(homeDir, sessionId, transcript.lastTurnEndAt?.getTime() ?? null, transcript.previousTurnEndAt?.getTime() ?? null);
}
//# sourceMappingURL=speed.js.map