// Shared types. The Finding shape is the whole contract: probes emit them,
// render/snap/diff consume them. Severity rules live in the probes' callers
// per CLAUDE.md — probes never decide layout.

export type Scope =
  | 'k8s'
  | 'cron'
  | 'node'
  | 'pvc'
  | 'tls'
  | 'site'
  | 'disk'
  | 'host'
  | 'probe'
  // reserved for other fleet tools writing into the same Finding shape (see README "Finding schema")
  | 'gate'
  | 'visual'
  | 'log';
export type Severity = 'crit' | 'warn' | 'ok';

export interface Finding {
  /** Stable across runs (snap/diff keys on it), e.g. `cron:assistant/assistant-rss-sync`. */
  id: string;
  scope: Scope;
  severity: Severity;
  title: string;
  detail?: string;
  /** What to do or where to look — every crit/warn must have one. */
  hint?: string;
  /** First-seen epoch ms (Phase 2 state.json). */
  since?: number;
  /** Site group — render folding only. */
  group?: string;
  /** Site HTTP status / latency — render folding only. */
  status?: number;
  latencyMs?: number;
}

export interface SiteExpect {
  status: number[];
  tlsDaysMin: number;
  contains?: string;
}

export interface SiteConfig {
  url: string;
  expect: SiteExpect;
  /** LAN-only site: network failures downgrade to warn. */
  lan?: boolean;
  group?: string;
}

/** Raw probe result for one site — fixtures are arrays of these. */
export interface SiteResult {
  url: string;
  status?: number;
  latencyMs?: number;
  finalUrl?: string;
  redirects?: number;
  /** Only set when expect.contains was checked. */
  containsFound?: boolean;
  /** Days until cert expiry (may be negative); undefined = not checked / check failed. */
  tlsDaysLeft?: number;
  /** Network-level failure: error code or 'timeout'. */
  error?: string;
}

export interface CronOverride {
  suspendedOk?: boolean;
}

export interface K8sConfig {
  context?: string;
  ignoreNamespaces: string[];
  /** `<ns>/<name>` workloads where desired == 0 is intended. */
  scaledToZeroOk: string[];
  cronjobs: {
    maxMissedRuns: number;
    override: Record<string, CronOverride>;
  };
  /** Fetch `secrets` (type=kubernetes.io/tls) and emit cert-expiry findings. Off by default (extra kubectl call). */
  tlsSecrets: boolean;
  /** Days-left threshold for a `tls:` warn (crit stays fixed at < 3 or expired). */
  tlsDaysMin: number;
}

export interface DiskConfig {
  instance: string;
  mount: string;
  warnPct?: number;
  critPct?: number;
}

export interface PromConfig {
  url?: string;
  portForward?: string;
  disks: DiskConfig[];
  warnPctDefault?: number;
}

export interface HostConfig {
  name: string;
  ssh: string;
  checks?: string[];
}

export interface Budgets {
  siteTimeoutMs: number;
  kubectlTimeoutS: number;
  sshTimeoutS: number;
  concurrency: number;
}

export interface Config {
  /** Path the config was loaded from; null → no config file (probes skipped). */
  path: string | null;
  /** Where we looked when path is null — for the "no config" message. */
  triedPath?: string;
  k8s?: K8sConfig;
  sites: SiteConfig[];
  prometheus?: PromConfig;
  hosts: HostConfig[];
  budgets: Budgets;
}
