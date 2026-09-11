import type { RenderContext } from '../../types.js';
import { label } from '../colors.js';
import { renderCacheHitSegment } from './cache-hit.js';
import { renderCompactionsLine } from './compactions.js';

/**
 * The appended stats line: the cache hit rate when `cacheHitPlacement` is
 * "stats", plus the compaction count. Either part can be absent, and the line
 * disappears entirely when both are.
 */
export function renderStatsLine(ctx: RenderContext): string | null {
  const parts: string[] = [];

  if (ctx.config?.display?.cacheHitPlacement === 'stats') {
    const cacheHit = renderCacheHitSegment(ctx);
    if (cacheHit) {
      parts.push(cacheHit);
    }
  }

  const compactions = renderCompactionsLine(ctx);
  if (compactions) {
    parts.push(compactions);
  }

  if (parts.length === 0) {
    return null;
  }

  return parts.join(` ${label('│', ctx.config?.colors)} `);
}
