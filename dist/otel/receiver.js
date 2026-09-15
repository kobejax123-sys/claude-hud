import * as fs from 'node:fs';
import * as path from 'node:path';
import { getOtelDir, getSamplePath, isValidSessionId } from './paths.js';
/** OTLP export bodies are small log batches; anything larger is treated as hostile. */
export const MAX_BODY_BYTES = 1_000_000;
/**
 * Hard ceiling for one session's sample file. Age-based pruning cannot bound a
 * file that is still being written to — every append refreshes its mtime, so an
 * active session's file never falls into the retention window no matter how large
 * it grows. A session that is genuinely streaming produces on the order of 100 KB
 * per thousand requests, so anything near this ceiling is abnormal.
 */
export const MAX_SAMPLE_FILE_BYTES = 8 * 1024 * 1024;
/**
 * Trimmed files keep this much of their tail. It must not be smaller than the
 * reader's window (`TAIL_BYTES` in client.ts), or trimming would discard the only
 * samples the HUD can still read.
 */
const TRIM_KEEP_BYTES = 8192;
/**
 * Ceilings for the sample directory as a whole. The per-file cap alone does not
 * bound the directory: sample files can be created for any number of session ids,
 * and every one of them stays fresh — so age-based pruning never touches them.
 * The values are far above what real use produces (a session is on the order of
 * 100 KB per thousand requests).
 */
export const MAX_SAMPLE_FILES = 100;
export const MAX_SAMPLE_DIR_BYTES = 64 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * OTLP JSON encodes numeric attribute values inconsistently across exporters —
 * observed in the wild as both `intValue: 1426` and `stringValue: "1426"` for the
 * same field. Accept both rather than assume one shape.
 */
function toNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return null;
}
function attributeValue(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const v = value;
    return v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue;
}
function readAttributes(record) {
    const attrs = {};
    const list = record.attributes;
    if (!Array.isArray(list))
        return attrs;
    for (const entry of list) {
        if (typeof entry !== 'object' || entry === null)
            continue;
        const e = entry;
        if (typeof e.key !== 'string')
            continue;
        attrs[e.key] = attributeValue(e.value);
    }
    return attrs;
}
export function extractSamples(payload) {
    const out = [];
    if (typeof payload !== 'object' || payload === null)
        return out;
    const resourceLogs = payload.resourceLogs;
    if (!Array.isArray(resourceLogs))
        return out;
    for (const resourceLog of resourceLogs) {
        const scopeLogs = resourceLog?.scopeLogs;
        if (!Array.isArray(scopeLogs))
            continue;
        for (const scopeLog of scopeLogs) {
            const records = scopeLog?.logRecords;
            if (!Array.isArray(records))
                continue;
            for (const record of records) {
                if (typeof record !== 'object' || record === null)
                    continue;
                const rec = record;
                const body = rec.body;
                if (body?.stringValue !== 'claude_code.api_request')
                    continue;
                const attrs = readAttributes(rec);
                const sessionId = attrs['session.id'];
                if (!isValidSessionId(sessionId))
                    continue;
                const ts = attrs['event.timestamp'];
                if (typeof ts !== 'string' || ts === '')
                    continue;
                const outputTokens = toNumber(attrs.output_tokens);
                const durationMs = toNumber(attrs.duration_ms);
                const ttftMs = toNumber(attrs.ttft_ms);
                if (outputTokens === null || durationMs === null || ttftMs === null)
                    continue;
                const model = typeof attrs.model === 'string' && attrs.model !== '' ? attrs.model : undefined;
                // Which chain issued the request (main thread, a subagent, compaction,
                // …). Recorded rather than filtered on, so the raw measurement survives
                // a change in what the reader chooses to include.
                const querySource = typeof attrs.query_source === 'string' && attrs.query_source !== ''
                    ? attrs.query_source
                    : undefined;
                out.push({
                    sessionId,
                    line: JSON.stringify({
                        ts,
                        ...(model !== undefined ? { model } : {}),
                        ...(querySource !== undefined ? { querySource } : {}),
                        outputTokens,
                        durationMs,
                        ttftMs,
                    }),
                });
            }
        }
    }
    return out;
}
/**
 * Rewrites an over-long sample file down to its tail. The write goes through a
 * temporary file and a rename so a concurrent read sees either the old file or
 * the trimmed one, never a half-truncated one.
 */
function capSampleFile(filePath) {
    let size;
    try {
        size = fs.statSync(filePath).size;
    }
    catch {
        return;
    }
    if (size <= MAX_SAMPLE_FILE_BYTES)
        return;
    const fd = fs.openSync(filePath, 'r');
    let tail;
    try {
        const buf = Buffer.alloc(TRIM_KEEP_BYTES);
        const read = fs.readSync(fd, buf, 0, TRIM_KEEP_BYTES, size - TRIM_KEEP_BYTES);
        tail = buf.subarray(0, read);
    }
    finally {
        fs.closeSync(fd);
    }
    const newline = tail.indexOf(0x0a);
    // A retained fragment with no terminator would fuse with the next appended
    // sample and make that sample unreadable, so it gets one.
    const keep = newline >= 0
        ? tail.subarray(newline + 1)
        : Buffer.concat([Buffer.from('\n'), tail]);
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, keep, { mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
}
export function appendSamples(homeDir, samples) {
    if (samples.length === 0)
        return;
    const dir = getOtelDir(homeDir);
    try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    catch {
        return;
    }
    const touched = new Set();
    for (const sample of samples) {
        try {
            const filePath = getSamplePath(homeDir, sample.sessionId);
            fs.appendFileSync(filePath, `${sample.line}\n`, {
                encoding: 'utf8',
                mode: 0o600,
            });
            touched.add(filePath);
        }
        catch {
            // Losing one sample only means one refresh falls back to the estimate.
        }
    }
    for (const filePath of touched) {
        try {
            capSampleFile(filePath);
        }
        catch {
            // An unreadable or unwritable file is retried on the next batch.
        }
    }
}
export function pruneOldSamples(homeDir, retentionDays, now) {
    const dir = getOtelDir(homeDir);
    let entries;
    try {
        entries = fs.readdirSync(dir);
    }
    catch {
        return;
    }
    const maxAgeMs = retentionDays * DAY_MS;
    const survivors = [];
    for (const name of entries) {
        if (!name.endsWith('.jsonl'))
            continue;
        const full = path.join(dir, name);
        try {
            const stat = fs.statSync(full);
            if (now - stat.mtimeMs > maxAgeMs) {
                fs.unlinkSync(full);
                continue;
            }
            survivors.push({ path: full, mtimeMs: stat.mtimeMs, size: stat.size });
        }
        catch {
            // A file that vanished mid-scan is already pruned.
        }
    }
    // Age cannot bound the directory on its own, so the oldest survivors go once
    // either ceiling is crossed. Evicting oldest-first is safe because a render
    // only ever reads the sample file of the session it belongs to.
    survivors.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let count = survivors.length;
    let total = survivors.reduce((sum, file) => sum + file.size, 0);
    for (const file of survivors) {
        if (count <= MAX_SAMPLE_FILES && total <= MAX_SAMPLE_DIR_BYTES)
            break;
        try {
            fs.unlinkSync(file.path);
            count -= 1;
            total -= file.size;
        }
        catch {
            // Already gone; it still stops counting against the ceilings.
            count -= 1;
            total -= file.size;
        }
    }
}
//# sourceMappingURL=receiver.js.map