# pulse

Runtime radar. One command answers "is everything running?" across a k3s home
lab, a Hetzner prod fleet, cronjobs, TLS certificates and disks — red first,
green folded, small enough to sit at the top of every AI session.

Built as the third radar next to [`brief`](https://github.com/atre/brief)
(repos) and [`tally`](https://github.com/atre/tally) (tokens).

## Status

Phase 1 + 2 done: config, k8s probe (workloads/pods/cronjobs/nodes/PVCs),
sites probe (HTTP + TLS), disks (Prometheus), hosts (ssh), snap/diff,
`init --claude`, render, CLI. Phase 3 (peep/brief/looksy integrations) is
next — see `PLAN.md`.

## Probes

| scope    | source                                        | severity rules |
|----------|------------------------------------------------|----------------|
| `k8s`    | `kubectl get deploy/sts/ds/pods -A`             | ready < desired → crit; CrashLoopBackOff etc → crit |
| `cron`   | `kubectl get cronjobs/jobs -A`                  | missed runs / failed job → crit; suspended → warn |
| `node`   | `kubectl get nodes`                             | NotReady → crit; \*Pressure → warn |
| `pvc`    | `kubectl get pvc -A`                            | not Bound → crit |
| `tls`    | `kubectl get secrets -A --field-selector type=kubernetes.io/tls` (opt-in `k8s.tlsSecrets`) | expired or < 3d → crit; < `tlsDaysMin` → warn |
| `site`   | `fetch` + `node:tls`                            | status/marker mismatch → crit; TLS < 3d → crit, < `tlsDaysMin` → warn |
| `disk`   | Prometheus `node_filesystem_*_bytes`, `up`      | usedPct ≥ `critPct` → crit, ≥ `warnPct` → warn; node-exporter down → warn |
| `host`   | `ssh … 'df -P; uptime; docker ps'`              | same disk thresholds; docker container not running/unhealthy → crit; ssh unreachable → warn (optional) |

## Usage

```
pulse                       # digest: crit → warn → green folded
pulse --brief               # hook mode: crit/warn only, ≤ 12 lines, exit 1 on crit
pulse --json | --md
pulse --all                 # also list green items individually
pulse --only <scope|substr> # filter findings
pulse --tokens N            # hard output budget
pulse --fixtures <dir>      # replace every probe with recorded JSON (tests, demos)
pulse --config <file>       # default ~/.config/pulse/config.json (see examples/config.json)
pulse --context <ctx>       # kubectl context override
pulse snap [name]           # save current findings as ~/.pulse/snaps/<name>.json (default "last")
pulse diff [name]           # live run vs. a saved snap: new / resolved / changed
pulse init --claude [--global] [--print]   # wire the SessionStart hook (pulse --brief)
```

Every plain run writes `$PULSE_HOME/snaps/last.json` (`{ts, findings}` — what `brief` joins on) and tracks first-seen in
`$PULSE_HOME/state.json`. `PULSE_HOME` defaults to `~/.pulse`. Fixture runs never touch the real dir: they write `last.json` only when `PULSE_HOME` is set explicitly
(`export PULSE_HOME=$(mktemp -d); pulse --fixtures test/fixtures/broken`) — a fixture snapshot in `~/.pulse` would feed `brief` a false `runtime ✗`.

Real output against the home cluster + fleet (`node dist/index.js`):

```
pulse — k3s default 3/3 nodes · 13 workloads · 26 cronjobs · 13 sites · 1 disks · 1 hosts · 535ms
⚠ prod-host  host   unreachable — ssh: connect to host … port 22: Connection refused  → ssh -v root@…
✓ 10 hosting sites 200 in ≤ 216ms · 3 sites 200 in ≤ 365ms · 13 workloads ready · 26 cronjobs on schedule · 3 nodes Ready · 6 PVCs bound · 1 disks ok
```

Seeded failures (`node dist/index.js --fixtures test/fixtures/broken`):

```
pulse — k3s default 0/1 nodes · 1 workloads · 2 cronjobs · 1ms
✗ assistant/assistant-mcp                  k8s    0/1 ready  → kubectl -n assistant get pods -l app=assistant-mcp
✗ assistant/assistant-mcp-7f9b6c-x2n4      k8s    CrashLoopBackOff (mcp, 7 restarts)  → kubectl -n assistant logs assistant-mcp-7f9b6c-x2n4 -c mcp --previous | squirt
✗ commerce/storefront-sync-tracking  cron   no run for 6h (7 */2)  → kubectl -n commerce describe cronjob storefront-sync-tracking
✗ assistant/assistant-rss-sync             cron   last job Failed 8min ago  → kubectl -n assistant logs job/assistant-rss-sync-29781590 | squirt
✗ node-c                               node   NotReady  → kubectl describe node node-c
✗ crawler/browser-state-pvc            pvc    Pending  → kubectl -n crawler describe pvc browser-state-pvc
```

## Finding schema (fleet contract)

`src/types.ts` `Finding` is the reference shape for the whole personal CLI fleet — brief/snuff/peep/looksy/squirt joins read one shape:

```ts
{ id: string,               // stable across runs; snap/diff key on it
  scope: 'k8s'|'cron'|'node'|'pvc'|'site'|'disk'|'host'|'probe'|'gate'|'visual'|'log',
  severity: 'crit'|'warn'|'ok',
  title: string,             // one line, what is wrong
  detail?: string,
  hint?: string,             // what to do / where to look — every crit/warn has one
  since?: number }           // first-seen epoch ms
```

Id conventions (`<prefix>:<key>`): pulse emits `k8s:<ns>/<name>`, `cron:<ns>/<name>`, `node:<name>`, `pvc:<ns>/<name>`, `site:<url>[:tls|:opsec]`, `disk:<host>:<mount>`, `host:<name>`, `probe:<name>`. Reserved prefixes for other fleet tools, each with its own `scope`: `gate:<key>` (snuff, `scope: 'gate'`), `visual:<key>` (looksy, `scope: 'visual'`), `log:<key>` (squirt diff, `scope: 'log'`). Peep's `sec:`/`seo:`/`email:` checks nest under the `site` finding they're about instead (`site:<url>:opsec`, matching pulse's own `site:<url>:tls`) — they're properties of a site, not a new kind of thing. `domain:`/`artifact:` (pulse Phase 3.5) get their own scopes too once built. Extra render-only keys (`group`, `status`, `latencyMs`) never leave `--json`: `pulse --json | jq '.findings[0] | keys'` → `["hint","id","scope","severity","title"]` (+`detail`/`since` when set).

## Wiring

`.brief.yaml`'s `service: <ns>/<name>` reads `$PULSE_HOME/snaps/last.json` and joins on pulse's
`k8s:<ns>/<name>` / `cron:<ns>/<name>` ids. Only `~/git/assistant/.brief.yaml` has this wired so far
(`service: assistant/assistant-mcp`) — every namespace pulse already watches has a ready-made id:

| repo (`~/git/…`) | namespace  | example id for `service:`                              |
|-------------------|------------|----------------------------------------------------------|
| `assistant`          | `assistant`   | `assistant/assistant-mcp` (wired)                               |
| `commerce`        | `commerce` | `commerce/storefront` (deploy), `commerce/cloudflared`    |
| `crawler`           | `crawler`    | `crawler/enrichment-worker`                                  |
| `acme`              | `syncbot`  | no deploy in-namespace — cronjobs only: `cron:syncbot/acme-sync` |
| `cluster-infra`     | (cluster-wide) | not a single-namespace join — `node:<name>`, `disk:<node>:<mount>` |

`pulse --json | jq -r '.findings[].id'` prints the full current list.

## Install

Node ≥ 20. `npm install -g github:atre/pulse` (or clone + `npm link`). Needs
`kubectl` on PATH for the k8s probe; ssh keys for hosts.
