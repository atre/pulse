import test from 'node:test';
import assert from 'node:assert/strict';
import { intervalMinutes, shortSchedule } from '../src/cron.js';

test('intervalMinutes — accept cases from PLAN 1.4', () => {
  assert.equal(intervalMinutes('*/15 * * * *'), 15);
  assert.equal(intervalMinutes('7 */2 * * *'), 120);
  assert.equal(intervalMinutes('45 6 * * *'), 1440);
  assert.equal(intervalMinutes('17 * * * *'), 60);
  assert.equal(intervalMinutes('27 7-23/4 * * *'), 240);
  assert.equal(intervalMinutes('total garbage'), 1440);
});

test('intervalMinutes — lists, ranges, node-a shapes', () => {
  assert.equal(intervalMinutes('0 3,9,15,21 * * *'), 360);
  assert.equal(intervalMinutes('0 4,16 * * *'), 720);
  assert.equal(intervalMinutes('* * * * *'), 1);
  assert.equal(intervalMinutes('0 5 * * 0'), 1440); // weekly — dow ignored, capped at daily
  assert.equal(intervalMinutes(''), 1440);
  assert.equal(intervalMinutes('99 * * * *'), 1440); // out of range → unparseable
});

test('shortSchedule compacts trailing wildcards', () => {
  assert.equal(shortSchedule('*/15 * * * *'), '*/15');
  assert.equal(shortSchedule('7 */2 * * *'), '7 */2');
  assert.equal(shortSchedule('45 6 * * *'), '45 6');
  assert.equal(shortSchedule('0 5 * * 0'), '0 5 * * 0');
});
