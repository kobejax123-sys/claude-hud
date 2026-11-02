import type { Frame } from './frame.js';
import { type LabelAlign } from './labels.js';
/** Config counts, output style, and failing MCP servers. */
export declare function environmentLine(f: Frame): string | null;
export declare function promptCacheLine(f: Frame): string | null;
/**
 * Cache hit rate of the most recent request: cache reads over its whole input
 * (uncached, cache reads, cache writes). Endpoints that never report cache writes
 * would pin a reads-over-cache-traffic rate at 100%. Shows `--` until a request
 * with cache activity, so the slot doesn't pop in mid-session.
 */
export declare function cacheHitRateLine(f: Frame): string | null;
/** `Started: 2026-10-01 11:00 │ Last reply: 1m ago`. */
export declare function sessionTimeLine(f: Frame): string | null;
/** Approximate system RAM (expanded only). */
export declare function memoryLine(f: Frame, align?: LabelAlign): string | null;
/** Added dirs on their own line, when addedDirsLayout is "line". */
export declare function addedDirsLine(f: Frame): string | null;
//# sourceMappingURL=lines.d.ts.map