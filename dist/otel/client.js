import * as fs from 'node:fs';
import { getSamplePath } from './paths.js';
/**
 * Output a request needs before its rate is trusted.
 *
 * The window `duration_ms - ttft_ms` covers the whole response, not only token
 * generation: regressing 606 real samples gives
 * `decodeMs = 4.4 * outputTokens + 335ms` with R² = 0.98, and subtracting that
 * constant collapses every length bucket onto the same rate. The overhead is
 * therefore a fixed per-request cost, and on a short reply it dominates the
 * measurement — a 12-token reply measures ~20 tps against ~230 tps for a long
 * one, from the same model. Requiring a floor keeps the displayed number within
 * roughly 20% of the rate a long request reports.
 */
const MIN_OUTPUT_TOKENS = 150;
/**
 * Decode window a request needs before its rate is trusted.
 *
 * A relay that buffers a response and flushes it as one frame reports a window
 * that barely moves with the token count: across this machine's samples every
 * such reply lands under 200ms (195 tokens in 34ms, 303 in 63ms) while genuine
 * token-by-token streaming never falls below ~500ms. The window is therefore
 * what separates a measurement from an artifact, and a short one carries no rate
 * information at all.
 *
 * Guarding on the window rather than on the rate matters for correctness, not
 * just for taste. A 500 tps ceiling sat at the 99th percentile of real samples
 * here, so it discarded measurements from genuinely fast models (Gemini Flash
 * reaches ~1000 tps on long replies) while still admitting burst artifacts that
 * happened to land just under it.
 */
const MIN_DECODE_MS = 500;
/** Only the tail of a sample file is read; a session's file stays small but is not bounded. */
const TAIL_BYTES = 8192;
/**
 * Tail window for aggregating one turn. A turn issues several requests, so it
 * needs more than the last sample's worth of file: at roughly 120 bytes per
 * recorded sample this covers several hundred requests, and truncating a very
 * long turn drops old samples from the numerator and the denominator alike,
 * which leaves the ratio — a rate, not a count — intact.
 */
const TURN_TAIL_BYTES = 64 * 1024;
/**
 * True for a request issued by the main conversation rather than by a subagent
 * or an auxiliary call.
 *
 * Mirrors Claude Code's own classification of `query_source`: `repl_main_thread`
 * (with any output-style suffix) and `sdk` are the main chain, `agent:` and
 * `hook_agent` are subagents, and everything else — compaction, side questions,
 * web search, auto mode — is auxiliary.
 *
 * A subagent has to be excluded by this rather than by its model, because a
 * subagent that inherits the session model is indistinguishable by model name.
 * It still writes into the same session's sample file, so without this a turn
 * that spawns an explorer blends two chains' requests into one rate.
 *
 * An absent field is treated as main: it means the sample predates this
 * attribute or the provider does not report it, and guessing "subagent" there
 * would silently blank the segment.
 */
export function isMainChainQuery(source) {
    if (source === undefined)
        return true;
    return source.startsWith('repl_main_thread') || source === 'sdk';
}
function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
export function parseSample(line) {
    let raw;
    try {
        raw = JSON.parse(line);
    }
    catch {
        return null;
    }
    if (typeof raw !== 'object' || raw === null)
        return null;
    const r = raw;
    if (typeof r.ts !== 'string' || r.ts === '')
        return null;
    const outputTokens = finiteNumber(r.outputTokens);
    const durationMs = finiteNumber(r.durationMs);
    const ttftMs = finiteNumber(r.ttftMs);
    if (outputTokens === null || durationMs === null || ttftMs === null)
        return null;
    return {
        ts: r.ts,
        outputTokens,
        durationMs,
        ttftMs,
        ...(typeof r.model === 'string' && r.model !== '' ? { model: r.model } : {}),
        ...(typeof r.querySource === 'string' && r.querySource !== '' ? { querySource: r.querySource } : {}),
    };
}
export function computeTps(sample) {
    if (sample.outputTokens < MIN_OUTPUT_TOKENS)
        return null;
    if (sample.ttftMs < 0)
        return null;
    if (sample.durationMs <= sample.ttftMs)
        return null;
    const decodeMs = sample.durationMs - sample.ttftMs;
    if (decodeMs < MIN_DECODE_MS)
        return null;
    // Samples come from a file the receiver wrote from network payloads, and a
    // finite-but-huge token count over a short window overflows to Infinity. The
    // renderer would print that verbatim, so anything not finite is unusable.
    const tps = sample.outputTokens / (decodeMs / 1000);
    if (!Number.isFinite(tps))
        return null;
    return tps;
}
/**
 * Reads the tail of a sample file as whole lines. Reading only the tail keeps
 * this O(1) regardless of how long the session has been running.
 *
 * A window that does not begin at the start of the file may begin mid-line, in
 * which case its first segment is a partial line that must not be parsed. The byte
 * immediately before the window tells the two cases apart exactly, so a window
 * that happens to land on a line boundary still keeps its first line.
 */
function readTailLines(filePath, maxBytes) {
    let fd;
    try {
        fd = fs.openSync(filePath, 'r');
    }
    catch {
        return null;
    }
    try {
        const size = fs.fstatSync(fd).size;
        const start = Math.max(0, size - maxBytes);
        const length = size - start;
        if (length <= 0)
            return null;
        let firstUsable = 0;
        if (start > 0) {
            const probe = Buffer.alloc(1);
            fs.readSync(fd, probe, 0, 1, start - 1);
            firstUsable = probe[0] === 0x0a ? 0 : 1;
        }
        const buf = Buffer.alloc(length);
        fs.readSync(fd, buf, 0, length, start);
        return buf.toString('utf8').split('\n').slice(firstUsable);
    }
    catch {
        return null;
    }
    finally {
        try {
            fs.closeSync(fd);
        }
        catch {
            // Closing a read-only handle should not fail; ignore if it does.
        }
    }
}
export function readLastSample(filePath) {
    const lines = readTailLines(filePath, TAIL_BYTES);
    if (!lines)
        return null;
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line === '')
            continue;
        const parsed = parseSample(line);
        // Only a sample the guards accept is worth returning. An interrupted or
        // failed request is recorded with no output, and returning it would blank a
        // segment that is meant to hold the last rate it measured.
        if (parsed && isMainChainQuery(parsed.querySource) && computeTps(parsed) !== null)
            return parsed;
    }
    return null;
}
/**
 * Sums the measured requests recorded after `sinceMs` — one turn's worth.
 *
 * A single request is a poor sample: a turn that only issues tool calls is all
 * short replies whose fixed per-request cost lands in the denominator, and any
 * one request's window is small enough to swing the reading. Summing tokens and
 * decode windows over the turn divides that noise out, which is what makes the
 * result stable enough to hold on screen.
 *
 * Samples the single-request guards reject are skipped here too, so the turn
 * reading can never disagree with what the segment would show for one request.
 * Requests from a subagent or an auxiliary chain are skipped as well: they land
 * in the same session's file but are not the turn the user is watching, and a
 * subagent running the session model would otherwise be invisible to a
 * model-based filter.
 *
 * Returns null when the turn has produced nothing measurable yet, which leaves
 * the caller free to keep showing the previous turn's rate.
 */
export function readTurnAggregate(filePath, sinceMs) {
    const lines = readTailLines(filePath, TURN_TAIL_BYTES);
    if (!lines)
        return null;
    let outputTokens = 0;
    let decodeMs = 0;
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '')
            continue;
        const parsed = parseSample(trimmed);
        if (!parsed || !isMainChainQuery(parsed.querySource) || computeTps(parsed) === null)
            continue;
        // A sample file is written from network payloads, so a malformed timestamp
        // must be skipped rather than compared as NaN, which is false for every
        // ordering and would silently drop the sample.
        const at = Date.parse(parsed.ts);
        if (!Number.isFinite(at) || at <= sinceMs)
            continue;
        outputTokens += parsed.outputTokens;
        decodeMs += parsed.durationMs - parsed.ttftMs;
    }
    if (decodeMs <= 0)
        return null;
    return { outputTokens, decodeMs };
}
/**
 * The most recent measured rate for a session, or null when nothing has been
 * recorded yet. Deliberately not time-bounded: the speed segment is meant to
 * stay on the last measured value rather than decay back to a placeholder.
 *
 * When `sinceMs` is given the rate is aggregated over the requests recorded
 * after it — the turn in progress — which is what the statusline shows. A turn
 * that has not yet produced a measurable request falls back to the last single
 * sample, so the segment holds its previous reading instead of blanking at the
 * start of every turn.
 */
export function getOtelTps(homeDir, sessionId, sinceMs = null) {
    let samplePath;
    try {
        samplePath = getSamplePath(homeDir, sessionId);
    }
    catch {
        return null;
    }
    if (sinceMs !== null) {
        const aggregate = readTurnAggregate(samplePath, sinceMs);
        if (aggregate)
            return aggregate.outputTokens / (aggregate.decodeMs / 1000);
    }
    const sample = readLastSample(samplePath);
    if (!sample)
        return null;
    return computeTps(sample);
}
//# sourceMappingURL=client.js.map