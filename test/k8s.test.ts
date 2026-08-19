import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureKubectl } from '../src/probe/kubectl.js';
import { probeK8s, tlsSecretFindings } from '../src/probe/k8s.js';
import { defaultK8sConfig, loadConfig } from '../src/config.js';
import { sortFindings } from '../src/findings.js';

const fixDir = (name: string): string => fileURLToPath(new URL(`../../test/fixtures/${name}`, import.meta.url));
const nowOf = (dir: string): number => Date.parse(JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')).now);

test('lab, empty overrides → 0 crit; warns only for 0/0 workloads and suspended cronjobs', async () => {
  const dir = fixDir('lab');
  const { findings, stats } = await probeK8s(fixtureKubectl(dir), defaultK8sConfig(), nowOf(dir));
  const crit = findings.filter((f) => f.severity === 'crit');
  const warn = findings.filter((f) => f.severity === 'warn');
  assert.deepEqual(crit, []);
  const workloadWarns = warn.filter((f) => f.scope === 'k8s').map((f) => f.id).sort();
  assert.deepEqual(workloadWarns, ['k8s:assistant/assistant-telegram', 'k8s:crawler/enrichment-worker']);
  // every remaining warn is a suspended cronjob (assistant-rentals-classify + 15 crawler/scrape-*)
  const cronWarns = warn.filter((f) => f.scope === 'cron');
  assert.equal(cronWarns.length, 16);
  assert.ok(cronWarns.every((f) => f.title === 'suspended'));
  assert.equal(warn.length, workloadWarns.length + cronWarns.length);
  assert.deepEqual(stats, { workloads: 13, cronjobs: 26, nodes: 3, nodesReady: 3, pvcs: 6 });
});

test('lab, real config (scaledToZeroOk + suspendedOk incl. ns wildcard) → all green', async () => {
  const dir = fixDir('lab');
  const cfg = loadConfig(join(dir, 'config.json'));
  const { findings } = await probeK8s(fixtureKubectl(dir), cfg.k8s!, nowOf(dir));
  assert.deepEqual(
    findings.filter((f) => f.severity !== 'ok'),
    [],
  );
});

test('broken → exactly the 6 seeded findings, all crit, hints actionable', async () => {
  const dir = fixDir('broken');
  const { findings } = await probeK8s(fixtureKubectl(dir), defaultK8sConfig(), nowOf(dir));
  assert.equal(findings.length, 6);
  assert.ok(findings.every((f) => f.severity === 'crit'));

  const byId = new Map(findings.map((f) => [f.id, f]));
  const expect = (id: string, title: string | RegExp, hint: RegExp): void => {
    const f = byId.get(id);
    assert.ok(f, `missing finding ${id} — got ${[...byId.keys()].join(', ')}`);
    if (typeof title === 'string') assert.equal(f.title, title);
    else assert.match(f.title, title);
    assert.match(f.hint ?? '', hint);
  };
  expect('k8s:assistant/assistant-mcp', '0/1 ready', /^kubectl -n assistant get pods -l app=assistant-mcp$/);
  expect('k8s:assistant/assistant-mcp-7f9b6c-x2n4', /^CrashLoopBackOff \(mcp, 7 restarts\)$/, /kubectl -n assistant logs .* --previous \| squirt/);
  expect('cron:assistant/assistant-rss-sync', 'last job Failed 8min ago', /kubectl -n assistant logs job\/assistant-rss-sync-29781590 \| squirt/);
  expect('cron:commerce/storefront-sync-tracking', 'no run for 6h (7 */2)', /kubectl -n commerce describe cronjob storefront-sync-tracking/);
  expect('node:node-c', 'NotReady', /kubectl describe node node-c/);
  expect('pvc:crawler/browser-state-pvc', 'Pending', /kubectl -n crawler describe pvc browser-state-pvc/);
});

test('kubectl unreachable → one deduped probe crit, never a crash', async () => {
  const { findings } = await probeK8s(
    async () => ({ error: 'The connection to the server 192.0.2.202:6443 was refused' }),
    defaultK8sConfig(),
    Date.now(),
  );
  assert.equal(findings.length, 1);
  const f = findings[0];
  assert.equal(f.id, 'probe:kubectl');
  assert.equal(f.scope, 'probe');
  assert.equal(f.severity, 'crit');
  assert.match(f.title, /kubectl unreachable: The connection/);
  assert.match(f.hint ?? '', /VPN|kubeconfig/);
  // probe findings sort first among crits
  assert.equal(sortFindings([{ id: 'k8s:a', scope: 'k8s', severity: 'crit', title: 't' }, f])[0].id, 'probe:kubectl');
});

test('single kind failing → scoped probe finding, other kinds still report', async () => {
  const dir = fixDir('broken');
  const inner = fixtureKubectl(dir);
  const { findings } = await probeK8s(
    async (kind) => (kind === 'pods' ? { error: 'etcdserver: request timed out' } : inner(kind)),
    defaultK8sConfig(),
    nowOf(dir),
  );
  const probe = findings.filter((f) => f.scope === 'probe');
  assert.equal(probe.length, 1);
  assert.equal(probe[0].id, 'probe:kubectl:pods');
  assert.equal(probe[0].detail, 'pods');
  // the other 5 seeded findings still present (pod one gone with its kind)
  assert.equal(findings.filter((f) => f.severity === 'crit').length, 6);
});

// --- inline items for the 1.4 warn paths (no fixture bloat) ------------------
const NOW = Date.parse('2026-08-17T12:00:00Z');
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const only = (kind: string, items: any[]) => async (k: string) => ({ items: k === kind ? items : [] });
const one = async (kind: string, items: any[], sev = 'warn') => {
  const { findings } = await probeK8s(only(kind, items) as any, defaultK8sConfig(), NOW);
  const hits = findings.filter((f) => f.severity === sev);
  assert.equal(hits.length, 1, JSON.stringify(findings));
  return hits[0];
};

test('pod Pending > 5 min → warn with describe hint', async () => {
  const f = await one('pods', [
    { metadata: { namespace: 'ns', name: 'p1', creationTimestamp: iso(6 * 60_000) }, status: { phase: 'Pending' } },
  ]);
  assert.equal(f.id, 'k8s:ns/p1');
  assert.match(f.title, /^Pending/);
  assert.match(f.hint ?? '', /describe pod p1/);
});

test('pod restartCount ≥ 5 within 1h → warn with --previous logs hint', async () => {
  const f = await one('pods', [
    {
      metadata: { namespace: 'ns', name: 'p2' },
      status: {
        phase: 'Running',
        containerStatuses: [{ name: 'app', restartCount: 5, state: { running: {} }, lastState: { terminated: { finishedAt: iso(10 * 60_000) } } }],
      },
    },
  ]);
  assert.equal(f.id, 'k8s:ns/p2');
  assert.match(f.title, /5 restarts/);
  assert.match(f.hint ?? '', /logs p2 -c app --previous/);
});

test('cronjob with active job running > 2× interval → warn "stuck?"', async () => {
  const items = {
    cronjobs: [{ metadata: { namespace: 'ns', name: 'cj' }, spec: { schedule: '*/10 * * * *' }, status: { lastScheduleTime: iso(15 * 60_000) } }], // Forbid: newer schedule skipped
    jobs: [
      {
        metadata: { namespace: 'ns', name: 'cj-1', ownerReferences: [{ kind: 'CronJob', name: 'cj' }] },
        status: { active: 1, startTime: iso(30 * 60_000) },
      },
    ],
  } as Record<string, any[]>;
  const { findings } = await probeK8s((async (k: string) => ({ items: items[k] ?? [] })) as any, defaultK8sConfig(), NOW);
  const f = findings.find((x) => x.id === 'cron:ns/cj')!;
  assert.equal(f.severity, 'warn');
  assert.match(f.title, /stuck\?/);
  assert.match(f.hint ?? '', /logs job\/cj-1/);
});

// --- tls secrets (Phase 3, opt-in via k8s.tlsSecrets) ------------------------

test('tlsSecrets: false (default) → loader never asked for secrets', async () => {
  const dir = fixDir('lab');
  const inner = fixtureKubectl(dir);
  const requested: string[] = [];
  const spy = (async (kind: string) => {
    requested.push(kind);
    return inner(kind as any);
  }) as any;
  await probeK8s(spy, defaultK8sConfig(), nowOf(dir));
  assert.ok(!requested.includes('secrets'), `secrets requested: ${requested.join(', ')}`);
});

test('tlsSecrets: true, lab fixture → no tls: finding below ok (real cluster: only TLS secret is kube-system/k3s-serving, filtered by default ignoreNamespaces)', async () => {
  const dir = fixDir('lab');
  const cfg = { ...defaultK8sConfig(), tlsSecrets: true };
  const { findings } = await probeK8s(fixtureKubectl(dir), cfg, nowOf(dir));
  const tls = findings.filter((f) => f.scope === 'tls');
  assert.ok(
    tls.every((f) => f.severity === 'ok'),
    JSON.stringify(tls),
  );
});

test('tlsSecretFindings: real recorded cert (k3s-serving, valid ~1y) → one ok finding', () => {
  const dir = fixDir('lab');
  const raw = JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8'));
  const findings = tlsSecretFindings(raw.items, nowOf(dir), 14);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, 'tls:kube-system/k3s-serving');
  assert.equal(findings[0].severity, 'ok');
  assert.match(findings[0].title, /^expires in .+ \(cn=k3s\)$/);
  assert.match(findings[0].hint ?? '', /^kubectl -n kube-system get secret k3s-serving -o yaml$/);
});

// Self-signed cert (CN=storefront.home.arpa, notAfter 2027-09-22) generated once with
// `openssl req -x509 -newkey rsa:2048 -nodes -days 400 -subj /CN=storefront.home.arpa
// -keyout /tmp/k.key -out /tmp/k.crt` — only the public cert is embedded, the key was
// discarded. Paired with a fixed `now` 7 days before its notAfter to exercise the warn
// band (< tlsDaysMin, >= 3) deterministically, with no wall-clock dependency.
const WARN_CERT_B64 =
  'LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSURIekNDQWdlZ0F3SUJBZ0lVUENXc2d2b0czTGJjSjRYVlpDREhMZDBYeUZvd0RRWUpLb1pJaHZjTkFRRUwKQlFBd0h6RWRNQnNHQTFVRUF3d1VjM1J2Y21WbWNtOXVkQzVvYjIxbExtRnljR0V3SGhjTk1qWXdPREU0TURBMApORFEzV2hjTk1qY3dPVEl5TURBME5EUTNXakFmTVIwd0d3WURWUVFEREJSemRHOXlaV1p5YjI1MExtaHZiV1V1CllYSndZVENDQVNJd0RRWUpLb1pJaHZjTkFRRUJCUUFEZ2dFUEFEQ0NBUW9DZ2dFQkFMMm1tcUNEbDd2VjJlbHYKM1V2R1VzaENFWVBLTDJxdVMyNFZWQ0lNdVkxV0xIYllwdVY5ZklEZVQvdmFtejNkdDlDbW90UzdYd3ZoYm5MTQppYU5LeEh2d3dtWUdWRnFHRFpqTnBEaCtLSExHM0NWeE5RN2Y2ZXB6eUZsUFdETWtaV0FwZkgybFU4cldzR3plCkRhd1JrOUMrb0FBWC95bGU0WXlKNFlBaWt4UTIwQkREcGIydy9SclloTkJ1UFJ5UFNLNTVFV1FXT0o3anIvcjAKVlZFWm9lNUp0cGRNc3gyM1JmalBCMGNaZDhCTFVFYitnTkt6NDlYbG1UU1RXQitUWStIK0pjcE9VZC94dUNiTApIZTR2UGpmQk1NRkk0YUg5b3QvbjRaV2Q4bnFZRG1Rb3BWYmx3L0UwdkhCdkhTU00rZnovM1BycGtJTTlCSU5YCjRmWkFHZjhDQXdFQUFhTlRNRkV3SFFZRFZSME9CQllFRkpDUjJWT0pMMWxQQWRndk9YQ3dCUUE3UVlQZU1COEcKQTFVZEl3UVlNQmFBRkpDUjJWT0pMMWxQQWRndk9YQ3dCUUE3UVlQZU1BOEdBMVVkRXdFQi93UUZNQU1CQWY4dwpEUVlKS29aSWh2Y05BUUVMQlFBRGdnRUJBR05iRkg2ZTBTS1Vvb2lxUHkzekt1blMxRnlvbEF3M3FaSkQ3aDhaCitMR2Y0VDlJKzBqZEpLYjlsVjFkVnNmSGJMSDhNb1pzZ2Z2NzZMRStrZlFaRDd4cWdMWG1adEVZUUp5d0NMT0UKQ1Zodi85d01kQzVrdGg5aGJyT0tabTVBV241alZPVmIvSkpGaHhYVnhrWjY5ZHBFU0Jxdk1LdFkzZFp4cGkyLwpaZFhGNnZucU0xdk1RMkhVMHZWZHpScU5PcWQ1QTF1WjJBV1J4K3pyVkppMTZnTFA2VnRiODY3ZU4wTmsxdnZpClJxNkxBb3VrNXBTVFFkRXAwK09SQ1ZUemNpNWxvM2U0RHEybVpHc3N2QjFRbVNjUExhaEhQd3J0bHNvN2dBdDIKKzZvOGJ6SnUvM3NNRHVpZEtHSGZKT1MvNHQvZEt6RkgvcTNIcjVOK0xxWjlLN009Ci0tLS0tRU5EIENFUlRJRklDQVRFLS0tLS0K';

test('tlsSecretFindings: 7d left, tlsDaysMin 14 → warn (mid-band, expired/ok covered by broken/lab fixtures)', () => {
  const now = Date.parse('2027-09-15T00:44:47.000Z'); // exactly 7d before the cert's notAfter
  const findings = tlsSecretFindings(
    [{ metadata: { namespace: 'commerce', name: 'storefront-tls' }, data: { 'tls.crt': WARN_CERT_B64 } }],
    now,
    14,
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, 'tls:commerce/storefront-tls');
  assert.equal(findings[0].severity, 'warn');
  assert.match(findings[0].title, /^expires in 7d \(cn=storefront\.home\.arpa\)$/);
});

test('tlsSecrets: true, broken fixture → one crit tls: finding, near-expired synthetic cert', async () => {
  const dir = fixDir('broken');
  const cfg = { ...defaultK8sConfig(), tlsSecrets: true };
  const { findings } = await probeK8s(fixtureKubectl(dir), cfg, nowOf(dir));
  const tls = findings.filter((f) => f.scope === 'tls');
  assert.equal(tls.length, 1);
  const f = tls[0];
  assert.equal(f.id, 'tls:monitoring/grafana-tls');
  assert.equal(f.severity, 'crit');
  assert.match(f.title, /^expires in .+ \(cn=grafana\.home\.arpa\)$/);
  assert.match(f.hint ?? '', /^kubectl -n monitoring get secret grafana-tls -o yaml$/);
});

test('node Ready but *Pressure=True → warn naming the condition', async () => {
  const f = await one('nodes', [
    {
      metadata: { name: 'n1' },
      status: {
        conditions: [
          { type: 'Ready', status: 'True' },
          { type: 'DiskPressure', status: 'True' },
          { type: 'MemoryPressure', status: 'False' },
        ],
      },
    },
  ]);
  assert.equal(f.id, 'node:n1');
  assert.equal(f.title, 'DiskPressure');
  assert.match(f.hint ?? '', /describe node n1/);
});
