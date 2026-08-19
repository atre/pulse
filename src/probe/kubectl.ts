import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const K8S_KINDS = [
  'deployments',
  'statefulsets',
  'daemonsets',
  'pods',
  'cronjobs',
  'jobs',
  'nodes',
  'persistentvolumeclaims',
] as const;
/** `secrets` is opt-in (`k8s.tlsSecrets`) — deliberately not in `K8S_KINDS`, which is always fetched. */
export type K8sKind = (typeof K8S_KINDS)[number] | 'secrets';

export type KindResult = { items: any[] } | { error: string };
export type KubectlLoader = (kind: K8sKind) => Promise<KindResult>;

/** Real loader: `kubectl get <kind> -A -o json`. Errors come back as values, never throws. */
export function realKubectl(opts: { context?: string; timeoutS: number }): KubectlLoader {
  return (kind) =>
    new Promise((resolve) => {
      const args = ['get', kind, '-A', '-o', 'json', `--request-timeout=${opts.timeoutS}s`];
      // TLS secrets only — never pull other Secret types (values, not just tls.crt) onto this laptop.
      if (kind === 'secrets') args.push('--field-selector', 'type=kubernetes.io/tls');
      if (opts.context) args.push('--context', opts.context);
      execFile(
        'kubectl',
        args,
        // +2s so kubectl's own request timeout usually fires first with a readable message
        { timeout: (opts.timeoutS + 2) * 1000, maxBuffer: 64 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            const line = (stderr || err.message).split('\n')[0].trim() || 'kubectl failed';
            resolve({ error: line });
            return;
          }
          try {
            resolve({ items: (JSON.parse(stdout) as { items?: any[] }).items ?? [] });
          } catch (e) {
            resolve({ error: `bad kubectl JSON for ${kind}: ${(e as Error).message}` });
          }
        },
      );
    });
}

/** Fixture loader: reads `<dir>/<kind>.json` (recorded `kubectl -o json` output). */
export function fixtureKubectl(dir: string): KubectlLoader {
  return async (kind) => {
    try {
      const raw = await readFile(join(dir, `${kind}.json`), 'utf8');
      return { items: (JSON.parse(raw) as { items?: any[] }).items ?? [] };
    } catch (e) {
      return { error: `fixture ${join(dir, `${kind}.json`)}: ${(e as Error).message}` };
    }
  };
}
