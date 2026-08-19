import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluateSite, probeSites } from '../src/probe/sites.js';
import { DEFAULT_BUDGETS } from '../src/config.js';
import type { SiteConfig, SiteResult } from '../src/types.js';

const fixtures: SiteResult[] = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../test/fixtures/sites.json', import.meta.url)), 'utf8'),
);
const resultOf = (url: string): SiteResult => {
  const r = fixtures.find((f) => f.url === url);
  assert.ok(r, `no fixture for ${url}`);
  return r;
};

const site = (url: string, extra: Partial<SiteConfig> = {}): SiteConfig => ({
  url,
  expect: { status: [200], tlsDaysMin: 14, ...(extra.expect ?? {}) },
  ...extra,
});

test('healthy site → single ok finding with status/latency for folding', () => {
  const f = evaluateSite(site('https://ok.example/', { group: 'hosting' }), resultOf('https://ok.example/'));
  assert.equal(f.length, 1);
  assert.deepEqual(f[0], {
    id: 'site:https://ok.example/',
    scope: 'site',
    severity: 'ok',
    title: '200 in 320ms',
    group: 'hosting',
    status: 200,
    latencyMs: 320,
  });
});

test('expect.status as list: 401 accepted', () => {
  const f = evaluateSite(site('https://auth.example/', { expect: { status: [200, 401], tlsDaysMin: 14 } }), resultOf('https://auth.example/'));
  assert.equal(f[0].severity, 'ok');
});

test('status mismatch → crit with curl + peep hint', () => {
  const f = evaluateSite(site('https://mismatch.example/'), resultOf('https://mismatch.example/'));
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'crit');
  assert.equal(f[0].title, '503 in 1200ms');
  assert.match(f[0].hint!, /curl -sI https:\/\/mismatch\.example\//);
  assert.match(f[0].hint!, /peep check mismatch\.example/);
});

test('slow site → warn', () => {
  const f = evaluateSite(site('https://slow.example/'), resultOf('https://slow.example/'));
  assert.equal(f[0].severity, 'warn');
  assert.equal(f[0].title, 'slow 3.4s');
});

test('TLS 12d with min 14 → warn, site itself ok', () => {
  const f = evaluateSite(site('https://tls-warn.example/'), resultOf('https://tls-warn.example/'));
  assert.equal(f.length, 2);
  assert.equal(f[0].severity, 'ok');
  assert.equal(f[1].id, 'site:https://tls-warn.example/:tls');
  assert.equal(f[1].severity, 'warn');
  assert.equal(f[1].title, 'TLS 12d left (min 14)');
});

test('TLS 2d → crit; expired → crit', () => {
  const crit = evaluateSite(site('https://tls-crit.example/'), resultOf('https://tls-crit.example/'));
  assert.equal(crit[1].severity, 'crit');
  assert.equal(crit[1].title, 'TLS 2d left');
  const exp = evaluateSite(site('https://expired.example/'), resultOf('https://expired.example/'));
  assert.equal(exp[1].severity, 'crit');
  assert.equal(exp[1].title, 'TLS expired 6d ago');
});

test('lan site unreachable → warn, not crit', () => {
  const f = evaluateSite(site('https://lan.example/', { lan: true }), resultOf('https://lan.example/'));
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'warn');
  assert.match(f[0].title, /^unreachable \(LAN\)/);
});

test('non-lan unreachable → crit with error code', () => {
  const f = evaluateSite(site('https://down.example/'), resultOf('https://down.example/'));
  assert.equal(f[0].severity, 'crit');
  assert.equal(f[0].title, 'unreachable (ENOTFOUND)');
});

test('missing contains marker → crit', () => {
  const f = evaluateSite(
    site('https://marker.example/', { expect: { status: [200], tlsDaysMin: 14, contains: 'Storefront' } }),
    resultOf('https://marker.example/'),
  );
  assert.equal(f[0].severity, 'crit');
  assert.equal(f[0].title, 'marker "Storefront" not found');
});

test('probeSites runs every site through the injected prober, no network', async () => {
  const sites = fixtures.map((r) => {
    if (r.url.includes('auth')) return site(r.url, { expect: { status: [200, 401], tlsDaysMin: 14 } });
    if (r.url.includes('lan')) return site(r.url, { lan: true });
    if (r.url.includes('marker')) return site(r.url, { expect: { status: [200], tlsDaysMin: 14, contains: 'Storefront' } });
    return site(r.url);
  });
  const findings = await probeSites(sites, DEFAULT_BUDGETS, async (s) => resultOf(s.url));
  // one finding per site + one extra tls finding for tls-warn/tls-crit/expired
  assert.equal(findings.length, fixtures.length + 3);
  assert.equal(findings.filter((f) => f.severity === 'crit').length, 5); // mismatch, down, marker, tls-crit, expired
});
