import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderProjectLine } from '../dist/render/lines/project.js';
import { renderSessionLine } from '../dist/render/session-line.js';
import { setLanguage } from '../dist/i18n/index.js';

function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
}

function makeCtx({ showCacheHit = false, currentUsage } = {}) {
  return {
    stdin: {
      model: { display_name: 'Opus' },
      cwd: '/tmp/demo',
      context_window: {
        context_window_size: 200000,
        current_usage: currentUsage ?? {
          input_tokens: 1000,
          cache_creation_input_tokens: 2000,
          cache_read_input_tokens: 8000,
        },
      },
    },
    transcript: { tools: [], skills: [], mcpServers: [], agents: [], todos: [] },
    claudeMdCount: 0,
    rulesCount: 0,
    mcpCount: 0,
    hooksCount: 0,
    sessionDuration: '',
    gitStatus: null,
    usageData: null,
    memoryUsage: null,
    config: {
      lineLayout: 'compact',
      showSeparators: false,
      pathLevels: 1,
      projectLineOrder: [],
      gitStatus: { enabled: false, showDirty: true, showAheadBehind: false, showFileStats: false, branchOverflow: 'truncate', pushWarningThreshold: 0, pushCriticalThreshold: 0 },
      jjStatus: { enabled: false, showDirty: true, showConflicts: true },
      display: {
        showModel: true,
        showProject: true,
        showCacheHit,
        showContextBar: true,
        contextValue: 'percent',
        showUsage: true,
        usageValue: 'percent',
        usageBarEnabled: false,
        showResetLabel: true,
        showSessionTokens: false,
        showPromptCache: false,
        showCost: false,
        showDuration: false,
        showSpeed: false,
        showConfigCounts: false,
        autocompactBuffer: 'enabled',
        mergeGroups: [['context', 'usage']],
        customLine: '',
      },
      colors: {},
    },
  };
}

test('renders cache hit rate as reads over the whole input', () => {
  setLanguage('en');
  const line = stripAnsi(renderProjectLine(makeCtx({ showCacheHit: true })));
  assert.match(line, /CacheHit 72\.7%/);
});

test('renders cache hit rate to one decimal place', () => {
  setLanguage('en');
  const ctx = makeCtx({
    showCacheHit: true,
    currentUsage: { input_tokens: 10, cache_creation_input_tokens: 1, cache_read_input_tokens: 999 },
  });
  const line = stripAnsi(renderProjectLine(ctx));
  assert.match(line, /CacheHit 98\.9%/);
});

test('renders 0.0% when the request only wrote cache', () => {
  setLanguage('en');
  const ctx = makeCtx({
    showCacheHit: true,
    currentUsage: { input_tokens: 10, cache_creation_input_tokens: 5000, cache_read_input_tokens: 0 },
  });
  const line = stripAnsi(renderProjectLine(ctx));
  assert.match(line, /CacheHit 0\.0%/);
});

test('renders a placeholder when the request had no cache activity', () => {
  setLanguage('en');
  const ctx = makeCtx({
    showCacheHit: true,
    currentUsage: { input_tokens: 5000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  });
  const line = stripAnsi(renderProjectLine(ctx));
  assert.match(line, /CacheHit --/);
});

test('renders a placeholder before the first usage frame arrives', () => {
  setLanguage('en');
  const ctx = makeCtx({ showCacheHit: true });
  delete ctx.stdin.context_window.current_usage;
  const line = stripAnsi(renderProjectLine(ctx));
  assert.match(line, /CacheHit --/);
});

test('hides the segment when showCacheHit is off', () => {
  setLanguage('en');
  const line = stripAnsi(renderProjectLine(makeCtx({ showCacheHit: false })));
  assert.doesNotMatch(line, /CacheHit/);
});

test('reorders the segment through projectLineOrder', () => {
  setLanguage('en');
  const ctx = makeCtx({ showCacheHit: true });
  ctx.config.projectLineOrder = ['cacheHit', 'model'];
  const line = stripAnsi(renderProjectLine(ctx));
  assert.ok(line.startsWith('CacheHit 72.7%'), `expected the cache hit segment first, got: ${line}`);
});

test('renders the segment on the compact session line', () => {
  setLanguage('en');
  const line = stripAnsi(renderSessionLine(makeCtx({ showCacheHit: true })));
  assert.match(line, /CacheHit 72\.7%/);
});

// Endpoints that never report cache writes (cache_creation_input_tokens = 0) used
// to collapse the rate to 100% because the write count was the whole denominator.
// These two cases are real readings from such a session.
test('a warm request with no reported cache writes is not 100%', () => {
  setLanguage('en');
  const ctx = makeCtx({
    showCacheHit: true,
    currentUsage: { input_tokens: 441, cache_creation_input_tokens: 0, cache_read_input_tokens: 161280 },
  });
  const line = stripAnsi(renderProjectLine(ctx));
  assert.match(line, /CacheHit 99\.7%/);
});

test('a cache miss with no reported cache writes reads near zero', () => {
  setLanguage('en');
  const ctx = makeCtx({
    showCacheHit: true,
    currentUsage: { input_tokens: 166688, cache_creation_input_tokens: 0, cache_read_input_tokens: 896 },
  });
  const line = stripAnsi(renderProjectLine(ctx));
  assert.match(line, /CacheHit 0\.5%/);
});
