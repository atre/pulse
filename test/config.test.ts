import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, DEFAULT_BUDGETS } from '../src/config.js';

const dir = mkdtempSync(join(tmpdir(), 'pulse-config-'));
const write = (name: string, content: string): string => {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
};

test('missing file → empty config with defaults, probes skipped', () => {
  const cfg = loadConfig(join(dir, 'nope.json'));
  assert.equal(cfg.path, null);
  assert.equal(cfg.triedPath, join(dir, 'nope.json'));
  assert.deepEqual(cfg.sites, []);
  assert.deepEqual(cfg.hosts, []);
  assert.equal(cfg.k8s, undefined);
  assert.deepEqual(cfg.budgets, DEFAULT_BUDGETS);
});

test('bad JSON → throws with the path in the message', () => {
  const p = write('bad.json', '{ nope');
  assert.throws(() => loadConfig(p), (e: Error) => e.message.includes(p));
});

test('defaults applied; $comment and unknown keys ignored', () => {
  const p = write(
    'full.json',
    JSON.stringify({
      $comment: 'ignored',
      unknownKey: { whatever: 1 },
      k8s: { context: 'default', $comment: 'ignored too' },
      sites: [
        { url: 'https://a.example/', expect: { status: 200, contains: 'A' } },
        { url: 'https://b.example/', expect: { status: [200, 401] }, lan: true },
        { url: 'https://c.example/', group: 'g' },
      ],
      budgets: { siteTimeoutMs: 3000 },
    }),
  );
  const cfg = loadConfig(p);
  assert.equal(cfg.path, p);
  // k8s defaults
  assert.equal(cfg.k8s?.context, 'default');
  assert.deepEqual(cfg.k8s?.ignoreNamespaces, ['kube-system', 'kube-public', 'kube-node-lease']);
  assert.deepEqual(cfg.k8s?.scaledToZeroOk, []);
  assert.equal(cfg.k8s?.cronjobs.maxMissedRuns, 2);
  // site defaults: status number → array, default [200], tlsDaysMin 14
  assert.deepEqual(cfg.sites[0].expect.status, [200]);
  assert.equal(cfg.sites[0].expect.tlsDaysMin, 14);
  assert.equal(cfg.sites[0].expect.contains, 'A');
  assert.deepEqual(cfg.sites[1].expect.status, [200, 401]);
  assert.equal(cfg.sites[1].lan, true);
  assert.deepEqual(cfg.sites[2].expect.status, [200]);
  assert.equal(cfg.sites[2].group, 'g');
  // budgets merged over defaults
  assert.equal(cfg.budgets.siteTimeoutMs, 3000);
  assert.equal(cfg.budgets.kubectlTimeoutS, DEFAULT_BUDGETS.kubectlTimeoutS);
});

test('site without url → throws with path and index', () => {
  const p = write('nourl.json', JSON.stringify({ sites: [{ group: 'g' }] }));
  assert.throws(() => loadConfig(p), (e: Error) => e.message.includes('sites[0]'));
});

test('examples/config.json parses clean', () => {
  const cfg = loadConfig(new URL('../../examples/config.json', import.meta.url).pathname);
  assert.equal(cfg.sites.length, 13);
  assert.equal(cfg.k8s?.cronjobs.override['assistant/assistant-rentals-classify']?.suspendedOk, true);
  assert.equal(cfg.hosts.length, 1);
});
