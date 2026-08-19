import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applySince, diffFindings, readSnap, writeSnap } from '../src/snap.js';
import type { Finding } from '../src/types.js';

const tmpBase = (): string => mkdtempSync(join(tmpdir(), 'pulse-snap-'));

const f = (id: string, severity: Finding['severity'], title = 'x'): Finding => ({ id, scope: 'k8s', severity, title });

test('writeSnap + readSnap round-trip', () => {
  const base = tmpBase();
  writeSnap('last', [f('a', 'ok')], 1000, base);
  const snap = readSnap('last', base);
  assert.equal(snap!.ts, 1000);
  assert.deepEqual(snap!.findings, [f('a', 'ok')]);
  rmSync(base, { recursive: true, force: true });
});

test('readSnap: missing file → undefined', () => {
  const base = tmpBase();
  assert.equal(readSnap('nope', base), undefined);
  rmSync(base, { recursive: true, force: true });
});

test('diffFindings: new non-ok finding → added; new ok finding → not added', () => {
  const prev: Finding[] = [f('a', 'ok')];
  const curr: Finding[] = [f('a', 'ok'), f('b', 'crit'), f('c', 'ok')];
  const d = diffFindings(prev, curr);
  assert.deepEqual(d.added.map((x) => x.id), ['b']);
  assert.equal(d.unchanged, 1);
});

test('diffFindings: ok → warn is `changed`; crit → ok is `resolved`, not double-counted as changed', () => {
  const prev: Finding[] = [f('a', 'ok'), f('b', 'crit')];
  const curr: Finding[] = [f('a', 'warn'), f('b', 'ok')];
  const d = diffFindings(prev, curr);
  assert.deepEqual(d.changed, [{ id: 'a', title: 'x', from: 'ok', to: 'warn' }]);
  assert.deepEqual(d.resolved, [f('b', 'ok')]);
});

test('diffFindings: id gone from curr entirely (was crit) → resolved', () => {
  const prev: Finding[] = [f('a', 'crit')];
  const curr: Finding[] = [];
  const d = diffFindings(prev, curr);
  assert.deepEqual(d.resolved, [f('a', 'crit')]);
});

test('applySince: first sighting sets since = now; second run keeps original since', () => {
  const base = tmpBase();
  const first = applySince([f('a', 'crit')], 5000, base);
  assert.equal(first[0].since, 5000);

  const second = applySince([f('a', 'crit')], 9000, base);
  assert.equal(second[0].since, 5000);
  rmSync(base, { recursive: true, force: true });
});

test('applySince: ok findings are never given a since, and drop out of state once resolved', () => {
  const base = tmpBase();
  applySince([f('a', 'crit')], 1000, base);
  const resolved = applySince([f('a', 'ok')], 2000, base);
  assert.equal(resolved[0].since, undefined);
  // id no longer tracked — if it goes crit again later it's treated as newly seen
  const reoccurred = applySince([f('a', 'crit')], 3000, base);
  assert.equal(reoccurred[0].since, 3000);
  rmSync(base, { recursive: true, force: true });
});

test('fixture-mode CLI run writes <PULSE_HOME>/snaps/last.json with findings', async () => {
  const { main } = await import('../src/cli.js');
  const base = tmpBase();
  const prev = process.env.PULSE_HOME;
  const log = console.log;
  console.log = () => {};
  process.env.PULSE_HOME = base;
  try {
    const fixtures = fileURLToPath(new URL('../../test/fixtures/broken', import.meta.url));
    const code = await main(['--fixtures', fixtures]);
    assert.equal(code, 1);
    const snap = readSnap('last', base);
    assert.ok(snap && snap.findings.some((f) => f.id.startsWith('k8s:')), 'last.json has k8s findings');
    assert.equal(existsSync(join(base, 'state.json')), false, 'fixture runs never touch state.json');
  } finally {
    console.log = log;
    if (prev === undefined) delete process.env.PULSE_HOME;
    else process.env.PULSE_HOME = prev;
    rmSync(base, { recursive: true, force: true });
  }
});
