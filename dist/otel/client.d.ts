export interface SpeedSample {
    ts: string;
    model?: string;
    querySource?: string;
    outputTokens: number;
    durationMs: number;
    ttftMs: number;
}
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
export declare function isMainChainQuery(source: string | undefined): boolean;
export declare function parseSample(line: string): SpeedSample | null;
export declare function computeTps(sample: Pick<SpeedSample, 'outputTokens' | 'durationMs' | 'ttftMs'>): number | null;
export declare function readLastSample(filePath: string): SpeedSample | null;
/** Output tokens and decode milliseconds summed over one turn's requests. */
export interface TurnAggregate {
    outputTokens: number;
    decodeMs: number;
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
export declare function readTurnAggregate(filePath: string, sinceMs: number): TurnAggregate | null;
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
export declare function getOtelTps(homeDir: string, sessionId: string, sinceMs?: number | null): number | null;
//# sourceMappingURL=client.d.ts.map