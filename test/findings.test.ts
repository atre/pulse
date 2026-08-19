import test from 'node:test';
import assert from 'node:assert/strict';
import { sortFindings, summarize, type Finding } from '../src/findings.js';

const f = (id: string, scope: Finding['scope'], severity: Finding['severity']): Finding => ({
  id,
  scope,
  severity,
  title: 't',
});

test('sortFindings: crit → warn → ok, then scope, then id', () => {
  const input: Finding[] = [
    f('site:b', 'site', 'ok'),
    f('k8s:z', 'k8s', 'warn'),
    f('site:a', 'site', 'crit'),
    f('cron:a', 'cron', 'crit'),
    f('k8s:a', 'k8s', 'crit'),
    f('k8s:b', 'k8s', 'crit'),
    f('probe:kubectl', 'probe', 'crit'),
  ];
  const ids = sortFindings(input).map((x) => x.id);
  assert.deepEqual(ids, ['probe:kubectl', 'k8s:a', 'k8s:b', 'cron:a', 'site:a', 'k8s:z', 'site:b']);
});

test('sortFindings does not mutate input', () => {
  const input = [f('b', 'site', 'ok'), f('a', 'site', 'crit')];
  sortFindings(input);
  assert.equal(input[0].id, 'b');
});

test('summarize counts per scope and severity', () => {
  const s = summarize([
    f('k8s:a', 'k8s', 'crit'),
    f('k8s:b', 'k8s', 'ok'),
    f('site:a', 'site', 'warn'),
    f('site:b', 'site', 'ok'),
    f('site:c', 'site', 'ok'),
  ]);
  assert.equal(s.total, 5);
  assert.equal(s.crit, 1);
  assert.equal(s.warn, 1);
  assert.equal(s.ok, 3);
  assert.deepEqual(s.byScope.k8s, { crit: 1, warn: 0, ok: 1 });
  assert.deepEqual(s.byScope.site, { crit: 0, warn: 1, ok: 2 });
  assert.equal(s.byScope.cron, undefined);
});
