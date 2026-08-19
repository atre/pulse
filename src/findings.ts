import type { Finding, Scope, Severity } from './types.js';

export type { Finding, Scope, Severity };

const SEV_ORDER: Record<Severity, number> = { crit: 0, warn: 1, ok: 2 };
// probe first — "kubectl unreachable" explains every other gap in the digest.
// gate/visual/log are written by other fleet tools, not pulse's own probes — pulse never
// emits them, but the type must stay exhaustive since other tools' findings can land in
// the same snap file brief/render read back.
const SCOPE_ORDER: Record<Scope, number> = {
  probe: 0,
  k8s: 1,
  cron: 2,
  node: 3,
  pvc: 4,
  tls: 5,
  site: 6,
  disk: 7,
  host: 8,
  gate: 9,
  visual: 10,
  log: 11,
};

/** crit → warn → ok, then by scope, then id. Stable input untouched. */
export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      SEV_ORDER[a.severity] - SEV_ORDER[b.severity] ||
      SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] ||
      a.id.localeCompare(b.id),
  );
}

export interface ScopeCounts {
  crit: number;
  warn: number;
  ok: number;
}

export interface Summary {
  total: number;
  crit: number;
  warn: number;
  ok: number;
  byScope: Partial<Record<Scope, ScopeCounts>>;
}

export function summarize(findings: Finding[]): Summary {
  const s: Summary = { total: findings.length, crit: 0, warn: 0, ok: 0, byScope: {} };
  for (const f of findings) {
    s[f.severity]++;
    const sc = (s.byScope[f.scope] ??= { crit: 0, warn: 0, ok: 0 });
    sc[f.severity]++;
  }
  return s;
}
