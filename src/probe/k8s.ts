import { X509Certificate } from 'node:crypto';
import type { Finding, K8sConfig } from '../types.js';
import { K8S_KINDS, type K8sKind, type KindResult, type KubectlLoader } from './kubectl.js';
import { intervalMinutes, shortSchedule } from '../cron.js';
import { ago, fmtDur } from '../util.js';

export interface K8sStats {
  workloads: number;
  cronjobs: number;
  nodes: number;
  nodesReady: number;
  pvcs: number;
}

export interface K8sProbeResult {
  findings: Finding[];
  stats: K8sStats;
}

const BAD_WAITING = new Set(['CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull', 'CreateContainerConfigError']);
const MIN = 60_000;

export async function probeK8s(loader: KubectlLoader, cfg: K8sConfig, now: number): Promise<K8sProbeResult> {
  // `secrets` is opt-in — only ever requested when tlsSecrets is on (extra kubectl call, and
  // the fixture spy test relies on the loader never seeing 'secrets' otherwise).
  const kinds: readonly K8sKind[] = cfg.tlsSecrets ? [...K8S_KINDS, 'secrets'] : K8S_KINDS;
  const results = await Promise.all(kinds.map((k) => loader(k)));
  const byKind = new Map<K8sKind, KindResult>(kinds.map((k, i) => [k, results[i]]));
  const findings: Finding[] = [];
  const stats: K8sStats = { workloads: 0, cronjobs: 0, nodes: 0, nodesReady: 0, pvcs: 0 };

  // Loader failures become findings, never crashes. One kubectl outage fails all
  // kinds with the same message — dedupe to a single line.
  const errKinds = new Map<string, K8sKind[]>();
  for (const k of kinds) {
    const r = byKind.get(k)!;
    if ('error' in r) {
      if (!errKinds.has(r.error)) errKinds.set(r.error, []);
      errKinds.get(r.error)!.push(k);
    }
  }
  for (const [msg, badKinds] of errKinds) {
    findings.push({
      id: badKinds.length === kinds.length ? 'probe:kubectl' : `probe:kubectl:${badKinds[0]}`,
      scope: 'probe',
      severity: 'crit',
      title: `kubectl unreachable: ${msg}`,
      detail: badKinds.length === kinds.length ? undefined : badKinds.join(', '),
      hint: 'check VPN/kubeconfig — kubectl get nodes',
    });
  }

  const keep = (item: any): boolean => !cfg.ignoreNamespaces.includes(item.metadata?.namespace);
  const items = (kind: K8sKind): any[] => {
    const r = byKind.get(kind)!;
    return 'items' in r ? r.items.filter(keep) : [];
  };

  // --- workloads: deploy / sts / ds ---------------------------------------
  const workloadKinds: Array<[K8sKind, string]> = [
    ['deployments', 'deploy'],
    ['statefulsets', 'sts'],
    ['daemonsets', 'ds'],
  ];
  for (const [kind, short] of workloadKinds) {
    for (const w of items(kind)) {
      stats.workloads++;
      const ns = w.metadata.namespace as string;
      const name = w.metadata.name as string;
      const key = `${ns}/${name}`;
      const id = `k8s:${key}`;
      const desired: number = kind === 'daemonsets' ? (w.status?.desiredNumberScheduled ?? 0) : (w.spec?.replicas ?? 0);
      const ready: number = kind === 'daemonsets' ? (w.status?.numberReady ?? 0) : (w.status?.readyReplicas ?? 0);
      if (desired === 0) {
        if (cfg.scaledToZeroOk.includes(key)) {
          findings.push({ id, scope: 'k8s', severity: 'ok', title: 'scaled to 0 (intended)' });
        } else {
          findings.push({
            id,
            scope: 'k8s',
            severity: 'warn',
            title: 'scaled to 0 (add to scaledToZeroOk if intended)',
            hint: `kubectl -n ${ns} scale ${short}/${name} --replicas=1`,
          });
        }
      } else if (ready < desired) {
        const sel = w.spec?.selector?.matchLabels
          ? Object.entries(w.spec.selector.matchLabels as Record<string, string>)
              .map(([k, v]) => `${k}=${v}`)
              .join(',')
          : undefined;
        findings.push({
          id,
          scope: 'k8s',
          severity: 'crit',
          title: `${ready}/${desired} ready`,
          hint: sel ? `kubectl -n ${ns} get pods -l ${sel}` : `kubectl -n ${ns} describe ${short} ${name}`,
        });
      } else {
        findings.push({ id, scope: 'k8s', severity: 'ok', title: `${ready}/${desired} ready` });
      }
    }
  }

  // --- pods ----------------------------------------------------------------
  for (const p of items('pods')) {
    const phase = p.status?.phase as string | undefined;
    if (phase === 'Succeeded') continue; // Completed pods (jobs) are the cronjob probe's business
    const ns = p.metadata.namespace as string;
    const name = p.metadata.name as string;
    const id = `k8s:${ns}/${name}`;
    const statuses: any[] = [...(p.status?.containerStatuses ?? []), ...(p.status?.initContainerStatuses ?? [])];

    const bad = statuses.find((cs) => BAD_WAITING.has(cs.state?.waiting?.reason));
    if (bad) {
      findings.push({
        id,
        scope: 'k8s',
        severity: 'crit',
        title: `${bad.state.waiting.reason} (${bad.name}, ${bad.restartCount ?? 0} restarts)`,
        hint: `kubectl -n ${ns} logs ${name} -c ${bad.name} --previous | squirt`,
      });
      continue; // one finding per pod — the crit covers it
    }
    if (phase === 'Pending') {
      const created = Date.parse(p.metadata.creationTimestamp ?? '') || now;
      if (now - created > 5 * MIN) {
        findings.push({
          id,
          scope: 'k8s',
          severity: 'warn',
          title: `Pending ${ago(created, now)}`,
          hint: `kubectl -n ${ns} describe pod ${name}`,
        });
      }
      continue;
    }
    const churn = statuses.find((cs) => {
      const fin = Date.parse(cs.lastState?.terminated?.finishedAt ?? '');
      return (cs.restartCount ?? 0) >= 5 && fin && now - fin < 60 * MIN;
    });
    if (churn) {
      findings.push({
        id,
        scope: 'k8s',
        severity: 'warn',
        title: `${churn.restartCount} restarts, last ${ago(Date.parse(churn.lastState.terminated.finishedAt), now)} ago`,
        hint: `kubectl -n ${ns} logs ${name} -c ${churn.name} --previous | squirt`,
      });
    }
  }

  // --- cronjobs (+ their newest job) ---------------------------------------
  const newestJob = new Map<string, any>();
  for (const j of items('jobs')) {
    const owner = (j.metadata.ownerReferences ?? []).find((o: any) => o.kind === 'CronJob');
    if (!owner) continue;
    const key = `${j.metadata.namespace}/${owner.name}`;
    const ts = Date.parse(j.status?.startTime ?? j.metadata.creationTimestamp ?? '') || 0;
    const prev = newestJob.get(key);
    if (!prev || ts > prev.__ts) newestJob.set(key, Object.assign(j, { __ts: ts }));
  }

  for (const cj of items('cronjobs')) {
    stats.cronjobs++;
    const ns = cj.metadata.namespace as string;
    const name = cj.metadata.name as string;
    const key = `${ns}/${name}`;
    const id = `cron:${key}`;
    const schedule = (cj.spec?.schedule as string) ?? '';
    const interval = intervalMinutes(schedule) * MIN;
    const override = cfg.cronjobs.override[key] ?? cfg.cronjobs.override[`${ns}/*`];

    if (cj.spec?.suspend) {
      if (override?.suspendedOk) findings.push({ id, scope: 'cron', severity: 'ok', title: 'suspended (intended)' });
      else
        findings.push({
          id,
          scope: 'cron',
          severity: 'warn',
          title: 'suspended',
          hint: `add "${key}": {"suspendedOk": true} to config cronjobs.override if intended`,
        });
      continue;
    }

    const job = newestJob.get(key);
    if (job && jobFailed(job)) {
      findings.push({
        id,
        scope: 'cron',
        severity: 'crit',
        title: `last job Failed ${ago(job.__ts, now)} ago`,
        hint: `kubectl -n ${ns} logs job/${job.metadata.name} | squirt`,
      });
      continue;
    }

    // Forbid-policy cronjobs bump lastScheduleTime only on completion, so a stuck
    // active job (checked below) is shadowed by this missed-runs check until it
    // has also blown past maxMissedRuns — order matters here.
    const last = Date.parse(cj.status?.lastScheduleTime ?? '');
    if (last && (now - last) / interval > cfg.cronjobs.maxMissedRuns) {
      findings.push({
        id,
        scope: 'cron',
        severity: 'crit',
        title: `no run for ${ago(last, now)} (${shortSchedule(schedule)})`,
        hint: `kubectl -n ${ns} describe cronjob ${name}`,
      });
      continue;
    }

    if (job && (job.status?.active ?? 0) > 0 && now - job.__ts > 2 * interval) {
      findings.push({
        id,
        scope: 'cron',
        severity: 'warn',
        title: `running ${ago(job.__ts, now)} (${shortSchedule(schedule)}) — stuck?`,
        hint: `kubectl -n ${ns} logs job/${job.metadata.name} | squirt`,
      });
      continue;
    }

    findings.push({ id, scope: 'cron', severity: 'ok', title: 'on schedule' });
  }

  // --- nodes ----------------------------------------------------------------
  for (const n of items('nodes')) {
    stats.nodes++;
    const name = n.metadata.name as string;
    const conds: any[] = n.status?.conditions ?? [];
    const ready = conds.find((c) => c.type === 'Ready');
    if (!ready || ready.status !== 'True') {
      findings.push({
        id: `node:${name}`,
        scope: 'node',
        severity: 'crit',
        title: 'NotReady',
        hint: `kubectl describe node ${name}`,
      });
      continue;
    }
    stats.nodesReady++;
    const pressure = conds.filter((c) => c.type.endsWith('Pressure') && c.status === 'True');
    if (pressure.length) {
      findings.push({
        id: `node:${name}`,
        scope: 'node',
        severity: 'warn',
        title: pressure.map((c) => c.type).join(', '),
        hint: `kubectl describe node ${name}`,
      });
    } else {
      findings.push({ id: `node:${name}`, scope: 'node', severity: 'ok', title: 'Ready' });
    }
  }

  // --- pvcs -------------------------------------------------------------------
  for (const pvc of items('persistentvolumeclaims')) {
    stats.pvcs++;
    const ns = pvc.metadata.namespace as string;
    const name = pvc.metadata.name as string;
    const phase = (pvc.status?.phase as string) ?? 'Unknown';
    if (phase !== 'Bound') {
      findings.push({
        id: `pvc:${ns}/${name}`,
        scope: 'pvc',
        severity: 'crit',
        title: phase,
        hint: `kubectl -n ${ns} describe pvc ${name}`,
      });
    } else {
      findings.push({ id: `pvc:${ns}/${name}`, scope: 'pvc', severity: 'ok', title: 'Bound' });
    }
  }

  // --- tls secrets (opt-in) --------------------------------------------------
  if (cfg.tlsSecrets) {
    findings.push(...tlsSecretFindings(items('secrets'), now, cfg.tlsDaysMin));
  }

  return { findings, stats };
}

const DAY = 24 * 60 * MIN;

/**
 * `kubernetes.io/tls` secrets → cert-expiry findings. Only `data['tls.crt']` (the public
 * cert) is ever read — `tls.key` is a private key and never touched.
 */
export function tlsSecretFindings(items: any[], now: number, tlsDaysMin: number): Finding[] {
  const findings: Finding[] = [];
  for (const s of items) {
    const ns = s.metadata?.namespace as string;
    const name = s.metadata?.name as string;
    const id = `tls:${ns}/${name}`;
    const hint = `kubectl -n ${ns} get secret ${name} -o yaml`;
    const b64 = s.data?.['tls.crt'];
    if (!b64) {
      findings.push({ id, scope: 'tls', severity: 'warn', title: 'no tls.crt in secret', hint });
      continue;
    }
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(Buffer.from(b64, 'base64'));
    } catch (e) {
      findings.push({ id, scope: 'tls', severity: 'warn', title: `unparseable cert: ${(e as Error).message}`, hint });
      continue;
    }
    const cn = cert.subject.match(/^CN=(.+)$/m)?.[1] ?? cert.subject;
    const msLeft = Date.parse(cert.validTo) - now;
    const daysLeft = msLeft / DAY;
    const title = msLeft >= 0 ? `expires in ${fmtDur(msLeft)} (cn=${cn})` : `expired ${fmtDur(-msLeft)} ago (cn=${cn})`;
    const severity = daysLeft < 3 ? 'crit' : daysLeft < tlsDaysMin ? 'warn' : 'ok';
    findings.push({ id, scope: 'tls', severity, title, hint });
  }
  return findings;
}

/** Failed = explicit Failed condition, or failed pods with no eventual success and nothing running. */
function jobFailed(job: any): boolean {
  const conds: any[] = job.status?.conditions ?? [];
  if (conds.some((c) => c.type === 'Failed' && c.status === 'True')) return true;
  return (job.status?.failed ?? 0) > 0 && !(job.status?.succeeded ?? 0) && !(job.status?.active ?? 0);
}
