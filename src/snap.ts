import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Finding, Severity } from './types.js';

/** State dir: `$PULSE_HOME` when set, else `~/.pulse`. */
export function defaultBase(): string {
  return process.env.PULSE_HOME || join(homedir(), '.pulse');
}

export interface Snap {
  ts: number;
  findings: Finding[];
}

export function writeSnap(name: string, findings: Finding[], ts: number, base: string = defaultBase()): void {
  const dir = join(base, 'snaps');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify({ ts, findings }, null, 2)}\n`);
}

export function readSnap(name: string, base: string = defaultBase()): Snap | undefined {
  try {
    return JSON.parse(readFileSync(join(base, 'snaps', `${name}.json`), 'utf8')) as Snap;
  } catch {
    return undefined;
  }
}

export interface DiffResult {
  added: Finding[];
  resolved: Finding[];
  changed: Array<{ id: string; title: string; from: Severity; to: Severity }>;
  unchanged: number;
}

/** `added` = ids not in the snap (non-ok only); `resolved` = ids that were crit/warn and now aren't. */
export function diffFindings(prev: Finding[], curr: Finding[]): DiffResult {
  const prevById = new Map(prev.map((f) => [f.id, f]));
  const currById = new Map(curr.map((f) => [f.id, f]));
  const added: Finding[] = [];
  const changed: DiffResult['changed'] = [];
  let unchanged = 0;

  for (const f of curr) {
    const p = prevById.get(f.id);
    if (!p) {
      if (f.severity !== 'ok') added.push(f);
    } else if (p.severity === f.severity) {
      unchanged++;
    } else if (f.severity !== 'ok') {
      // crit/warn → ok is reported as `resolved` below, not here
      changed.push({ id: f.id, title: f.title, from: p.severity, to: f.severity });
    }
  }

  const resolved: Finding[] = [];
  for (const f of prev) {
    if (f.severity === 'ok') continue;
    const c = currById.get(f.id);
    if (!c || c.severity === 'ok') resolved.push(c ?? f);
  }
  return { added, resolved, changed, unchanged };
}

interface State {
  firstSeen: Record<string, number>;
}

function statePath(base: string): string {
  return join(base, 'state.json');
}

function loadState(base: string): State {
  try {
    return JSON.parse(readFileSync(statePath(base), 'utf8')) as State;
  } catch {
    return { firstSeen: {} };
  }
}

function saveState(state: State, base: string): void {
  mkdirSync(base, { recursive: true });
  writeFileSync(statePath(base), `${JSON.stringify(state, null, 2)}\n`);
}

/** Sets `since` on every non-ok finding to its first-seen time, tracked in state.json. Mutates and returns findings. */
export function applySince(findings: Finding[], now: number, base: string = defaultBase()): Finding[] {
  const state = loadState(base);
  const nextFirstSeen: Record<string, number> = {};
  for (const f of findings) {
    if (f.severity === 'ok') continue;
    const first = state.firstSeen[f.id] ?? now;
    nextFirstSeen[f.id] = first;
    f.since = first;
  }
  saveState({ firstSeen: nextFirstSeen }, base);
  return findings;
}
