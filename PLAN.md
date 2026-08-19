# pulse — plan (agent-runnable)

**Goal:** `pulse` prints one AI-readable digest answering "is everything running?"
for: k3s (workloads, cronjobs, nodes, PVCs), prod sites (HTTP + TLS), disks (Prometheus),
hosts (ssh). Red first, green folded, < 10 s, exit 1 on crit.

**How to run this plan (for the implementing agent):**
1. Read `CLAUDE.md` first (stack, rules, architecture). Read `~/git/hub/TOOLS.md` for the fleet contract. Look at `~/git/brief/src` for the house style (hand-rolled args, `render.ts`, fixture tests with `node:test`, no deps).
2. Work phase by phase, in order. Inside a phase, do the tasks top-down. Tick `[x]` here as you go.
3. Every task lists its **files**, **behaviour**, and **accept** (a check you must run and see pass). Do not move on while an accept check fails.
4. Tests never touch kubectl/network: every probe takes an injected loader; fixtures live in `test/fixtures/<case>/`. Record real fixtures with the commands given (the cluster is reachable from this laptop; `kubectl config current-context` = `default`).
5. Definition of done for any step: `snuff` green (`npm run lint && npm test && npm run build`). The Stop hook runs it.
6. Do not `git commit`/`push` unless the user says so. Append friction/ideas to `FEEDBACK.md`.
7. Keep output discipline: a line must change what the reader does. Counts before lists, sample before dump. When unsure, print less.

**Real environment facts (verified 2026-08-16):**
- k3s, context `default`, nodes `node-a` (control-plane, 192.0.2.202), `node-b`, `node-c`. Namespaces: default, commerce, assistant, syncbot, monitoring, gateway, postgres, registry, crawler (+ kube-*).
- Workloads (deploy): commerce/cloudflared, commerce/storefront, assistant/assistant-dashboard, assistant/assistant-mcp, assistant/assistant-telegram (0/0 — intentional), monitoring/{grafana,kube-state-metrics,prometheus}, gateway/gateway, postgres/postgres, registry/registry, crawler/enrichment-worker (0/0 — intentional). node-exporter DaemonSet in monitoring.
- CronJobs (11): commerce/storefront-{abandoned-carts */15, cleanup-review-images daily, sync-tracking 7 */2}, assistant/assistant-{digest daily, github-trending daily, news-sync */30, rentals-classify (SUSPENDED), rss-sync */15}, syncbot/acme-{persons hourly, sync */3}, postgres/pg-backup daily.
- Prometheus at `monitoring/svc/prometheus` (port 9090), node-exporter on all nodes → `node_filesystem_avail_bytes`. No cert-manager, no metrics-server assumed.
- Prod is NOT on k3s: storefront.example on Hetzner cx23 (203.0.113.10) via cloudflared, staging.storefront.example = LAN cluster; mysite.example; 10 hosting domains (Hetzner, Compose+Caddy): oss1.example oss2.example oss3.example oss4.example oss5.example oss6.example oss7.example oss8.example oss9.example oss10.example. Ingress hosts on LAN: storefront.home.arpa, grafana.home.arpa.

---

## Phase 0 — scaffold (done)
- [x] package/tsconfig/CI/snuff/Stop hook/skill/README/CLAUDE.md, `examples/config.json`, help stub, placeholder test.

## Phase 1 — core digest: config + k8s + sites (v0.1)

### 1.1 Types and findings model
- **files:** `src/types.ts`, `src/findings.ts`
- **behaviour:** `Finding = { id: string; scope: 'k8s'|'cron'|'node'|'pvc'|'site'|'disk'|'host'|'probe'; severity: 'crit'|'warn'|'ok'; title: string; detail?: string; hint?: string; since?: number }`. `id` is stable across runs (e.g. `cron:assistant/assistant-rss-sync`, `site:https://storefront.example/`) — snap/diff keys on it. `sortFindings()` = crit → warn → ok, then by scope, then id. `summarize(findings)` = counts per scope+severity for the header line.
- **accept:** `test/findings.test.ts` — sorting and summary counts.
- [x] done

### 1.2 Config
- **files:** `src/config.ts`, `examples/config.json` (already there — keep in sync)
- **behaviour:** `loadConfig(path?)`: default `~/.config/pulse/config.json`, `--config` override, `PULSE_CONFIG` env. Missing file → empty config with defaults (every probe skipped, digest says `no config — copy examples/config.json to ~/.config/pulse/config.json`). Validate shape minimally; unknown keys ignored; `$comment` ignored. Defaults: `budgets` = `{ siteTimeoutMs: 8000, kubectlTimeoutS: 8, sshTimeoutS: 8, concurrency: 8 }`; `k8s.ignoreNamespaces` = kube-system/kube-public/kube-node-lease; `k8s.cronjobs.maxMissedRuns` = 2; site `expect.status` default 200, `tlsDaysMin` default 14.
- **accept:** `test/config.test.ts` — defaults applied; `$comment` ignored; missing file → `{ probes: [] }`-style empty; bad JSON → throws with the path in the message.
- [x] done

### 1.3 kubectl loader + fixtures
- **files:** `src/probe/kubectl.ts`, `test/fixtures/lab/*.json`
- **behaviour:** `kubectlJson(kind, opts)` runs `kubectl get <kind> -A -o json --request-timeout=<budget>s [--context …]` via `execFile`, returns parsed `items[]`; on non-zero exit / timeout returns `{ error: string }` — the caller turns that into a `probe` crit finding ("kubectl unreachable: <first stderr line> → check VPN/kubeconfig"). Loader is an injectable function `(kind) => Promise<Items|{error}>` so fixtures replace it.
- **record fixtures** (run once, commit the JSON, strip `managedFields`):
  `for k in deployments statefulsets daemonsets pods cronjobs jobs nodes persistentvolumeclaims; do kubectl get $k -A -o json | jq 'del(.items[].metadata.managedFields)' > test/fixtures/lab/$k.json; done`
  Then hand-edit a copy `test/fixtures/broken/` to contain: one deployment 0/1 (not in scaledToZeroOk), one pod CrashLoopBackOff with restartCount 7, one cronjob whose last job failed, one cronjob with `lastScheduleTime` 3 intervals ago, one node NotReady, one PVC Pending. Keep the files small (delete unrelated items).
- **accept:** `node -e` smoke that loads `test/fixtures/lab/deployments.json` and prints item count; `--fixtures <dir>` flag wired in cli (Phase 1.7) drives all k8s probes from that dir.
- [x] done — lab recorded 2026-08-16 (26 cronjobs in reality: 15 extra suspended crawler/scrape-*; `<ns>/*` wildcard added to cronjobs.override). Fixture dirs carry `meta.json` (fixed `now`) + `config.json` so fixture runs stay deterministic as wall-clock moves.

### 1.4 k8s probes → findings
- **files:** `src/probe/k8s.ts`, `src/cron.ts` (schedule math), `test/k8s.test.ts`
- **behaviour (each rule = one Finding, ids stable):**
  - workloads (deploy/sts/ds): `ready < desired` → crit `k8s:<ns>/<name>` "2/3 ready" + hint `kubectl -n <ns> get pods -l …` (use `spec.selector.matchLabels` to build `-l k=v,k=v`). `desired == 0` → ok if listed in `scaledToZeroOk`, else warn "scaled to 0 (add to scaledToZeroOk if intended)".
  - pods: phase Pending > 5 min → warn; any container `waiting.reason` in {CrashLoopBackOff, ImagePullBackOff, ErrImagePull, CreateContainerConfigError} → crit with hint `kubectl -n <ns> logs <pod> -c <container> --previous | squirt`; `restartCount ≥ 5` in last hour (use `lastState.terminated.finishedAt`) → warn. Completed/Succeeded pods ignored.
  - cronjobs: `spec.suspend` → warn "suspended" (ok if `override[..].suspendedOk`). Interval = `intervalMinutes(schedule)` in `src/cron.ts`: support `*/N` in minute field, `N */M` hours, fixed daily/hourly (`M H * * *`, `M * * * *`), and lists/ranges by taking the smallest gap; unknown → 24h. Missed = `(now - lastScheduleTime) / interval`; `> maxMissedRuns` → crit "no run for 47min (*/15)". Last job (from jobs.json, ownerReferences → cronjob, newest by `status.startTime`): `failed > 0` or condition Failed → crit "last job Failed 18min ago" + hint `kubectl -n <ns> logs job/<job> | squirt`; `active` job older than 2× interval → warn "running 40min (*/15) — stuck?".
  - nodes: any `Ready != True` → crit; `MemoryPressure|DiskPressure|PIDPressure == True` → warn; hint `kubectl describe node <n>`.
  - pvc: phase != Bound → crit.
  - Every probe returns findings only for the namespaces not in `ignoreNamespaces`.
- **accept:** `test/k8s.test.ts` against `fixtures/lab` → 0 crit, warns only for known 0/0 workloads when `scaledToZeroOk` empty, 0 when set; against `fixtures/broken` → exactly the 6 seeded findings with correct severities and hints containing `kubectl -n`. `test/cron.test.ts` → `*/15`=15, `7 */2 * * *`=120, `45 6 * * *`=1440, `17 * * * *`=60, `27 7-23/4 * * *`=240, garbage=1440.
- [x] done

### 1.5 sites probe
- **files:** `src/probe/sites.ts`, `test/sites.test.ts`
- **behaviour:** for each `sites[]` entry, concurrently (budget `concurrency`): `fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(siteTimeoutMs), headers: { 'user-agent': 'pulse/<ver>' } })`. Record status, latency, `location` on 3xx. Follow up to 3 redirects manually; final status must be in `expect.status` (number or array; default `[200]`) else crit `site:<url>` "503 in 1200ms" (hint: `peep check <host>` for OPSEC/SEO, `curl -sI <url>`); `> 3000 ms` → warn "slow 3.4s". `expect.contains` missing from body → crit "marker not found". TLS: `tls.connect(443, host, { servername: host })` → `getPeerCertificate().valid_to` → days left; `< tlsDaysMin` → warn, `< 3` → crit, expired → crit. Network error → crit with the error code (`ENOTFOUND`, `ECONNREFUSED`, timeout). `lan: true` sites: failures downgrade to warn "unreachable (LAN)" so a session off-network isn't all red. `group` only affects rendering (fold "10 hosting sites 200 in ≤ 420ms").
  Loader injection: `probeSite = (site) => Promise<SiteResult>`; fixtures for tests are plain result objects (`test/fixtures/sites.json`) — no network in tests.
- **accept:** `test/sites.test.ts` — status mismatch → crit, slow → warn, TLS 12d with min 14 → warn, 2d → crit, `lan` unreachable → warn, group folding count in render (Phase 1.6).
- [x] done — TLS findings get their own id (`site:<url>:tls`) so snap/diff tracks cert decay separately from reachability.

### 1.6 render
- **files:** `src/render.ts`, `test/render.test.ts`
- **behaviour:**
  - header: `pulse — k3s <ctx> <readyNodes>/<nodes> nodes · <n> workloads · <n> cronjobs · <n> sites · <n> disks · <ms>` (omit sections not configured).
  - then all `crit` lines `✗ <id-ish>  <scope>  <title>  → <hint>`, then `warn` lines `⚠ …`, aligned columns (pad id to the longest shown, cap 34 chars). One line per finding; `detail` on a second indented line only in full mode.
  - green: one folded line `✓ …` with grouped counts: `10 hosting sites 200 in ≤ 420ms · 9 workloads ready · 9 cronjobs on schedule · 3 nodes Ready`. Never list green items individually (`--all` does).
  - `--brief`: header + crit + warn only, hard cap 12 lines (`… +N more, run pulse`), no green line when there is nothing red ("all green" one-liner is allowed only when there are zero findings — otherwise silence is fine for a hook: print nothing, exit 0).
  - `--json`: `{ ts, config: <path>, findings: Finding[], summary }`; `--md`: header + a table `| sev | scope | id | title | hint |`.
  - `--tokens N`: cap the text output by trimming warn lines first, then crit hints (never drop a crit line).
- **accept:** `test/render.test.ts` — ordering, folding line, brief cap at 12, `--tokens` never drops crit.
- [x] done

### 1.7 CLI + entry + exit code
- **files:** `src/cli.ts`, `src/index.ts`
- **behaviour:** flags `--config <f> --fixtures <dir> --brief --json --md --all --tokens N --only <scope|substr> --context <k8s ctx> -h -v`; subcommands `snap`, `diff`, `init` (Phase 2). Runs probes concurrently (k8s kinds in parallel, sites in parallel), total wall-clock printed in header. Exit code: 1 if any crit (also in `--json`), 0 otherwise; probe errors are crit findings, so an unreachable cluster exits 1 with a clear line, never a stack trace.
- **accept:** `node dist/index.js --fixtures test/fixtures/broken` → 6 ✗/⚠ lines, exit 1; `--fixtures test/fixtures/lab` → exit 0, ≤ 6 lines; real run `node dist/index.js` completes < 10 s and matches reality (compare with `kubectl get pods -A | grep -v Running`). Update README usage block from real output.
- [x] done — real run 916ms against `--config examples/config.json` (no `~/.config/pulse/config.json` yet — that's 1.8), all green, matches `kubectl get pods -A` (no non-Running/Completed pods).

### 1.8 install + hub hook + FEEDBACK
- **behaviour:** `npm link`; `ln -sfn ~/git/pulse/skills/pulse ~/.claude/skills/pulse`; add to `~/git/hub/.claude/settings.json` SessionStart (before brief): `command -v pulse >/dev/null 2>&1 || exit 0; pulse --brief 2>/dev/null` with `timeout: 20`; keep the hub SessionStart total ≤ ~60 lines (brief `--top 8` + tally tail + pulse `--brief`). Copy `examples/config.json` → `~/.config/pulse/config.json` and edit to reality. Append a dated section to `FEEDBACK.md` with the first real run's friction.
- **accept:** open a new hub session (or run the hook command by hand) → pulse lines appear only when something is red/warn.
- [x] done — `npm link` ok, skill symlinked, `~/.config/pulse/config.json` installed from `examples/config.json`, hub SessionStart hook wired before `brief` (silent — all green), `FEEDBACK.md` has the first-run section.

## Phase 2 — disks, hosts, snapshots, self-installing hook

### 2.1 Prometheus disks
- **files:** `src/probe/prom.ts`, `test/prom.test.ts`
- **behaviour:** query `node_filesystem_avail_bytes{mountpoint="<mount>"}` and `_size_bytes` per configured disk (`instance` matched by substring on the `instance`/`nodename` label). URL: `prometheus.url` if reachable within 2 s, else if `portForward` set → spawn `kubectl -n <ns> port-forward svc/<name> <local>:<port>` on an ephemeral local port, query, kill (always kill, also on error). `usedPct ≥ critPct` → crit `disk:<instance>:<mount>`; `≥ warnPct` → warn; unreachable Prometheus → warn (not crit — the cluster probe already covers liveness). Also `up == 0` node-exporter targets → warn.
- **accept:** fixture = recorded Prometheus API JSON responses; tests via injected `query(expr)`; real run shows `node-a:/mnt/ssd NN%`.
- [x] done — real node-exporter labels have no name in `instance` (`<ip>:9100`); the k8s node name is in `node` (k3s SD relabel), not `nodename` as PLAN guessed — `instanceMatches` checks `instance`/`node`/`nodename` all three.

### 2.2 hosts via ssh
- **files:** `src/probe/hosts.ts`
- **behaviour:** `ssh -o BatchMode=yes -o ConnectTimeout=<sshTimeoutS> <ssh> 'df -P; echo ---; uptime; echo ---; docker ps --format "{{json .}}" 2>/dev/null'` in one round-trip; parse: any `df` line ≥ warnPct → warn/crit `host:<name>:<mount>`; `docker ps` containers with `State != running` or `Status` containing `Restarting|unhealthy` → crit `host:<name>/<container>`; ssh failure → warn "unreachable" (hosts are optional). `checks[]` limits which parts run.
- **accept:** parser tests on captured text; real run against `prod-host`.
- [x] done — real run against `prod-host` correctly downgraded a dead ssh connection to warn instead of crashing/crit.

### 2.3 snap / diff
- **files:** `src/snap.ts`
- **behaviour:** `pulse snap [name=last]` writes `~/.pulse/snaps/<name>.json` (findings + ts). `pulse diff [name=last]` runs live and prints `new` (ids not in snap), `resolved` (in snap, now ok/absent), `changed` (severity moved), unchanged count. Every plain `pulse` run also writes `last` automatically so `since:` on a finding = first time it was seen (persist `firstSeen` per id in `~/.pulse/state.json`; render `since 2d` on crit lines).
- **accept:** tests with two fixture dirs; `pulse diff` after breaking a fixture shows the new crit.
- [x] done — `pulse snap`/`pulse diff` wired as real subcommands (not fixture-only); every plain real run also writes `last` and updates `~/.pulse/state.json` for `since`.

### 2.4 `pulse init --claude`
- **files:** `src/init.ts` (copy the idempotent merge from `~/git/brief/src/init.ts`)
- **behaviour:** merges the SessionStart hook (`pulse --brief`, timeout 20) into `<dir>/.claude/settings.json` (default cwd; `--global` → `~/.claude/settings.json`); prints what it did; `--print` previews.
- **accept:** test = merge idempotent; running twice → "already wired".
- [x] done — `--global` and `--print` added beyond the original spec (mirrors `brief`'s init but targets `~/.claude/settings.json` too).

## Phase 3 — integrations (only after Phase 1–2 are in daily use)
**Status (2026-08-18): gate still not formally lifted (< 2 weeks dogfooding), but 2 of 5 items shipped anyway** — `brief` join and LAN TLS secrets were let through because both are free/opt-in (join reuses existing snap output; TLS is off by default via `k8s.tlsSecrets`), not because the gate criterion was met. `--opsec`, weekly report, `--watch`, domain-expiry stay parked until real usage justifies them (see Fleet review "Park" line below) — those add new external calls or scheduled surface, so the gate applies in full there.
Also blocked on external readiness, not just usage: `--opsec`/domain-expiry need `peep check
--format json` to actually exist with the `{passed, failures[]}` / `expiresIn` shape
assumed below — verified 2026-08-17: `peep check <d> --format json` → `{passed, failures[], notes, scanResult}` ✓ (peep 0.3.0); `whois.expiresIn` ships in `peep scan -j` (not `check`) ✓; brief's `.brief.yaml service:` join is shipped (brief 0.2.0, `src/runtime.ts`) ✓ and already in use.
- [x] `brief` join: `.brief.yaml` `service: assistant/assistant-mcp` in a repo → brief shows `runtime ✗` from `~/.pulse/snaps/last.json` (brief PLAN has the matching item). → files: pulse side is only Phase 2.3's `src/snap.ts` writing `~/.pulse/snaps/last.json` `{ts, findings}` on every plain run (ids stay `k8s:<ns>/<name>` / `cron:<ns>/<name>` / `site:<url>`); the consumer lives in `~/git/brief` (Phase 1.6 pulse-join item: `.brief.yaml` `service:`, `src/runtime.ts`); README "Wiring" row here · accept: `export PULSE_HOME=$(mktemp -d); pulse --fixtures test/fixtures/broken; jq -r '.findings[] | select(.id | startswith("k8s:")) | .severity' $PULSE_HOME/snaps/last.json` prints at least one line (fixture runs write `last.json` too; `PULSE_HOME` isolates them from `~/.pulse`); `brief assistant` then shows a `runtime` tag (asserted by brief's own test). decide: no code beyond 2.3 in pulse; tick when brief's item passes. ✓ 2026-08-17: fixture run → 2 `k8s:` crit in `$PULSE_HOME/snaps/last.json`; `~/git/assistant/.brief.yaml` `service: assistant/assistant-mcp` added → `brief assistant` shows `runtime: ✓`.
- [ ] `peep check` results folded in as site findings when `--opsec` (reuse `peep check --json`, no reimplementation). → files: `src/cli.ts` (`--opsec` flag; in `--fixtures` mode read `<dir>/peep.json` when present), new `src/probe/opsec.ts` (`probeOpsec(sites, budgets, run = realPeep)`: for each non-`lan` site host run `peep check <host> --format json` (`execFile`, timeout `siteTimeoutMs * 2`, `pool` concurrency), parse `{passed, failures[]}`; `passed === false` → warn `site:<url>:opsec` title `peep: N issues — <first failure ≤ 60 chars>` hint `peep check <host>`; peep missing / exit > 1 / bad JSON → one warn `probe:peep` "peep unavailable — npm i -g github:atre/peep"), `test/fixtures/peep.json` (`{"<host>": {passed, failures}}` recorded from a real `peep check`), new `test/opsec.test.ts`, README probe table row · accept: injected runner returning `{passed:false, failures:['HTTP 526 — …','Security score 40/100 …']}` for `storefront.example` → exactly one warn with id `site:https://storefront.example/:opsec` and title starting `peep: 2 issues`; `passed:true` → one ok finding; runner throwing → single `probe:peep` warn, no crit. decide: opsec is warn only — the deploy gate stays peep's job.
- [x] cert expiry for LAN `*.home.arpa` via the k3s TLS secrets (`kubectl get secret -A -o json` → x509 parse with `node:crypto` `X509Certificate`). → files: `src/probe/kubectl.ts` (kind `secrets` fetched with `--field-selector type=kubernetes.io/tls`, only when `k8s.tlsSecrets` is true), `src/probe/k8s.ts` (`tlsSecretFindings(items, now, tlsDaysMin)`: `Buffer.from(data['tls.crt'], 'base64')` → `new X509Certificate(pem).validTo` (`node:crypto`); id `tls:<ns>/<name>`, title `expires in 2d (cn=grafana.home.arpa)`; warn `< tlsDaysMin`, crit `< 3` or expired, hint `kubectl -n <ns> get secret <name> -o yaml`), `src/config.ts` + `src/types.ts` (`k8s.tlsSecrets: boolean` default false, `k8s.tlsDaysMin` default 14), fixtures `test/fixtures/lab/secrets.json` (record: `kubectl get secret -A --field-selector type=kubernetes.io/tls -o json | jq 'del(.items[].metadata.managedFields)'`) and `test/fixtures/broken/secrets.json` (one secret whose cert comes from `openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=grafana.home.arpa`), `test/k8s.test.ts`, README table row · accept: broken fixture → one crit `tls:<ns>/<name>` with title containing `expires in`; lab fixture → no `tls:` finding below ok; with `tlsSecrets: false` the loader is never asked for `secrets` (spy assertion). ✓ 2026-08-18: done — real cluster surprise: only one `kubernetes.io/tls` secret exists cluster-wide (`kube-system/k3s-serving`), and it's filtered out by default `ignoreNamespaces`; none of the `.home.arpa` ingress hosts (grafana/storefront) have their own TLS secret (no cert-manager, per this file's own environment notes), so real-world coverage today is zero until someone issues per-host certs into the cluster. `probeK8s` now fetches `secrets` as one more opt-in kind (added to the fetch list only when `cfg.tlsSecrets`), so real `pulse` runs pick this up automatically once a config sets `tlsSecrets: true` — no `cli.ts` changes needed, matching the PLAN bullet's own file list.
- [ ] weekly `pulse --md > reports/YYYY-WW.md` in this repo; no external targets. → files: `package.json` (script `report`: `mkdir -p reports && node dist/index.js --md > reports/$(date +%G-W%V).md`), `reports/.gitkeep`, README Wiring row · accept: `npm run report` creates `reports/2026-W33.md` (today) whose first line starts with `# pulse —` (`renderMd` header). decide: no scheduler in code — invoked by hand or the `/weekly` skill.
- [ ] `--watch` (re-run every N s, redraw) — only if a real need shows up; not a dashboard. → files: `src/cli.ts` (`--watch [N]` seconds, default 30; loop: `\x1b[2J\x1b[H`, run once, print, `setTimeout`; SIGINT → exit 0; `--watch` with `--json`/`--md`/`--brief` → `{exit: 2, out: '--watch is text-only'}`), no probe changes, README usage line · accept: `parseArgs(['--watch','5']).watch === 5`; `parseArgs(['--watch']).watch === 30`; `parseArgs(['--watch','--json'])` → `exit: 2`; manual: `pulse --watch 5 --fixtures test/fixtures/broken` redraws every 5 s and Ctrl-C exits 0. decide: build only when a real need appears — this is the spec for that day.

## Phase 3.5 — silent-failure classes (2026-08-16 hub deep-think #2, ranked)
- [ ] **Backup / artifact freshness** — what: config `artifacts: [{name: 'pg-backup', kind: 'ssh'|'s3'|'local', host?, path|bucket+prefix, maxAgeH: 26, minBytes?: 1000}]`; probe lists the newest object (`ssh <host> 'ls -t --time-style=+%s <path> | head -1'`, `aws s3api list-objects-v2 --prefix … --query 'sort_by(Contents,&LastModified)[-1]'` or `rclone lsjson`, local `statSync`) → crit `artifact:<name>` "newest 3d old (max 26h)" / "0 bytes"; unreachable store → warn; why: a cronjob that runs and writes nothing (or a 0-byte dump) is the classic silent failure — the `cron:` probe only proves the job exited 0; → files: `src/probe/artifacts.ts` (injectable lister), `src/config.ts` + `src/types.ts` (`scope: 'artifact'`), `examples/config.json`, `test/artifacts.test.ts` (fixture = lister output text), README probe table row · accept: fixture newest = now-3d, maxAgeH 26 → crit with title matching `/3d old/`; size 0 with `minBytes` → crit `0 bytes`; lister throws → warn `unreachable`. decide: first real target = the k3s `postgres/pg-backup` destination — record where it writes before implementing (`kubectl -n postgres get cronjob pg-backup -o yaml | grep -A3 args`).
- [ ] **Domain expiry** — what: for each unique registrable domain in `sites[]`, `peep scan <domain> --only whois -j` (NOT `peep check` — it skips whois and nests everything under `scanResult`; verified 2026-08-17) → `whois.expiresIn` days (shipped in peep 0.3.0); `< 30` warn, `< 7` crit `domain:<name>`; peep missing → one warn `probe:peep`; runs at most once per 24 h (cache under `~/.pulse/whois/<domain>.json` with ts) so the SessionStart hook never waits on WHOIS; why: TLS is watched, the domain under it is not — a lapsed domain is the one outage nothing else warns about; → files: `src/probe/domains.ts` (reuse the runner shape from the `--opsec` item; share the peep spawn assistant), `src/config.ts` (`domains.expiryDaysWarn` 30 / `Crit` 7, `domains.enabled` default true when peep on PATH), `test/domains.test.ts` (fixture = peep JSON) · accept: fixture `expiresIn: 5` → crit `domain:example.com` title `expires in 5d`; cached file younger than 24 h → runner not called (spy). peep 0.3.0 ships `whois.expiresIn` — dependency met.
- [ ] **Degradation-not-exit workloads** (surfaced 2026-08-18, `~/git/streamer` dogfooding: `pulse snap/diff` stayed 100% clean across a deploy while `streamgen.service` on `node-a` was audibly stuttering — ffmpeg logged 29× `Resumed reading ... after a lag of ~6s`, unit stayed `active` the whole time) — what: config `streamServices: [{name: 'streamgen', host: 'node-a', unit: 'streamgen.service', badPatterns: ['lag of', 'Resumed reading', 'End of file'], windowMin: 10}]`; probe (ssh, reuse `hosts.ts` connection shape) runs `systemctl is-active <unit> && journalctl -u <unit> --since "-<windowMin>min" | grep -c -E '<badPatterns joined>'` (+ `vcgencmd get_throttled` where available, `& 0xF` != 0 → warn "throttled"); unit inactive → crit, bad-pattern count > 0 → warn `stream:<name>` "N × lag/drop in last <window>m"; why: a 24/7 broadcast's failure mode is degradation, not exit — `is-active` and the existing k8s/host probes are blind to it by design; → files: `src/probe/stream.ts` (injectable runner, same shape as `hosts.ts`), `src/config.ts` + `src/types.ts` (`scope: 'stream'`), `test/stream.test.ts` (fixture = captured journalctl text), README probe table row · accept: fixture journal with 3 matching lines, unit active → warn `stream:<name>` title matching `/3 × /`; unit inactive → crit; no matches → ok. decide: first real target is `streamgen` on `node-a` — do not build until a second real degrade-not-exit case shows up elsewhere in the fleet (rule stays: no new emitter without a second real need, same bar as artifact/domain items above).
- [x] **Fleet Finding schema is defined here** — what: `src/types.ts` `Finding` is the reference shape for the whole fleet (`id`, `scope`, `severity`, `title`, `detail?`, `hint?`, `since?`); document it in README under "Finding schema" with the id conventions (`k8s:<ns>/<name>`, `cron:…`, `site:<url>[:tls|:opsec]`, `disk:…`, `host:…`, `artifact:…`, `domain:…`, and the reserved external scopes `gate:` (snuff), `seo:`/`sec:`/`email:` (peep), `visual:` (looksy), `log:` (squirt diff)); why: brief/snuff/peep/looksy joins are only cheap if there is one shape to read; → files: README, `src/types.ts` (comment), hub `TOOLS.md` contract line (done in this deep-think) · accept: README section exists; `pulse --json | jq '.findings[0] | keys'` prints exactly the documented keys. ✓ 2026-08-17: README "Finding schema (fleet contract)" section; `jq keys` → hint,id,scope,severity,title.

## Fleet review 2026-08-17 (hub TOOLS.md Round 4) — this section is the queue

Verdict: **1 day old** — real run green in 0.6 s, one real host finding found and fixed (ssh alias), state `firstSeen {}` (unproven), 0 real invocations outside hub. Phase 3 gate stays closed until 2 weeks of dogfooding.
- [x] **`Scope` union gains `gate | visual | log`** — squirt emits `log`, snuff will emit `gate`, looksy `visual`; the README schema says one shape but the TS type disagrees. `hygiene/gold`
- [x] **LAN TLS secrets** (Phase 3 item above) — promote: cheap, cert expiry is the core remit, no external dependency. `pull` — done ✓ 2026-08-18 (line above).
- [x] **`.brief.yaml service:` coverage** — list the ids pulse emits per repo (`pulse --json | jq`) in README "Wiring" so brief's join covers commerce/crawler/cluster-infra, not only assistant. `pull`
- [x] **Fixture isolation** — done 2026-08-17: fixture runs write `last.json` only under an explicit `PULSE_HOME` (a fixture snapshot fed brief a false `runtime ✗`).
- [x] **`pulse snap <name>` should print the paired `pulse diff <name>`** — surfaced 2026-08-18 (`~/git/streamer` dogfooding: a 20-minute deploy in between made the exact invocation worth a scroll-back). `src/cli.ts:120` prints the write path only; add a second line `run "pulse diff${name === 'last' ? '' : ` ${name}`}" after` right below it. `pull`
Park (trigger = 2 weeks of daily reads + a real red): `--opsec` via peep, domain expiry, artifact freshness, weekly report; cut: `--watch`. Rule: no new emitter/consumer pair until a consuming test exists.

## Non-goals
- No daemon, no alerting, no metrics storage — Prometheus/Grafana already exist for that; pulse is the AI-readable front page.
- No writes to cluster/hosts. JSON config (unambiguous; a YAML dep is fine if it ever helps).

## Acceptance for "v0.1 done" (Phase 1 complete)
- `pulse` real run < 10 s, exit code correct, output ≤ 20 lines when 2–3 things are wrong.
- `pulse --fixtures test/fixtures/broken` reproduces every rule in 1.4/1.5 in tests; `snuff` green; CI green on 20/22/24.
- Hub SessionStart shows pulse only when red/warn; `FEEDBACK.md` has the first-run section; README usage block is real output.
