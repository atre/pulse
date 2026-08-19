import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSessionHook } from '../src/init.js';

test('mergeSessionHook: no prior settings → adds SessionStart hook', () => {
  const { text, changed } = mergeSessionHook(undefined);
  assert.equal(changed, true);
  const json = JSON.parse(text);
  assert.equal(json.hooks.SessionStart[0].hooks[0].command, 'command -v pulse >/dev/null 2>&1 || exit 0; pulse --brief 2>/dev/null');
  assert.equal(json.hooks.SessionStart[0].hooks[0].timeout, 20);
});

test('mergeSessionHook: idempotent — running twice does not duplicate', () => {
  const first = mergeSessionHook(undefined);
  const second = mergeSessionHook(first.text);
  assert.equal(second.changed, false);
  assert.equal(JSON.parse(second.text).hooks.SessionStart.length, 1);
});

test('mergeSessionHook: preserves existing unrelated settings', () => {
  const prior = JSON.stringify({ theme: 'dark', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'brief .', timeout: 10 }] }] } });
  const { text } = mergeSessionHook(prior);
  const json = JSON.parse(text);
  assert.equal(json.theme, 'dark');
  assert.equal(json.hooks.SessionStart.length, 2);
  assert.match(json.hooks.SessionStart[0].hooks[0].command, /brief/);
  assert.match(json.hooks.SessionStart[1].hooks[0].command, /pulse/);
});

test('mergeSessionHook: invalid JSON throws (caller reports and skips)', () => {
  assert.throws(() => mergeSessionHook('{not json'));
});
