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
 * Hard ceiling on credible single-client generation speed.
 *
 * Upstream relays or proxies sometimes buffer streaming responses (waiting
 * several seconds for the whole output and dumping hundreds of tokens in a
 * 100-200ms burst). This produces artifactual rates into the thousands of TPS
 * that reflect network burst transfer rather than LLM token generation. Any
 * sample exceeding this threshold is discarded as non-streaming/buffered.
 */
const MAX_PRACTICAL_TPS = 500;

/** Only the tail of a sample file is read; a session's file stays small but is not bounded. */
const TAIL_BYTES = 8192;

export interface SpeedSample {
  ts: string;
  model?: string;
  outputTokens: number;
  durationMs: number;
  ttftMs: number;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

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
  };
}

export function computeTps(sample: Pick<SpeedSample, 'outputTokens' | 'durationMs' | 'ttftMs'>): number | null {
  if (sample.outputTokens < MIN_OUTPUT_TOKENS) return null;
  if (sample.ttftMs < 0) return null;
  if (sample.durationMs <= sample.ttftMs) return null;

  const decodeMs = sample.durationMs - sample.ttftMs;

  // Samples come from a file the receiver wrote from network payloads, and a
  // finite-but-huge token count over a 100ms window overflows to Infinity. The
  // renderer would print that verbatim, so anything not finite is unusable.
  // Burst transfers from buffered upstream relays that exceed MAX_PRACTICAL_TPS
  // are likewise discarded.
  const tps = sample.outputTokens / (decodeMs / 1000);
  if (!Number.isFinite(tps) || tps > MAX_PRACTICAL_TPS) return null;
  return tps;
}

/**
 * Reads the last usable sample from the tail of a sample file. Reading only the
 * tail keeps this O(1) regardless of how long the session has been running.
 *
 * A window that does not begin at the start of the file may begin mid-line, in
 * which case its first segment is a partial line that must not be parsed. The byte
 * immediately before the window tells the two cases apart exactly, so a window
 * that happens to land on a line boundary still keeps its first line.
 */
export function readLastSample(filePath: string): SpeedSample | null {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return null;
  }

  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    if (length <= 0) return null;

    let firstUsable = 0;
    if (start > 0) {
      const probe = Buffer.alloc(1);
      fs.readSync(fd, probe, 0, 1, start - 1);
      firstUsable = probe[0] === 0x0a ? 0 : 1;
    }

    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, start);

    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= firstUsable; i--) {
      const line = lines[i].trim();
      if (line === '') continue;
      const parsed = parseSample(line);
      // Only a sample the guards accept is worth returning. An interrupted or
      // failed request is recorded with no output, and returning it would blank a
      // segment that is meant to hold the last rate it measured.
      if (parsed && computeTps(parsed) !== null) return parsed;
    }
    return null;
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Closing a read-only handle should not fail; ignore if it does.
    }
  }
}

/**
 * The most recent measured rate for a session, or null when nothing has been
 * recorded yet. Deliberately not time-bounded: the speed segment is meant to
 * stay on the last measured value rather than decay back to a placeholder.
 */
export function getOtelTps(homeDir: string, sessionId: string): number | null {
  let samplePath: string;
  try {
    samplePath = getSamplePath(homeDir, sessionId);
  } catch {
    return null;
  }

  const sample = readLastSample(samplePath);
  if (!sample) return null;

  return computeTps(sample);
}
