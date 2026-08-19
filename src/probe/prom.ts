import { execFile } from 'node:child_process';
import { connect, createServer } from 'node:net';
import type { Budgets, DiskConfig, Finding, PromConfig } from '../types.js';

export interface PromSample {
  metric: Record<string, string>;
  value: number;
}
export type PromQuerier = (expr: string) => Promise<PromSample[]>;

const DEFAULT_WARN_PCT = 85;
const DEFAULT_CRIT_PCT = 92;
const SKIP_LABEL_RE = /node.?exporter/i;

/** Real probe: resolve a reachable Prometheus URL, query, always tear down port-forward. */
export async function probeProm(cfg: PromConfig, budgets: Budgets): Promise<Finding[]> {
  if (!cfg.disks.length) return [];
  const resolved = await resolvePromUrl(cfg);
  if ('error' in resolved) {
    return [
      {
        id: 'probe:prometheus',
        scope: 'probe',
        severity: 'warn',
        title: `prometheus unreachable — ${resolved.error}`,
        hint: 'check prometheus.url / portForward in config',
      },
    ];
  }
  try {
    return await evaluateDisks(cfg.disks, cfg.warnPctDefault, httpQuerier(resolved.url, budgets.siteTimeoutMs));
  } catch (e) {
    return [
      {
        id: 'probe:prometheus',
        scope: 'probe',
        severity: 'warn',
        title: `prometheus query failed — ${(e as Error).message}`,
        hint: 'check prometheus.url / portForward in config',
      },
    ];
  } finally {
    resolved.cleanup();
  }
}

/** Severity rules for resolved disk usage + node-exporter targets — pure, fixture-testable. */
export async function evaluateDisks(disks: DiskConfig[], warnPctDefault: number | undefined, query: PromQuerier): Promise<Finding[]> {
  if (!disks.length) return [];
  const [avail, size, up] = await Promise.all([
    query('node_filesystem_avail_bytes'),
    query('node_filesystem_size_bytes'),
    query('up'),
  ]);
  const findings: Finding[] = [];

  for (const d of disks) {
    const id = `disk:${d.instance}:${d.mount}`;
    const a = findSample(avail, d);
    const s = findSample(size, d);
    if (!a || !s || s.value <= 0) {
      findings.push({
        id,
        scope: 'disk',
        severity: 'warn',
        title: 'no data from prometheus',
        hint: `check node_filesystem_*_bytes{mountpoint="${d.mount}"} on ${d.instance}`,
      });
      continue;
    }
    const usedPct = Math.round(((s.value - a.value) / s.value) * 100);
    const warnPct = d.warnPct ?? warnPctDefault ?? DEFAULT_WARN_PCT;
    const critPct = d.critPct ?? DEFAULT_CRIT_PCT;
    const hint = `ssh ${d.instance} df -h ${d.mount}`;
    if (usedPct >= critPct) findings.push({ id, scope: 'disk', severity: 'crit', title: `${usedPct}% used (crit ${critPct}%)`, hint });
    else if (usedPct >= warnPct) findings.push({ id, scope: 'disk', severity: 'warn', title: `${usedPct}% used (warn ${warnPct}%)`, hint });
    else findings.push({ id, scope: 'disk', severity: 'ok', title: `${usedPct}% used` });
  }

  const downInstances = new Set(
    up
      .filter((s) => s.value === 0 && SKIP_LABEL_RE.test(s.metric.job ?? ''))
      .map((s) => s.metric.node ?? s.metric.nodename ?? s.metric.instance ?? 'unknown'),
  );
  for (const inst of downInstances) {
    findings.push({
      id: `disk:${inst}:node-exporter`,
      scope: 'disk',
      severity: 'warn',
      title: 'node-exporter target down',
      hint: 'kubectl -n monitoring get pods -l app.kubernetes.io/name=prometheus-node-exporter',
    });
  }
  return findings;
}

function findSample(samples: PromSample[], d: DiskConfig): PromSample | undefined {
  return samples.find((s) => s.metric.mountpoint === d.mount && instanceMatches(s.metric, d.instance));
}

/** node-exporter's `instance` label is usually `<ip>:9100` — the k8s node name lives in `node` or `nodename` instead. */
function instanceMatches(metric: Record<string, string>, instance: string): boolean {
  const needle = instance.toLowerCase();
  return [metric.instance, metric.node, metric.nodename].some((label) => label?.toLowerCase().includes(needle));
}

/** Parse a raw `/api/v1/query` response body into samples. */
export function parsePromResponse(json: any): PromSample[] {
  if (json?.status !== 'success') return [];
  const result = json.data?.result ?? [];
  return result.map((r: any) => ({ metric: r.metric ?? {}, value: Number(r.value?.[1]) }));
}

function httpQuerier(url: string, timeoutMs: number): PromQuerier {
  return async (expr) => {
    const res = await fetch(`${url}/api/v1/query?query=${encodeURIComponent(expr)}`, { signal: AbortSignal.timeout(timeoutMs) });
    return parsePromResponse(await res.json());
  };
}

/** `prometheus.url` if reachable within 2s, else spawn `kubectl port-forward` on an ephemeral port. */
export async function resolvePromUrl(cfg: PromConfig): Promise<{ url: string; cleanup: () => void } | { error: string }> {
  if (cfg.url) {
    try {
      await fetch(cfg.url, { signal: AbortSignal.timeout(2000) });
      return { url: cfg.url, cleanup: () => {} };
    } catch {
      // fall through to port-forward
    }
  }
  if (cfg.portForward) {
    const m = /^([^/]+)\/(.+):(\d+)$/.exec(cfg.portForward);
    if (!m) return { error: `bad portForward "${cfg.portForward}" — expected <ns>/<target>:<port>` };
    const [, ns, target, port] = m;
    let localPort: number;
    try {
      localPort = await findFreePort();
    } catch (e) {
      return { error: `could not allocate a local port: ${(e as Error).message}` };
    }
    const child = execFile('kubectl', ['-n', ns, 'port-forward', target, `${localPort}:${port}`]);
    const cleanup = (): void => {
      child.kill();
    };
    const up = await waitForPort(localPort, 3000);
    if (!up) {
      cleanup();
      return { error: `kubectl port-forward -n ${ns} ${target} ${localPort}:${port} did not come up` };
    }
    return { url: `http://127.0.0.1:${localPort}`, cleanup };
  }
  return { error: cfg.url ? `${cfg.url} unreachable and no portForward configured` : 'no prometheus.url or portForward configured' };
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = (): void => {
      const sock = connect(port, '127.0.0.1');
      sock.once('connect', () => {
        sock.end();
        resolve(true);
      });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}
