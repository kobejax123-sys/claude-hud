import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, mergeConfig } from '../dist/config.js';

// No CLAUDE_CONFIG_DIR guard here: this file never resolves a sample path, so
// the variable cannot affect any assertion below.

test('defaults expose an otel block', () => {
  assert.equal(DEFAULT_CONFIG.otel.mode, 'auto');
  assert.equal(DEFAULT_CONFIG.otel.autoStart, true);
  assert.equal(DEFAULT_CONFIG.otel.sampleRetentionDays, 7);
});

test('mergeConfig fills the otel block when the user config omits it', () => {
  const config = mergeConfig({});
  assert.deepEqual(config.otel, { mode: 'auto', autoStart: true, sampleRetentionDays: 7 });
});

test('mergeConfig accepts valid otel overrides', () => {
  const config = mergeConfig({ otel: { mode: 'off', autoStart: false, sampleRetentionDays: 3 } });
  assert.deepEqual(config.otel, { mode: 'off', autoStart: false, sampleRetentionDays: 3 });
});

test('mergeConfig rejects an unknown otel mode and falls back', () => {
  const config = mergeConfig({ otel: { mode: 'sometimes' } });
  assert.equal(config.otel.mode, 'auto');
});

test('mergeConfig rejects a negative or fractional retention and falls back', () => {
  assert.equal(mergeConfig({ otel: { sampleRetentionDays: -1 } }).otel.sampleRetentionDays, 7);
  assert.equal(mergeConfig({ otel: { sampleRetentionDays: 1.5 } }).otel.sampleRetentionDays, 7);
  assert.equal(mergeConfig({ otel: { sampleRetentionDays: 'soon' } }).otel.sampleRetentionDays, 7);
});

test('mergeConfig ignores a non-boolean autoStart', () => {
  assert.equal(mergeConfig({ otel: { autoStart: 'yes' } }).otel.autoStart, true);
});

test('existing display config is unaffected by the new block', () => {
  const config = mergeConfig({ display: { showSpeed: true } });
  assert.equal(config.display.showSpeed, true);
  assert.equal(config.otel.mode, 'auto');
});
