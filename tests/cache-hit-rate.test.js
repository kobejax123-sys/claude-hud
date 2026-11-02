import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheHitRateLine } from '../src/render/lines.ts';

const strip = (s) => s?.replace(/\x1b\[[0-9;]*m/g, '');
const ctx = (usage, display = { showCacheHitRate: true }) => ({
  stdin: { context_window: { current_usage: usage }, prompt_cache: { hit_ratio: 0.5 } },
  config: { display, colors: {} },
});

test('the cache hit rate is the last request\'s cache reads over its whole input', () => {
  const usage = { input_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: 8900 };
  assert.equal(strip(cacheHitRateLine(ctx(usage))), 'Cache hit 89.0%');
  // Endpoints that never report cache writes still get a real rate, not 100%.
  assert.equal(strip(cacheHitRateLine(ctx({ input_tokens: 500, cache_read_input_tokens: 1500 }))), 'Cache hit 75.0%');
});

test('the cache hit rate reads -- until a request with cache activity, and is off by default', () => {
  assert.equal(strip(cacheHitRateLine(ctx(undefined))), 'Cache hit --');
  assert.equal(strip(cacheHitRateLine(ctx({ input_tokens: 500, output_tokens: 20 }))), 'Cache hit --');
  assert.equal(cacheHitRateLine(ctx({ cache_read_input_tokens: 100 }, {})), null);
});

test('expanded: the cache hit rate shares the compactions line until placed in elementOrder', async () => {
  const { expandedLines } = await import('../src/render/expanded.ts');
  const { DEFAULT_CONFIG } = await import('../src/config.ts');
  const frame = (elementOrder) => ({
    stdin: { context_window: { current_usage: { input_tokens: 100, cache_read_input_tokens: 900 } } },
    transcript: { tools: [], skills: [], mcpServers: [], mcpErrors: [], agents: [], todos: [], compactionCount: 2 },
    claudeMdCount: 0, rulesCount: 0, mcpCount: 0, hooksCount: 0,
    costTotals: null, outputSpeed: null, gitStatus: null, usageData: null, memoryUsage: null, extraLabel: null, authInfo: null,
    config: { ...DEFAULT_CONFIG, elementOrder, display: { ...DEFAULT_CONFIG.display, showModel: false, showProject: false, showCacheHitRate: true, showCompactions: true } },
    now: 0, width: null, barWidth: 10,
  });
  assert.deepEqual(expandedLines(frame(['project'])).map(strip), ['Cache hit 90.0% │ Compactions: 2']);
  assert.deepEqual(expandedLines(frame(['cacheHitRate'])).map(strip), ['Cache hit 90.0%', 'Compactions: 2']);
});
