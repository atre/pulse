import { createRequire } from 'node:module';

const MIN = 60_000;
const DAY = 86_400_000;

let cachedVersion: string | undefined;
/** pulse's own version — works from dist/ and test-dist/ layouts alike. */
export function pkgVersion(): string {
  if (cachedVersion) return cachedVersion;
  const req = createRequire(import.meta.url);
  for (const p of ['../package.json', '../../package.json']) {
    try {
      const pkg = req(p) as { name?: string; version?: string };
      if (pkg.name === 'pulse' && pkg.version) return (cachedVersion = pkg.version);
    } catch {
      // keep looking
    }
  }
  return (cachedVersion = '0');
}

/** "47min" / "3h" / "2d" — age of a past timestamp. */
export function ago(ts: number, now: number): string {
  return fmtDur(Math.max(0, now - ts));
}

/** Compact duration for titles: 47min, 3h, 2d, 3mo. */
export function fmtDur(ms: number): string {
  const d = ms / DAY;
  if (d < 1 / 24) return `${Math.max(1, Math.round(ms / MIN))}min`;
  if (d < 2) return `${Math.round(d * 24)}h`;
  if (d < 60) return `${Math.round(d)}d`;
  return `${Math.round(d / 30)}mo`;
}

/** Run tasks with a concurrency cap; result order matches input order. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}
