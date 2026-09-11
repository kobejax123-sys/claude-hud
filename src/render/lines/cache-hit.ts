import type { RenderContext } from '../../types.js';
import { label } from '../colors.js';
import { t } from '../../i18n/index.js';

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
export function formatCacheHitRate(ctx: RenderContext): string | null {
  const usage = ctx.stdin.context_window?.current_usage;
  if (!usage) {
    return null;
  }

  const inputTokens = usage.input_tokens ?? 0;
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  if (cacheRead + cacheCreation <= 0) {
    return null;
  }

  const total = inputTokens + cacheCreation + cacheRead;
  const percent = Math.round((cacheRead / total) * 1000) / 10;
  return `${percent.toFixed(1)}%`;
}

export function renderCacheHitSegment(ctx: RenderContext): string | null {
  if (ctx.config?.display?.showCacheHit !== true) {
    return null;
  }

  const rate = formatCacheHitRate(ctx) ?? '--';
  return label(`${t('label.cacheHit')} ${rate}`, ctx.config?.colors);
}
