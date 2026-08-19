# pulse

Runtime radar for the home lab + prod fleet: k3s workloads / cronjobs / nodes,
prod sites (HTTP, TLS days), disks via Prometheus, hosts via ssh. Output is one
compact digest — red first, warnings, green folded — for an AI session (hub
SessionStart hook) or a human. Sibling of `brief` (repos radar) and `tally`
(tokens radar); same contract (see `~/git/hub/TOOLS.md`).

## Stack
- TypeScript 5.x, Node ≥ 20, ESM only. Currently no runtime deps (`kubectl`/ssh via `child_process`, HTTP via `fetch`, TLS via `node:tls`) — not a rule; add a dep when it earns its keep.
- Read-only. Never mutates the cluster or hosts. Nothing leaves the machine except the probes themselves.

## Commands
- `npm run build` / `npm test` / `npm run lint`; `snuff` = definition of done (Stop hook runs it).
- `node dist/index.js` against the real cluster; `--fixtures test/fixtures/<case>` replaces every probe with recorded JSON (tests never touch the network or kubectl).

## Architecture (see PLAN.md for the build order)
- `src/config.ts` — load/validate `~/.config/pulse/config.json` (`--config`), defaults, `$comment` ignored.
- `src/probe/kubectl.ts` — loader: `realKubectl` (`kubectl get <kind> -A -o json`) / `fixtureKubectl` (`<dir>/<kind>.json`); errors are values, never throws.
- `src/probe/k8s.ts` — loader output (deploy, sts, ds, pods, cronjobs, jobs, nodes, pvc) → normalized findings.
- `src/probe/sites.ts` — HTTP status/latency/redirect, TLS days left, `contains` marker.
- `src/probe/prom.ts` — Prometheus HTTP API (`query`) via `--prom` URL or `kubectl port-forward`.
- `src/probe/hosts.ts` — ssh `df -P`, `uptime`, `docker ps --format json`.
- `src/types.ts` — the single `Finding` type: `{ id, scope, severity: 'crit'|'warn'|'ok', title, detail?, hint?, since?, group? }` + config types; `src/findings.ts` — `sortFindings`/`summarize` (severity ordering, counts).
- `src/cron.ts` — schedule → smallest interval / short form; `src/util.ts` — `ago`, `fmtDur`, `pool`, `pkgVersion`.
- `src/render.ts` — text (red first), `--brief`, `--json`, `--md`; `src/snap.ts` — `$PULSE_HOME/snaps/<name>.json` (default `~/.pulse`) + diff + first-seen `state.json`.
- `src/init.ts` — `pulse init --claude`: SessionStart hook wiring; `src/cli.ts` / `src/index.ts` — hand-rolled args, exit code 1 when any `crit` (hook contract).
- `test/fixtures/<case>/` — recorded `kubectl -o json` per kind + `meta.json` (`{now}` = fixture clock) + `config.json` (case config); `test/fixtures/sites.json` / `prom.json` — recorded site/TLS results and Prometheus responses keyed by query (unit tests; a case dir may carry its own `sites.json`/`prom.json`/`hosts.json` for CLI fixture runs). Each probe accepts an injected loader so fixtures drive it.

## Rules
- Every finding must say what to do or where to look (`kubectl -n assistant logs job/…`), not just what is wrong.
- Severity thresholds are config with defaults; never hardcode a domain or namespace in code.
- A probe failure (kubectl unreachable, DNS down) is itself a `crit` finding, never a crash — the digest always renders.
- Timeouts everywhere (`budgets`); the whole run must finish < 10s on the real fleet.
- New probe → fixture case + test + README table row + PLAN checkbox. Usage friction → FEEDBACK.md.
