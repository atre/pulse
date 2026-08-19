import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Budgets, Config, K8sConfig, SiteConfig } from './types.js';

export const DEFAULT_BUDGETS: Budgets = { siteTimeoutMs: 8000, kubectlTimeoutS: 8, sshTimeoutS: 8, concurrency: 8 };
const DEFAULT_IGNORE_NS = ['kube-system', 'kube-public', 'kube-node-lease'];
export const DEFAULT_TLS_DAYS_MIN = 14;

export function defaultConfigPath(): string {
  return process.env.PULSE_CONFIG || join(homedir(), '.config', 'pulse', 'config.json');
}

/** Default k8s section — used when --fixtures is given without any config. */
export function defaultK8sConfig(): K8sConfig {
  return {
    ignoreNamespaces: [...DEFAULT_IGNORE_NS],
    scaledToZeroOk: [],
    cronjobs: { maxMissedRuns: 2, override: {} },
    tlsSecrets: false,
    tlsDaysMin: DEFAULT_TLS_DAYS_MIN,
  };
}

/**
 * Missing file → empty config with defaults (every probe skipped; the digest
 * points at examples/config.json). Bad JSON → throws with the path in the message.
 * Unknown keys and `$comment` are ignored.
 */
export function loadConfig(path?: string): Config {
  const p = path ?? defaultConfigPath();
  let raw: string;
  try {
    raw = readFileSync(p, 'utf8');
  } catch {
    return { path: null, triedPath: p, sites: [], hosts: [], budgets: { ...DEFAULT_BUDGETS } };
  }
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`config ${p}: invalid JSON — ${(e as Error).message}`);
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new Error(`config ${p}: expected a JSON object`);
  return normalize(json, p);
}

function normalize(json: any, p: string): Config {
  const cfg: Config = {
    path: p,
    sites: [],
    hosts: [],
    budgets: { ...DEFAULT_BUDGETS, ...pickNumbers(json.budgets, Object.keys(DEFAULT_BUDGETS)) },
  };

  if (json.k8s && typeof json.k8s === 'object') {
    const k = json.k8s;
    cfg.k8s = {
      context: typeof k.context === 'string' ? k.context : undefined,
      ignoreNamespaces: strArray(k.ignoreNamespaces) ?? [...DEFAULT_IGNORE_NS],
      scaledToZeroOk: strArray(k.scaledToZeroOk) ?? [],
      cronjobs: {
        maxMissedRuns: typeof k.cronjobs?.maxMissedRuns === 'number' ? k.cronjobs.maxMissedRuns : 2,
        override: dropComments(k.cronjobs?.override),
      },
      tlsSecrets: k.tlsSecrets === true,
      tlsDaysMin: typeof k.tlsDaysMin === 'number' ? k.tlsDaysMin : DEFAULT_TLS_DAYS_MIN,
    };
  }

  if (Array.isArray(json.sites)) {
    cfg.sites = json.sites.map((s: any, i: number): SiteConfig => {
      if (!s || typeof s.url !== 'string') throw new Error(`config ${p}: sites[${i}].url missing`);
      const e = s.expect ?? {};
      return {
        url: s.url,
        expect: {
          status: Array.isArray(e.status) ? e.status : typeof e.status === 'number' ? [e.status] : [200],
          tlsDaysMin: typeof e.tlsDaysMin === 'number' ? e.tlsDaysMin : DEFAULT_TLS_DAYS_MIN,
          contains: typeof e.contains === 'string' ? e.contains : undefined,
        },
        lan: s.lan === true,
        group: typeof s.group === 'string' ? s.group : undefined,
      };
    });
  }

  if (json.prometheus && typeof json.prometheus === 'object') {
    const pr = json.prometheus;
    cfg.prometheus = {
      url: typeof pr.url === 'string' ? pr.url : undefined,
      portForward: typeof pr.portForward === 'string' ? pr.portForward : undefined,
      disks: Array.isArray(pr.disks) ? pr.disks : [],
      warnPctDefault: typeof pr.warnPctDefault === 'number' ? pr.warnPctDefault : undefined,
    };
  }

  if (Array.isArray(json.hosts)) {
    cfg.hosts = json.hosts.filter((h: any) => h && typeof h.name === 'string' && typeof h.ssh === 'string');
  }

  return cfg;
}

function dropComments(v: unknown): Record<string, any> {
  if (!v || typeof v !== 'object') return {};
  return Object.fromEntries(Object.entries(v).filter(([k]) => k !== '$comment'));
}

function strArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : undefined;
}

function pickNumbers(obj: unknown, keys: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  if (obj && typeof obj === 'object') {
    for (const k of keys) {
      const v = (obj as Record<string, unknown>)[k];
      if (typeof v === 'number') out[k] = v;
    }
  }
  return out;
}
