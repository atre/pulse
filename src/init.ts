import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const HOOK_COMMAND = 'command -v pulse >/dev/null 2>&1 || exit 0; pulse --brief 2>/dev/null';

/** Merge a SessionStart hook running `pulse --brief` into a .claude/settings.json body. Idempotent. */
export function mergeSessionHook(settingsText: string | undefined): { text: string; changed: boolean } {
  const settings = settingsText?.trim() ? (JSON.parse(settingsText) as Record<string, unknown>) : {};
  const hooks = (settings.hooks ??= {}) as Record<string, unknown>;
  const start = (hooks.SessionStart ??= []) as Array<{ hooks?: Array<{ type?: string; command?: string; timeout?: number }> }>;
  const present = start.some((m) => m.hooks?.some((h) => typeof h.command === 'string' && /\bpulse\b/.test(h.command)));
  if (!present) start.push({ hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 20 }] });
  return { text: `${JSON.stringify(settings, null, 2)}\n`, changed: !present };
}

export function settingsPathFor(opts: { global?: boolean; cwd?: string }): string {
  return opts.global ? join(homedir(), '.claude', 'settings.json') : join(opts.cwd ?? process.cwd(), '.claude', 'settings.json');
}

export function cmdInit(opts: { global?: boolean; print?: boolean; cwd?: string }): number {
  const settingsPath = settingsPathFor(opts);
  const prev = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : undefined;
  let merged: { text: string; changed: boolean };
  try {
    merged = mergeSessionHook(prev);
  } catch {
    console.error(`pulse: ${settingsPath} is not valid JSON — hook not added`);
    return 1;
  }
  if (opts.print) {
    console.log(merged.text);
    return 0;
  }
  if (!merged.changed) {
    console.log(`pulse: SessionStart hook already wired in ${settingsPath}`);
    return 0;
  }
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, merged.text);
  console.log(`wired SessionStart hook (pulse --brief) into ${settingsPath}`);
  return 0;
}
