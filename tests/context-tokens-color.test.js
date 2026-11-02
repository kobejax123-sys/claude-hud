import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextBarAndValue } from '../dist/render/context.js';
import { mergeConfig } from '../dist/config.js';

const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';

function frame(cacheRead, colors = {}, contextValue = 'both') {
  const config = mergeConfig({ display: { contextValue, showContextBar: false }, colors });
  return {
    stdin: { context_window: { context_window_size: 1_000_000, current_usage: { input_tokens: 1000, cache_read_input_tokens: cacheRead } } },
    transcript: { tools: [], skills: [], mcpServers: [], mcpErrors: [], agents: [], todos: [] },
    config,
    barWidth: 10,
  };
}

test('contextTokens colors only the parenthetical, leaving the percentage on its health color', () => {
  const { value } = contextBarAndValue(frame(115_000, { contextTokens: 'cyan' }));
  assert.ok(value.includes(`${GREEN}12%`), JSON.stringify(value));
  assert.ok(value.includes(`${CYAN}(116k/1.0M)`), JSON.stringify(value));
});

test('without contextTokens, or outside "both", the whole value keeps the health color', () => {
  assert.ok(contextBarAndValue(frame(115_000)).value.includes(`${GREEN}12% (116k/1.0M)`));
  assert.ok(contextBarAndValue(frame(115_000, { contextTokens: 'not-a-color' })).value.includes(`${GREEN}12% (116k/1.0M)`));
  assert.ok(contextBarAndValue(frame(115_000, { contextTokens: 'cyan' }, 'tokens')).value.includes(`${GREEN}116k/1.0M`));
});

test('contextTokens does not override the warning threshold color', () => {
  const { value } = contextBarAndValue(frame(730_000, { contextTokens: 'cyan' }));
  assert.ok(value.includes(`${YELLOW}73%`), JSON.stringify(value));
  assert.ok(value.includes(`${CYAN}(731k/1.0M)`), JSON.stringify(value));
});
