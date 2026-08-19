import { execFile } from 'node:child_process';
import type { Budgets, Finding, HostConfig } from '../types.js';
import { pool } from '../util.js';

export interface HostResult {
  stdout?: string;
  error?: string;
}
export type HostRunner = (host: HostConfig, budgets: Budgets) => Promise<HostResult>;

export const DEFAULT_CHECKS: string[] = ['df', 'uptime', 'docker'];
const ORDER = DEFAULT_CHECKS;
const WARN_PCT = 85;
const CRIT_PCT = 92;
const SKIP_MOUNT_RE = /^\/(dev|sys|proc|run|snap|boot\/efi)(\/|$)/;

export async function probeHosts(hosts: HostConfig[], budgets: Budgets, runner: HostRunner = realHostRunner): Promise<Finding[]> {
  const results = await pool(hosts, budgets.concurrency, (h) => runner(h, budgets));
  return hosts.flatMap((h, i) => evaluateHost(h, results[i]));
}

/** One round-trip ssh: `df -P`, `uptime`, `docker ps`, joined by `echo ---`. */
export const realHostRunner: HostRunner = (host, budgets) =>
  new Promise((resolve) => {
    const script = buildScript(host.checks ?? DEFAULT_CHECKS);
    execFile(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${budgets.sshTimeoutS}`, host.ssh, script],
      { timeout: (budgets.sshTimeoutS + 2) * 1000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const line = (stderr || err.message).split('\n')[0].trim() || 'ssh failed';
          resolve({ error: line });
          return;
        }
        resolve({ stdout });
      },
    );
  });

function buildScript(checks: string[]): string {
  const cmds: Record<string, string> = { df: 'df -P', uptime: 'uptime', docker: 'docker ps --format "{{json .}}" 2>/dev/null' };
  return ORDER.filter((c) => checks.includes(c))
    .map((c) => cmds[c])
    .join('; echo ---; ');
}

/** Severity rules for one host's raw ssh output — pure, fixture-testable. */
export function evaluateHost(host: HostConfig, r: HostResult): Finding[] {
  const checks = host.checks ?? DEFAULT_CHECKS;
  if (r.error) {
    return [{ id: `host:${host.name}`, scope: 'host', severity: 'warn', title: `unreachable — ${r.error}`, hint: `ssh -v ${host.ssh}` }];
  }

  const enabled = ORDER.filter((c) => checks.includes(c));
  const sections = (r.stdout ?? '').split(/\r?\n---\r?\n/);
  const byCheck = new Map(enabled.map((c, i) => [c, sections[i] ?? '']));
  const findings: Finding[] = [];

  findings.push({
    id: `host:${host.name}`,
    scope: 'host',
    severity: 'ok',
    title: byCheck.has('uptime') ? shortUptime(byCheck.get('uptime')!) : 'reachable',
  });

  if (byCheck.has('df')) {
    for (const d of parseDf(byCheck.get('df')!)) {
      if (SKIP_MOUNT_RE.test(d.mount)) continue;
      const id = `host:${host.name}:${d.mount}`;
      const hint = `ssh ${host.ssh} df -h ${d.mount}`;
      if (d.usedPct >= CRIT_PCT) findings.push({ id, scope: 'host', severity: 'crit', title: `${d.usedPct}% used`, hint });
      else if (d.usedPct >= WARN_PCT) findings.push({ id, scope: 'host', severity: 'warn', title: `${d.usedPct}% used`, hint });
      else findings.push({ id, scope: 'host', severity: 'ok', title: `${d.usedPct}% used` });
    }
  }

  if (byCheck.has('docker')) {
    for (const c of parseDocker(byCheck.get('docker')!)) {
      const state = (c.State ?? '').toLowerCase();
      const status = c.Status ?? '';
      if (state !== 'running' || /restarting|unhealthy/i.test(status)) {
        findings.push({
          id: `host:${host.name}/${c.Names}`,
          scope: 'host',
          severity: 'crit',
          title: `${c.State} — ${status}`,
          hint: `ssh ${host.ssh} docker logs ${c.Names} --tail 50`,
        });
      }
    }
  }

  return findings;
}

interface DfLine {
  mount: string;
  usedPct: number;
}

export function parseDf(section: string): DfLine[] {
  const lines = section.trim().split('\n').slice(1); // drop header
  const out: DfLine[] = [];
  for (const l of lines) {
    const cols = l.trim().split(/\s+/);
    if (cols.length < 6) continue;
    const usedPct = parseInt(cols[cols.length - 2], 10);
    const mount = cols[cols.length - 1];
    if (Number.isNaN(usedPct)) continue;
    out.push({ mount, usedPct });
  }
  return out;
}

interface DockerContainer {
  Names: string;
  State: string;
  Status: string;
}

export function parseDocker(section: string): DockerContainer[] {
  return section
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as DockerContainer;
      } catch {
        return undefined;
      }
    })
    .filter((c): c is DockerContainer => c !== undefined);
}

export function shortUptime(line: string): string {
  const upPart = /up\s+(.+?),\s*\d+\s+users?/.exec(line)?.[1]?.trim().replace(/\s+/g, ' ');
  const load = /load average:\s*([\d.]+)/.exec(line)?.[1];
  if (upPart && load) return `up ${upPart}, load ${load}`;
  return line.trim().slice(0, 60) || 'up';
}
