import { sortFindings, summarize } from './findings.js';
import type { Finding } from './types.js';
import type { K8sStats } from './probe/k8s.js';
import { ago } from './util.js';

export interface RenderMeta {
  ts: number;
  elapsedMs: number;
  configPath: string | null;
  triedPath?: string;
  ctx?: string;
  /** Which sections were configured — absent sections are omitted from the header. */
  sections: { k8s: boolean; sites: boolean; disks: boolean; hosts: boolean };
  stats?: K8sStats;
  siteCount?: number;
  diskCount?: number;
  hostCount?: number;
}

export interface RenderOpts {
  brief?: boolean;
  all?: boolean;
  /** Output budget in tokens (≈ 4 chars each): trim warn lines first, then crit hints, never a crit line. */
  tokens?: number;
}

const ID_CAP = 34;
const BRIEF_CAP = 12;

export function renderText(findings: Finding[], meta: RenderMeta, opts: RenderOpts = {}): string {
  if (meta.configPath === null && findings.length === 0) {
    return `pulse — no config — copy examples/config.json to ${meta.triedPath ?? '~/.config/pulse/config.json'}`;
  }

  const sorted = sortFindings(findings);
  const crit = sorted.filter((f) => f.severity === 'crit');
  const warn = sorted.filter((f) => f.severity === 'warn');
  const ok = sorted.filter((f) => f.severity === 'ok');

  if (opts.brief && crit.length === 0 && warn.length === 0) {
    // hook mode: silence is the good outcome; "all green" only when there is truly nothing
    return findings.length === 0 ? 'pulse — all green (nothing probed)' : '';
  }

  const out: string[] = [header(meta)];
  const shown = [...crit, ...warn];
  const widthOf = opts.all ? sorted : shown;
  const w = Math.min(ID_CAP, Math.max(4, ...widthOf.map((f) => idish(f).length)));
  for (const f of shown) out.push(line(f, w, !opts.brief, meta.ts));

  if (opts.brief) {
    if (out.length > BRIEF_CAP) {
      const more = out.length - (BRIEF_CAP - 1);
      out.length = BRIEF_CAP - 1;
      out.push(`… +${more} more, run pulse`);
    }
    return budget(out, opts.tokens);
  }

  if (ok.length) {
    const fold = foldGreen(ok);
    if (opts.all) {
      out.push(`✓ ${fold}`);
      for (const f of ok) out.push(line(f, w, true, meta.ts));
    } else {
      out.push(`✓ ${fold}`);
    }
  }
  return budget(out, opts.tokens);
}

function header(meta: RenderMeta): string {
  const parts: string[] = ['pulse —'];
  if (meta.sections.k8s) {
    const s = meta.stats;
    parts.push(`k3s${meta.ctx ? ` ${meta.ctx}` : ''}${s ? ` ${s.nodesReady}/${s.nodes} nodes` : ''}`);
    if (s) parts.push(`${s.workloads} workloads`, `${s.cronjobs} cronjobs`);
  }
  if (meta.sections.sites) parts.push(`${meta.siteCount ?? 0} sites`);
  if (meta.sections.disks) parts.push(`${meta.diskCount ?? 0} disks`);
  if (meta.sections.hosts) parts.push(`${meta.hostCount ?? 0} hosts`);
  parts.push(`${meta.elapsedMs}ms`);
  return `${parts[0]} ${parts.slice(1).join(' · ')}`;
}

/** `cron:assistant/assistant-rss-sync` → `assistant/assistant-rss-sync`; urls lose their scheme. */
export function idish(f: Finding): string {
  let s = f.id.replace(/^[a-z0-9]+:/, '').replace(/^https?:\/\//, '');
  if (s.length > ID_CAP) s = `${s.slice(0, ID_CAP - 1)}…`;
  return s;
}

function line(f: Finding, w: number, full: boolean, now: number): string {
  const mark = f.severity === 'crit' ? '✗' : f.severity === 'warn' ? '⚠' : '✓';
  let s = `${mark} ${idish(f).padEnd(w)}  ${f.scope.padEnd(5)}  ${f.title}`;
  if (f.severity === 'crit' && f.since !== undefined) s += ` (since ${ago(f.since, now)})`;
  if (f.hint) s += `  → ${f.hint}`;
  if (full && f.detail) s += `\n${''.padEnd(w + 2)}  ${f.detail}`;
  return s;
}

/** One folded line for the green: grouped counts, never individual items. */
export function foldGreen(ok: Finding[]): string {
  const parts: string[] = [];

  // sites first, grouped by `group` — "10 hosting sites 200 in ≤ 420ms"
  const sites = ok.filter((f) => f.scope === 'site');
  const byGroup = new Map<string, Finding[]>();
  for (const f of sites) {
    const g = f.group ?? '';
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g)!.push(f);
  }
  for (const [g, fs] of byGroup) {
    const statuses = new Set(fs.map((f) => f.status).filter((s) => s !== undefined));
    const statusTxt = statuses.size === 1 ? `${[...statuses][0]}` : 'ok';
    const maxMs = Math.max(...fs.map((f) => f.latencyMs ?? 0));
    parts.push(`${fs.length} ${g ? `${g} ` : ''}site${fs.length === 1 ? '' : 's'} ${statusTxt} in ≤ ${maxMs}ms`);
  }

  const count = (scope: Finding['scope'], label: string): void => {
    const n = ok.filter((f) => f.scope === scope).length;
    if (n) parts.push(`${n} ${label}`);
  };
  count('k8s', 'workloads ready');
  count('cron', 'cronjobs on schedule');
  count('node', 'nodes Ready');
  count('pvc', 'PVCs bound');
  count('disk', 'disks ok');
  count('host', 'host checks ok');
  return parts.join(' · ');
}

/** Trim to ≈ tokens*4 chars: drop warn lines from the end first, then crit hints. Crit lines survive. */
function budget(lines: string[], tokens?: number): string {
  if (!tokens) return lines.join('\n');
  const cap = tokens * 4;
  const fits = (): boolean => lines.join('\n').length <= cap;
  if (fits()) return lines.join('\n');

  // 1) drop green fold + warn lines from the end
  const isDroppable = (l: string): boolean => l.startsWith('⚠') || l.startsWith('✓');
  let dropped = 0;
  for (let i = lines.length - 1; i >= 0 && !fits(); i--) {
    if (isDroppable(lines[i])) {
      lines.splice(i, 1);
      dropped++;
    }
  }
  if (dropped) lines.push(`… +${dropped} trimmed (--tokens)`);
  if (fits()) return lines.join('\n');

  // 2) strip hints from crit lines — the line itself is untouchable
  for (let i = 0; i < lines.length && !fits(); i++) {
    const cut = lines[i].indexOf('  → ');
    if (lines[i].startsWith('✗') && cut !== -1) lines[i] = lines[i].slice(0, cut);
  }
  return lines.join('\n');
}

export function renderJson(findings: Finding[], meta: RenderMeta): string {
  const sorted = sortFindings(findings);
  return JSON.stringify(
    { ts: meta.ts, config: meta.configPath, elapsedMs: meta.elapsedMs, findings: sorted, summary: summarize(sorted) },
    null,
    2,
  );
}

export function renderMd(findings: Finding[], meta: RenderMeta): string {
  const sorted = sortFindings(findings);
  const out = [`# ${header(meta)}`, '', '| sev | scope | id | title | hint |', '|---|---|---|---|---|'];
  for (const f of sorted) {
    if (f.severity === 'ok') continue;
    out.push(`| ${f.severity} | ${f.scope} | ${f.id} | ${f.title} | ${f.hint ?? ''} |`);
  }
  const ok = sorted.filter((f) => f.severity === 'ok');
  if (ok.length) out.push('', `✓ ${foldGreen(ok)}`);
  return out.join('\n');
}
