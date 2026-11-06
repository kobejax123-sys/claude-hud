import type { TranscriptData } from './types.ts';

// Output speed measured from Claude Code's OpenTelemetry api_request events: output tokens over the
// decode window (request time minus the wait for the first token). The `otel.speed` probe answers
// with the tail of this session's sample file, which otel-receiver.mjs writes; this only reads it.

/**
 * Output a request needs before its rate is trusted. The window `duration_ms - ttft_ms` carries a
 * fixed per-request cost (606 real samples fit `decodeMs = 4.4 * outputTokens + 335ms`, R² = 0.98),
 * which dominates a short reply: 12 tokens measure ~20 tps against ~230 for a long reply from the
 * same model. This floor keeps the reading within about 20% of a long request's.
 */
const MIN_OUTPUT_TOKENS = 150;

/**
 * Decode window a request needs before its rate is trusted. A relay that buffers a response and
 * flushes it in one frame reports a window that barely moves with the token count (195 tokens in
 * 34ms), while real streaming never fell below ~500ms. Guarding the window, not the rate, keeps
 * genuinely fast models (~1000 tps) and drops burst artifacts.
 */
const MIN_DECODE_MS = 500;

export interface SpeedSample {
  ts: string;
  model?: string;
  querySource?: string;
  outputTokens: number;
  durationMs: number;
  ttftMs: number;
}

/**
 * True for a request from the main conversation. Mirrors Claude Code's `query_source`:
 * `repl_main_thread` (with any output-style suffix) and `sdk` are the main chain; `agent:` and
 * `hook_agent` are subagents; the rest (compaction, side questions, web search) is auxiliary. A
 * subagent on the session model can't be told apart by model. Absent means main: older samples and
 * some providers don't report it, and guessing "subagent" would blank the segment.
 */
export function isMainChainQuery(source: string | undefined): boolean {
  return source === undefined || source.startsWith('repl_main_thread') || source === 'sdk';
}

const finiteNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

export function parseSample(line: string): SpeedSample | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.ts !== 'string' || r.ts === '') return null;
  const outputTokens = finiteNumber(r.outputTokens);
  const durationMs = finiteNumber(r.durationMs);
  const ttftMs = finiteNumber(r.ttftMs);
  if (outputTokens === null || durationMs === null || ttftMs === null) return null;
  return {
    ts: r.ts,
    outputTokens,
    durationMs,
    ttftMs,
    ...(typeof r.model === 'string' && r.model !== '' ? { model: r.model } : {}),
    ...(typeof r.querySource === 'string' && r.querySource !== '' ? { querySource: r.querySource } : {}),
  };
}

export function computeTps(sample: Pick<SpeedSample, 'outputTokens' | 'durationMs' | 'ttftMs'>): number | null {
  if (sample.outputTokens < MIN_OUTPUT_TOKENS || sample.ttftMs < 0 || sample.durationMs <= sample.ttftMs) return null;
  const decodeMs = sample.durationMs - sample.ttftMs;
  if (decodeMs < MIN_DECODE_MS) return null;
  // Samples come from network payloads: a huge count over a short window overflows to Infinity.
  const tps = sample.outputTokens / (decodeMs / 1000);
  return Number.isFinite(tps) ? tps : null;
}

/** The main-chain samples the single-request guards accept, oldest first. */
function measured(text: string): Array<SpeedSample & { at: number }> {
  return text.split('\n').flatMap((line) => {
    const sample = line.trim() ? parseSample(line.trim()) : null;
    // A malformed timestamp compares false every way and would silently drop out, so it goes here.
    const at = sample ? Date.parse(sample.ts) : NaN;
    return sample && Number.isFinite(at) && isMainChainQuery(sample.querySource) && computeTps(sample) !== null ? [{ ...sample, at }] : [];
  });
}

/**
 * Output over decode time, summed over the requests after `sinceMs` and up to `untilMs`: one turn.
 * One request is a poor sample (a turn of tool calls is all short replies), and summing divides the
 * noise out. Null when the turn has nothing measurable yet.
 */
function turnRate(samples: Array<SpeedSample & { at: number }>, sinceMs: number, untilMs = Number.POSITIVE_INFINITY): number | null {
  let outputTokens = 0;
  let decodeMs = 0;
  for (const s of samples) {
    if (s.at <= sinceMs || s.at > untilMs) continue;
    outputTokens += s.outputTokens;
    decodeMs += s.durationMs - s.ttftMs;
  }
  return decodeMs > 0 ? outputTokens / (decodeMs / 1000) : null;
}

/**
 * The rate the segment shows: the turn in progress (after the last `turn_duration`, or since the
 * session began); until it has a measured request, the last completed turn; failing both, the last
 * measured request, so the segment never blanks at the start of a turn. Null until one exists, or
 * when telemetry is off: there is no estimate to fall back on, since one from API time includes the
 * first-token wait and reads about half the real rate on short replies.
 */
export function getOutputSpeed(samples: unknown, transcript: TranscriptData): number | null {
  if (typeof samples !== 'string') return null;
  const list = measured(samples);
  if (list.length === 0) return null;
  const since = transcript.lastTurnEndAt?.getTime() ?? null;
  const previous = transcript.previousTurnEndAt?.getTime() ?? null;
  return turnRate(list, since ?? Number.NEGATIVE_INFINITY)
    ?? (since !== null ? turnRate(list, previous ?? Number.NEGATIVE_INFINITY, since) : null)
    ?? computeTps(list[list.length - 1]);
}
