import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderIdentityLine } from '../dist/render/lines/identity.js';
import { setLanguage } from '../dist/i18n/index.js';

const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';

function makeCtx({ contextTokens, currentUsage } = {}) {
  return {
    stdin: {
      model: { display_name: 'Opus' },
      context_window: {
        context_window_size: 1000000,
        current_usage: currentUsage ?? {
          input_tokens: 1000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 115000,
        },
      },
    },
    transcript: { tools: [], skills: [], mcpServers: [], agents: [], todos: [] },
    config: {
      display: {
        contextValue: 'both',
        showContextBar: false,
        showTokenBreakdown: false,
        autocompactBuffer: 'disabled',
      },
      colors: contextTokens === undefined ? {} : { contextTokens },
    },
  };
}

test('contextTokens colors only the parenthetical, leaving the percentage on its health color', () => {
  setLanguage('en');
  const line = renderIdentityLine(makeCtx({ contextTokens: 'cyan' }));
  assert.ok(line.includes(`${GREEN}12%`), `expected a green percentage, got: ${JSON.stringify(line)}`);
  assert.ok(line.includes(`${CYAN}(116k/1.0M)`), `expected a cyan parenthetical, got: ${JSON.stringify(line)}`);
});

test('without contextTokens the whole value keeps the health color', () => {
  setLanguage('en');
  const line = renderIdentityLine(makeCtx());
  assert.ok(line.includes(`${GREEN}12% (116k/1.0M)`), `expected the unchanged form, got: ${JSON.stringify(line)}`);
});

test('contextTokens does not override the warning threshold color', () => {
  setLanguage('en');
  const ctx = makeCtx({
    contextTokens: 'cyan',
    currentUsage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 730000 },
  });
  const line = renderIdentityLine(ctx);
  assert.ok(line.includes(`${YELLOW}73%`), `expected a yellow percentage, got: ${JSON.stringify(line)}`);
  assert.ok(line.includes(`${CYAN}(731k/1.0M)`), `expected a cyan parenthetical, got: ${JSON.stringify(line)}`);
});
