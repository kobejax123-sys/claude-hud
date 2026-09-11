import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderProjectLine } from '../dist/render/lines/project.js';
import { renderStatsLine } from '../dist/render/lines/stats-line.js';
import { setLanguage } from '../dist/i18n/index.js';

function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
}

function makeCtx({ placement, showCacheHit = true, showCompactions = true, compactionCount = 1 } = {}) {
  return {
    stdin: {
      model: { display_name: 'Opus' },
      cwd: '/tmp/demo',
      context_window: {
        context_window_size: 200000,
        current_usage: {
          input_tokens: 1000,
          cache_creation_input_tokens: 2000,
          cache_read_input_tokens: 8000,
        },
      },
    },
    transcript: {
      tools: [], skills: [], mcpServers: [], agents: [], todos: [],
      compactionCount,
    },
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
        cacheHitPlacement: placement,
        showCompactions,
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

test('firstLine placement keeps the cache hit segment on the project line', () => {
  setLanguage('en');
  const line = stripAnsi(renderProjectLine(makeCtx({ placement: 'firstLine' })));
  assert.match(line, /CacheHit 72\.7%/);
  assert.doesNotMatch(stripAnsi(renderStatsLine(makeCtx({ placement: 'firstLine' })) ?? ''), /CacheHit/);
});

test('stats placement moves the cache hit segment off the project line', () => {
  setLanguage('en');
  const line = stripAnsi(renderProjectLine(makeCtx({ placement: 'stats' })));
  assert.doesNotMatch(line, /CacheHit/);
});

test('stats placement puts cache hit and compactions on one line', () => {
  setLanguage('en');
  const line = stripAnsi(renderStatsLine(makeCtx({ placement: 'stats' })) ?? '');
  assert.equal(line, 'CacheHit 72.7% │ Compactions: 1');
});

test('stats placement shows the cache hit segment alone before the first compaction', () => {
  setLanguage('en');
  const line = stripAnsi(renderStatsLine(makeCtx({ placement: 'stats', compactionCount: 0 })) ?? '');
  assert.equal(line, 'CacheHit 72.7%');
});

test('stats placement keeps the compactions line when cache hit is off', () => {
  setLanguage('en');
  const line = stripAnsi(renderStatsLine(makeCtx({ placement: 'stats', showCacheHit: false })) ?? '');
  assert.equal(line, 'Compactions: 1');
});

test('stats line stays hidden when both parts are off', () => {
  setLanguage('en');
  const ctx = makeCtx({ placement: 'stats', showCacheHit: false, showCompactions: false });
  assert.equal(renderStatsLine(ctx), null);
});
