import test from 'node:test';
import assert from 'node:assert/strict';
import { renderText, renderMd, renderJson, foldGreen, idish } from '../src/render.js';
import type { Finding } from '../src/types.js';
import type { RenderMeta } from '../src/render.js';

const meta = (over: Partial<RenderMeta> = {}): RenderMeta => ({
  ts: 1_700_000_000_000,
  elapsedMs: 1234,
  configPath: '/tmp/config.json',
  ctx: 'default',
  sections: { k8s: true, sites: true, disks: false, hosts: false },
  stats: { workloads: 13, cronjobs: 26, nodes: 3, nodesReady: 3, pvcs: 6 },
  siteCount: 13,
  ...over,
});

const f = (id: string, scope: Finding['scope'], severity: Finding['severity'], title: string, extra: Partial<Finding> = {}): Finding => ({
  id,
  scope,
  severity,
  title,
  ...extra,
});

const mixed: Finding[] = [
  f('site:https://a.example/', 'site', 'ok', '200 in 120ms', { group: 'hosting', status: 200, latencyMs: 120 }),
  f('site:https://b.example/', 'site', 'ok', '200 in 420ms', { group: 'hosting', status: 200, latencyMs: 420 }),
  f('k8s:assistant/assistant-mcp', 'k8s', 'crit', '0/1 ready', { hint: 'kubectl -n assistant get pods -l app=assistant-mcp' }),
  f('cron:assistant/assistant-rss-sync', 'cron', 'warn', 'suspended', { hint: 'add override' }),
  f('k8s:commerce/storefront', 'k8s', 'ok', '1/1 ready'),
  f('node:node-a', 'node', 'ok', 'Ready'),
  f('cron:syncbot/acme-sync', 'cron', 'ok', 'on schedule'),
];

test('ordering: crit lines before warn, green folded last, never listed', () => {
  const txt = renderText(mixed, meta());
  const lines = txt.split('\n');
  assert.match(lines[0], /^pulse — k3s default 3\/3 nodes · 13 workloads · 26 cronjobs · 13 sites · 1234ms$/);
  assert.match(lines[1], /^✗ assistant\/assistant-mcp/);
  assert.match(lines[2], /^⚠ assistant\/assistant-rss-sync/);
  assert.match(lines[3], /^✓ /);
  assert.equal(lines.length, 4);
  assert.ok(!txt.includes('storefront  '), 'green items are folded, not listed');
});

test('folding line groups sites and counts scopes', () => {
  const fold = foldGreen(mixed.filter((x) => x.severity === 'ok'));
  assert.match(fold, /2 hosting sites 200 in ≤ 420ms/);
  assert.match(fold, /1 workloads ready/);
  assert.match(fold, /1 cronjobs on schedule/);
  assert.match(fold, /1 nodes Ready/);
});

test('--all lists green individually after the fold', () => {
  const txt = renderText(mixed, meta(), { all: true });
  assert.ok(txt.includes('✓ commerce/storefront'));
});

test('--brief: crit/warn only, hard cap 12 lines', () => {
  const many: Finding[] = [];
  for (let i = 0; i < 20; i++) many.push(f(`cron:ns/job-${String(i).padStart(2, '0')}`, 'cron', i < 5 ? 'crit' : 'warn', 'boom', { hint: 'look' }));
  const txt = renderText(many, meta(), { brief: true });
  const lines = txt.split('\n');
  assert.equal(lines.length, 12);
  assert.match(lines[11], /^… \+\d+ more, run pulse$/);
  assert.ok(!txt.includes('✓'));
});

test('--brief with nothing red prints nothing', () => {
  const txt = renderText(mixed.filter((x) => x.severity === 'ok'), meta(), { brief: true });
  assert.equal(txt, '');
});

test('--brief with zero findings allows the all-green one-liner', () => {
  const txt = renderText([], meta(), { brief: true });
  assert.match(txt, /all green/);
});

test('--tokens trims warn lines first, then crit hints — never a crit line', () => {
  const many: Finding[] = [];
  for (let i = 0; i < 8; i++) many.push(f(`k8s:ns/deploy-${i}`, 'k8s', 'crit', '0/1 ready', { hint: `kubectl -n ns get pods -l app=deploy-${i} and some long trailing advice ${i}` }));
  for (let i = 0; i < 8; i++) many.push(f(`cron:ns/job-${i}`, 'cron', 'warn', 'suspended', { hint: 'add override' }));
  const txt = renderText(many, meta(), { tokens: 100 }); // ≈400 chars — forces both stages
  const lines = txt.split('\n');
  assert.equal(lines.filter((l) => l.startsWith('✗')).length, 8, 'every crit line survives');
  assert.equal(lines.filter((l) => l.startsWith('⚠')).length, 0, 'warns trimmed');
  assert.ok(lines.some((l) => l.includes('trimmed (--tokens)')));
  assert.ok(!lines.some((l) => l.startsWith('✗') && l.includes('→')), 'crit hints stripped under pressure');
});

test('no config → pointer line', () => {
  const txt = renderText([], meta({ configPath: null, triedPath: '/home/x/.config/pulse/config.json' }));
  assert.match(txt, /no config — copy examples\/config\.json to \/home\/x\/\.config\/pulse\/config\.json/);
});

test('idish strips scope and scheme, caps length', () => {
  assert.equal(idish(f('cron:assistant/assistant-rss-sync', 'cron', 'ok', 't')), 'assistant/assistant-rss-sync');
  assert.equal(idish(f('site:https://storefront.example/', 'site', 'ok', 't')), 'storefront.example/');
  assert.equal(idish(f('k8s:ns/very-long-name-that-goes-on-and-on-and-on', 'k8s', 'ok', 't')).length, 34);
});

test('renderMd emits the table without ok rows; renderJson carries summary', () => {
  const md = renderMd(mixed, meta());
  assert.match(md, /\| crit \| k8s \| k8s:assistant\/assistant-mcp \| 0\/1 ready \|/);
  assert.ok(!md.includes('| ok |'));
  const j = JSON.parse(renderJson(mixed, meta()));
  assert.equal(j.summary.crit, 1);
  assert.equal(j.summary.warn, 1);
  assert.equal(j.findings[0].severity, 'crit');
});
