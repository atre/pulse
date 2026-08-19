import { connect } from 'node:tls';
import type { Budgets, Finding, SiteConfig, SiteResult } from '../types.js';
import { pkgVersion, pool } from '../util.js';

export type SiteProber = (site: SiteConfig, budgets: Budgets) => Promise<SiteResult>;

const SLOW_MS = 3000;
const DAY = 86_400_000;

/** Probe all sites (concurrency-capped) and turn results into findings. */
export async function probeSites(
  sites: SiteConfig[],
  budgets: Budgets,
  prober: SiteProber = realSiteProber,
): Promise<Finding[]> {
  const results = await pool(sites, budgets.concurrency, (s) => prober(s, budgets));
  return sites.flatMap((site, i) => evaluateSite(site, results[i]));
}

/** Severity rules for one site result — pure, fixture-testable. */
export function evaluateSite(site: SiteConfig, r: SiteResult): Finding[] {
  const id = `site:${site.url}`;
  const host = hostOf(site.url);
  const findings: Finding[] = [];

  if (r.error) {
    findings.push(
      site.lan
        ? { id, scope: 'site', severity: 'warn', title: `unreachable (LAN) — ${r.error}`, group: site.group, hint: `expected off-network; on LAN check: curl -sI ${site.url}` }
        : { id, scope: 'site', severity: 'crit', title: `unreachable (${r.error})`, group: site.group, hint: `curl -sI ${site.url} · peep check ${host}` },
    );
    return findings; // no status/TLS data worth judging
  }

  const ms = r.latencyMs ?? 0;
  if (r.status !== undefined && !site.expect.status.includes(r.status)) {
    findings.push({
      id,
      scope: 'site',
      severity: 'crit',
      title: `${r.status} in ${ms}ms${r.finalUrl && r.finalUrl !== site.url ? ` (→ ${r.finalUrl})` : ''}`,
      group: site.group,
      hint: `curl -sI ${site.url} · peep check ${host}`,
    });
  } else if (site.expect.contains && r.containsFound === false) {
    findings.push({
      id,
      scope: 'site',
      severity: 'crit',
      title: `marker "${site.expect.contains}" not found`,
      group: site.group,
      hint: `curl -s ${site.url} | grep -i ${JSON.stringify(site.expect.contains)}`,
    });
  } else if (ms > SLOW_MS) {
    findings.push({
      id,
      scope: 'site',
      severity: 'warn',
      title: `slow ${(ms / 1000).toFixed(1)}s`,
      group: site.group,
      status: r.status,
      latencyMs: ms,
      hint: `curl -w '%{time_total}' -o /dev/null -s ${site.url}`,
    });
  } else {
    findings.push({ id, scope: 'site', severity: 'ok', title: `${r.status} in ${ms}ms`, group: site.group, status: r.status, latencyMs: ms });
  }

  if (r.tlsDaysLeft !== undefined) {
    const d = Math.floor(r.tlsDaysLeft);
    const tlsId = `${id}:tls`;
    const hint = `renew the cert — echo | openssl s_client -connect ${host}:443 2>/dev/null | openssl x509 -noout -dates`;
    if (d < 0) findings.push({ id: tlsId, scope: 'site', severity: 'crit', title: `TLS expired ${-d}d ago`, group: site.group, hint });
    else if (d < 3) findings.push({ id: tlsId, scope: 'site', severity: 'crit', title: `TLS ${d}d left`, group: site.group, hint });
    else if (d < site.expect.tlsDaysMin)
      findings.push({ id: tlsId, scope: 'site', severity: 'warn', title: `TLS ${d}d left (min ${site.expect.tlsDaysMin})`, group: site.group, hint });
  }

  return findings;
}

/** Real prober: fetch with manual redirects (≤ 3) + TLS expiry via node:tls. */
export const realSiteProber: SiteProber = async (site, budgets) => {
  const out: SiteResult = { url: site.url };
  const start = Date.now();
  try {
    let url = site.url;
    let redirects = 0;
    for (;;) {
      const res = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(budgets.siteTimeoutMs),
        headers: { 'user-agent': `pulse/${pkgVersion()}` },
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location') && redirects < 3) {
        redirects++;
        url = new URL(res.headers.get('location')!, url).href;
        await res.body?.cancel();
        continue;
      }
      out.status = res.status;
      out.redirects = redirects;
      out.finalUrl = url;
      if (site.expect.contains) {
        const body = await res.text();
        out.containsFound = body.includes(site.expect.contains);
      } else {
        await res.body?.cancel();
      }
      break;
    }
  } catch (e) {
    out.error = errCode(e);
  }
  out.latencyMs = Date.now() - start;

  if (site.url.startsWith('https://') && !out.error) {
    out.tlsDaysLeft = await tlsDaysLeft(hostOf(site.url), budgets.siteTimeoutMs);
  }
  return out;
};

function tlsDaysLeft(host: string, timeoutMs: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    const sock = connect({ port: 443, host, servername: host, timeout: timeoutMs }, () => {
      const cert = sock.getPeerCertificate();
      sock.end();
      const validTo = cert?.valid_to ? Date.parse(cert.valid_to) : NaN;
      resolve(Number.isNaN(validTo) ? undefined : (validTo - Date.now()) / DAY);
    });
    sock.on('error', () => resolve(undefined));
    sock.on('timeout', () => {
      sock.destroy();
      resolve(undefined);
    });
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function errCode(e: unknown): string {
  const err = e as { name?: string; code?: string; cause?: { code?: string }; message?: string };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'timeout';
  return err?.cause?.code ?? err?.code ?? err?.message ?? 'fetch failed';
}
