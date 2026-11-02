import * as path from 'node:path';
import { getHudPluginDir } from '../claude-config-dir.js';
/**
 * Session ids arrive over the network in OTLP payloads and are used as file
 * names, so they are validated against a strict allowlist. Without this a
 * crafted `session.id` such as `../../etc/x` would escape the sample directory.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export function isValidSessionId(value) {
    return typeof value === 'string' && SESSION_ID_PATTERN.test(value);
}
export function getOtelDir(homeDir) {
    return path.join(getHudPluginDir(homeDir), 'otel');
}
export function getSamplePath(homeDir, sessionId) {
    if (!isValidSessionId(sessionId)) {
        // The raw value is deliberately omitted: it is attacker-controlled network
        // input and this message may end up in a log or on a terminal.
        throw new Error('Invalid session id');
    }
    return path.join(getOtelDir(homeDir), `${sessionId}.jsonl`);
}
export function getPidFilePath(homeDir) {
    return path.join(getOtelDir(homeDir), 'receiver.pid');
}
/**
 * Spawn-attempt bookkeeping for the receiver backoff. It sits beside the plugin
 * config rather than inside the sample directory on purpose: a sample directory
 * the receiver cannot write to is one of the failures the backoff exists for, so
 * the record must survive it.
 */
export function getSpawnStatePath(homeDir) {
    return path.join(getHudPluginDir(homeDir), 'otel-spawn.json');
}
//# sourceMappingURL=paths.js.map