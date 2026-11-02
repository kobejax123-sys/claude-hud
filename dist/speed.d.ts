import type { StdinData, TranscriptData } from './types.js';
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
export declare function getOutputSpeed(stdin: StdinData, homeDir: string, transcript: TranscriptData): number | null;
//# sourceMappingURL=speed.d.ts.map