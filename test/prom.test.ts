import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluateDisks, parsePromResponse, type PromSample } from '../src/probe/prom.js';
import type { DiskConfig } from '../src/types.js';

const raw: Record<string, any> = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../test/fixtures/prom.json', import.meta.url)), 'utf8'),
);
const query = async (expr: string): Promise<PromSample[]> => parsePromResponse(raw[expr]);

const disk = (instance: string, extra: Partial<DiskConfig> = {}): DiskConfig => ({
  instance,
  mount: '/mnt/ssd',
  warnPct: 85,
  critPct: 92,
  ...extra,
});

test('parsePromResponse: success vector → samples with numeric values', () => {
  const samples = parsePromResponse(raw.node_filesystem_avail_bytes);
  assert.equal(samples.length, 3);
  assert.equal(samples[0].metric.node, 'node-a');
  assert.equal(samples[0].value, 600000000);
});

test('parsePromResponse: non-success status → empty', () => {
  assert.deepEqual(parsePromResponse({ status: 'error', error: 'bad query' }), []);
});

test('node-a matches via the "node" label (real node-exporter has no name in "instance") → 40% used, ok', async () => {
  const findings = await evaluateDisks([disk('node-a')], undefined, query);
  assert.equal(findings.length, 2);
  assert.equal(findings[0].id, 'disk:node-a:/mnt/ssd');
  assert.equal(findings[0].severity, 'ok');
  assert.equal(findings[0].title, '40% used');
});

test('node-b 88% used, warnPct 85 → warn', async () => {
  const findings = await evaluateDisks([disk('node-b')], undefined, query);
  assert.equal(findings[0].severity, 'warn');
  assert.equal(findings[0].title, '88% used (warn 85%)');
  assert.match(findings[0].hint!, /ssh node-b df -h \/mnt\/ssd/);
});

test('node-c 95% used, critPct 92 → crit; node-exporter down on node-c → warn', async () => {
  const findings = await evaluateDisks([disk('node-c')], undefined, query);
  const disks = findings.filter((f) => f.id === 'disk:node-c:/mnt/ssd');
  assert.equal(disks[0].severity, 'crit');
  assert.equal(disks[0].title, '95% used (crit 92%)');
  const exporterDown = findings.find((f) => f.id === 'disk:node-c:node-exporter');
  assert.ok(exporterDown);
  assert.equal(exporterDown!.severity, 'warn');
});

test('no data for an instance/mount → warn, not crit', async () => {
  const findings = await evaluateDisks([disk('ghost')], undefined, query);
  const ghost = findings.find((f) => f.id === 'disk:ghost:/mnt/ssd');
  assert.equal(ghost!.severity, 'warn');
  assert.equal(ghost!.title, 'no data from prometheus');
});

test('warnPctDefault used when disk.warnPct unset', async () => {
  const findings = await evaluateDisks([{ instance: 'node-b', mount: '/mnt/ssd' }], 80, query);
  assert.equal(findings[0].severity, 'warn');
  assert.equal(findings[0].title, '88% used (warn 80%)');
});

test('no disks configured → no query calls, empty result', async () => {
  let called = false;
  const findings = await evaluateDisks([], undefined, async (expr) => {
    called = true;
    return query(expr);
  });
  assert.deepEqual(findings, []);
  assert.equal(called, false);
});
