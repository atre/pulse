import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultK8sConfig, loadConfig } from './config.js';
import { cmdInit } from './init.js';
import { probeK8s, type K8sStats } from './probe/k8s.js';
import { evaluateHost, probeHosts, type HostResult } from './probe/hosts.js';
import { fixtureKubectl, realKubectl } from './probe/kubectl.js';
import { evaluateDisks, parsePromResponse, probeProm, type PromSample } from './probe/prom.js';
import { evaluateSite, probeSites } from './probe/sites.js';
import { renderJson, renderMd, renderText, type RenderMeta } from './render.js';
import { applySince, defaultBase, diffFindings, readSnap, writeSnap } from './snap.js';
import { pkgVersion } from './util.js';
import type { Config, Finding, SiteResult } from './types.js';

const HELP = `pulse — runtime radar (k3s · cronjobs · nodes · sites · TLS · disks)

usage
  pulse                       one digest: red first, then warnings, green folded
  pulse --brief               hook mode: red/warn only, ≤ 12 lines, exit 1 when red
  pulse --json | --md         machine / markdown output
  pulse --all                 also list green items individually
  pulse --only <scope|substr> filter findings (k8s, cron, node, pvc, site, or id substring)
  pulse --tokens N            hard output budget (trims warns first, never a crit)
  pulse --fixtures <dir>      run every probe from recorded JSON (no network/kubectl)
  pulse --config <file>       default ~/.config/pulse/config.json (see examples/config.json)
  pulse --context <ctx>       kubectl context override
  pulse snap [name]           save current findings as $PULSE_HOME/snaps/<name>.json (default "last")
  pulse diff [name]           live run vs. a saved snap: new / resolved / changed
  pulse init --claude [--global] [--print]   wire the SessionStart hook (pulse --brief)
  -h, --help · -v, --version

env: PULSE_HOME — state dir for snaps + first-seen (default ~/.pulse)
exit code: 1 when anything is crit, 0 otherwise.`;

interface Args {
  config?: string;
  fixtures?: string;
  brief: boolean;
  json: boolean;
  md: boolean;
  all: boolean;
  tokens?: number;
  only?: string;
  context?: string;
  subcommand?: string;
  subArg?: string;
  global: boolean;
  print: boolean;
}

export function parseArgs(argv: string[]): Args | { exit: number; out: string } {
  const a: Args = { brief: false, json: false, md: false, all: false, global: false, print: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[++i];
    };
    if (arg === '-h' || arg === '--help') return { exit: 0, out: HELP };
    else if (arg === '-v' || arg === '--version') return { exit: 0, out: pkgVersion() };
    else if (arg === '--config') a.config = next();
    else if (arg === '--fixtures') a.fixtures = next();
    else if (arg === '--brief') a.brief = true;
    else if (arg === '--json') a.json = true;
    else if (arg === '--md') a.md = true;
    else if (arg === '--all') a.all = true;
    else if (arg === '--tokens') a.tokens = Number(next()) || undefined;
    else if (arg === '--only') a.only = next();
    else if (arg === '--context') a.context = next();
    else if (arg === '--global') a.global = true;
    else if (arg === '--print') a.print = true;
    else if (arg === '--claude') continue; // pulse init --claude — marker flag, no-op
    else if (!arg.startsWith('-') && !a.subcommand) a.subcommand = arg;
    else if (!arg.startsWith('-') && a.subcommand && !a.subArg) a.subArg = arg;
    else return { exit: 2, out: `unknown flag ${arg}\n\n${HELP}` };
  }
  return a;
}

export async function main(argv: string[]): Promise<number> {
  let args: Args;
  try {
    const parsed = parseArgs(argv);
    if ('exit' in parsed) {
      console.log(parsed.out);
      return parsed.exit;
    }
    args = parsed;
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  if (args.subcommand === 'init') return cmdInit({ global: args.global, print: args.print });

  if (args.subcommand && args.subcommand !== 'snap' && args.subcommand !== 'diff') {
    console.error(`unknown subcommand ${args.subcommand}\n\n${HELP}`);
    return 2;
  }

  let gathered: { findings: Finding[]; meta: RenderMeta };
  try {
    gathered = await gather(args);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  let { findings } = gathered;
  const { meta } = gathered;

  // fixture runs never touch state.json — `since` is wall-clock and would only smear fixture ids into
  // real state — and only write `last` when PULSE_HOME points somewhere explicit: a fixture last.json
  // in the real ~/.pulse made brief show a false `runtime ✗` (2026-08-17).
  if (!args.fixtures) findings = applySince(findings, meta.ts);
  if (!args.fixtures || process.env.PULSE_HOME) writeSnap('last', findings, meta.ts);

  if (args.subcommand === 'snap') {
    const name = args.subArg ?? 'last';
    if (name !== 'last') writeSnap(name, findings, meta.ts);
    console.log(`pulse: wrote ${findings.length} findings to ${join(defaultBase(), 'snaps', `${name}.json`)}`);
    console.log(`run "pulse diff${name === 'last' ? '' : ` ${name}`}" after`);
    return 0;
  }

  if (args.subcommand === 'diff') {
    const name = args.subArg ?? 'last';
    const snap = readSnap(name);
    if (!snap) {
      console.error(`pulse: no snap "${name}" — run "pulse snap${name === 'last' ? '' : ` ${name}`}" first`);
      return 2;
    }
    const d = diffFindings(snap.findings, findings);
    for (const f of d.added) console.log(`+ ${f.severity.padEnd(4)} ${f.id}  ${f.title}`);
    for (const f of d.resolved) console.log(`- resolved ${f.id}  ${f.title}`);
    for (const c of d.changed) console.log(`~ ${c.id}  ${c.from} → ${c.to}  ${c.title}`);
    console.log(`${d.added.length} new · ${d.resolved.length} resolved · ${d.changed.length} changed · ${d.unchanged} unchanged`);
    return d.added.some((f) => f.severity === 'crit') || d.changed.some((c) => c.to === 'crit') ? 1 : 0;
  }

  const shown = args.only ? findings.filter((f) => f.scope === args.only || f.id.includes(args.only!)) : findings;

  if (args.json) console.log(renderJson(shown, meta));
  else if (args.md) console.log(renderMd(shown, meta));
  else {
    const txt = renderText(shown, meta, { brief: args.brief, all: args.all, tokens: args.tokens });
    if (txt) console.log(txt);
  }

  return shown.some((f) => f.severity === 'crit') ? 1 : 0;
}

/** Runs every configured probe (real, or from --fixtures) and returns raw findings + render metadata. */
async function gather(args: Args): Promise<{ findings: Finding[]; meta: RenderMeta }> {
  const cfg: Config = loadConfig(args.config ?? fixtureConfigPath(args.fixtures));
  // fixture runs must be able to probe even with no config anywhere
  if (args.fixtures && !cfg.k8s) cfg.k8s = defaultK8sConfig();
  if (args.context && cfg.k8s) cfg.k8s.context = args.context;

  const now = fixtureNow(args.fixtures) ?? Date.now();
  const started = Date.now();
  const findings: Finding[] = [];
  let stats: K8sStats | undefined;

  const jobs: Array<Promise<void>> = [];
  if (cfg.k8s) {
    const loader = args.fixtures
      ? fixtureKubectl(args.fixtures)
      : realKubectl({ context: cfg.k8s.context, timeoutS: cfg.budgets.kubectlTimeoutS });
    jobs.push(
      probeK8s(loader, cfg.k8s, now).then((r) => {
        findings.push(...r.findings);
        stats = r.stats;
      }),
    );
  }

  let siteCount = 0;
  if (args.fixtures) {
    // recorded results only — fixture mode never touches the network
    const p = join(args.fixtures, 'sites.json');
    if (existsSync(p)) {
      const recorded: SiteResult[] = JSON.parse(readFileSync(p, 'utf8'));
      const byUrl = new Map(recorded.map((r) => [r.url, r]));
      for (const site of cfg.sites) {
        const r = byUrl.get(site.url);
        if (r) {
          siteCount++;
          findings.push(...evaluateSite(site, r));
        }
      }
    }
  } else if (cfg.sites.length) {
    siteCount = cfg.sites.length;
    jobs.push(probeSites(cfg.sites, cfg.budgets).then((f) => void findings.push(...f)));
  }

  let diskCount = 0;
  const disks = cfg.prometheus?.disks ?? [];
  if (args.fixtures) {
    const p = join(args.fixtures, 'prom.json');
    if (existsSync(p) && disks.length) {
      const raw: Record<string, unknown> = JSON.parse(readFileSync(p, 'utf8'));
      const query = async (expr: string): Promise<PromSample[]> => parsePromResponse(raw[expr]);
      diskCount = disks.length;
      jobs.push(evaluateDisks(disks, cfg.prometheus?.warnPctDefault, query).then((f) => void findings.push(...f)));
    }
  } else if (disks.length) {
    diskCount = disks.length;
    jobs.push(probeProm(cfg.prometheus!, cfg.budgets).then((f) => void findings.push(...f)));
  }

  let hostCount = 0;
  if (args.fixtures) {
    const p = join(args.fixtures, 'hosts.json');
    if (existsSync(p) && cfg.hosts.length) {
      const recorded: Array<{ name: string } & HostResult> = JSON.parse(readFileSync(p, 'utf8'));
      const byName = new Map(recorded.map((r) => [r.name, r]));
      for (const host of cfg.hosts) {
        const r = byName.get(host.name);
        if (r) {
          hostCount++;
          findings.push(...evaluateHost(host, r));
        }
      }
    }
  } else if (cfg.hosts.length) {
    hostCount = cfg.hosts.length;
    jobs.push(probeHosts(cfg.hosts, cfg.budgets).then((f) => void findings.push(...f)));
  }

  await Promise.all(jobs);

  const meta: RenderMeta = {
    ts: now,
    elapsedMs: Date.now() - started,
    configPath: cfg.path,
    triedPath: cfg.triedPath,
    ctx: cfg.k8s?.context,
    sections: { k8s: Boolean(cfg.k8s), sites: siteCount > 0, disks: diskCount > 0, hosts: hostCount > 0 },
    stats,
    siteCount,
    diskCount,
    hostCount,
  };
  return { findings, meta };
}

function fixtureConfigPath(fixtures?: string): string | undefined {
  if (!fixtures) return undefined;
  const p = join(fixtures, 'config.json');
  return existsSync(p) ? p : undefined;
}

function fixtureNow(fixtures?: string): number | undefined {
  if (!fixtures) return undefined;
  try {
    const meta = JSON.parse(readFileSync(join(fixtures, 'meta.json'), 'utf8')) as { now?: string };
    const t = Date.parse(meta.now ?? '');
    return Number.isNaN(t) ? undefined : t;
  } catch {
    return undefined;
  }
}
