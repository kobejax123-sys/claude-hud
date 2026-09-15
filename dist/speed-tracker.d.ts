import type { StdinData } from './types.js';
import type { HudConfig } from './config.js';
export type SpeedTrackerDeps = {
    homeDir: () => string;
    now: () => number;
};
export declare function getOutputSpeed(stdin: StdinData, overrides?: Partial<SpeedTrackerDeps>): number | null;
/**
 * The rate to display in the speed segment: the last request-level measurement
 * reported by Claude Code's OpenTelemetry export, or null when nothing has been
 * measured yet.
 *
 * The snapshot-based estimate is deliberately not used as a fallback. A number
 * derived from refresh timing disagrees with the measured one often enough to be
 * misleading, so callers render an explicit placeholder instead.
 */
export declare function getMeasuredTps(stdin: StdinData, config?: HudConfig, overrides?: Partial<SpeedTrackerDeps>, turnEndedAt?: Date): number | null;
//# sourceMappingURL=speed-tracker.d.ts.map