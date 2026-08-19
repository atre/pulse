/**
 * Smallest gap in minutes between consecutive fire times of a cron schedule,
 * from the minute+hour fields only (dom/month/dow ignored — good enough for
 * staleness math). Unparseable or once-a-day → 1440.
 */
export function intervalMinutes(schedule: string): number {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length < 5) return 1440;
  const mins = expandField(parts[0], 60);
  const hours = expandField(parts[1], 24);
  if (!mins || !hours || mins.length === 0 || hours.length === 0) return 1440;
  const fires: number[] = [];
  for (const h of hours) for (const m of mins) fires.push(h * 60 + m);
  fires.sort((a, b) => a - b);
  if (fires.length < 2) return 1440;
  let gap = fires[0] + 1440 - fires[fires.length - 1]; // wraparound midnight
  for (let i = 1; i < fires.length; i++) gap = Math.min(gap, fires[i] - fires[i - 1]);
  return gap;
}

// "*", "*/N", "N", "N-M", "N-M/S" and comma lists thereof → sorted values; null = unparseable.
function expandField(field: string, max: number): number[] | null {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    let m: RegExpExecArray | null;
    if (part === '*') {
      for (let i = 0; i < max; i++) out.add(i);
    } else if ((m = /^\*\/(\d+)$/.exec(part))) {
      const step = Number(m[1]);
      if (!step) return null;
      for (let i = 0; i < max; i += step) out.add(i);
    } else if ((m = /^(\d+)-(\d+)(?:\/(\d+))?$/.exec(part))) {
      const step = m[3] ? Number(m[3]) : 1;
      if (!step) return null;
      for (let i = Number(m[1]); i <= Number(m[2]) && i < max; i += step) out.add(i);
    } else if ((m = /^(\d+)$/.exec(part))) {
      const v = Number(m[1]);
      if (v >= max) return null;
      out.add(v);
    } else return null;
  }
  return [...out].sort((a, b) => a - b);
}

// Compact schedule for finding titles: "*/15 * * * *" → "*/15", "7 */2 * * *" → "7 */2".
export function shortSchedule(schedule: string): string {
  return schedule.trim().replace(/(\s+\*)+$/, '');
}
