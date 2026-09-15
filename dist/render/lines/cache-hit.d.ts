import type { RenderContext } from '../../types.js';
/**
 * Cache hit rate of the most recent request: the share of its input tokens that
 * came from the prompt cache.
 *
 * The denominator is the whole input — cache reads, cache writes, and tokens
 * that never touched the cache. Some Anthropic-compatible endpoints never
 * report cache writes (`cache_creation_input_tokens` stays 0); leaving those
 * out of the denominator would collapse the rate to a constant 100%.
 *
 * Returns null when the rate is not known yet — no usage frame, or a request
 * with no cache activity. The caller renders that as a placeholder rather than
 * dropping the segment, so the slot stays put from the first frame.
 */
export declare function formatCacheHitRate(ctx: RenderContext): string | null;
export declare function renderCacheHitSegment(ctx: RenderContext): string | null;
//# sourceMappingURL=cache-hit.d.ts.map