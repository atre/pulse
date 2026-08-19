---
name: pulse
description: Runtime radar via the globally installed `pulse` CLI — k3s workloads/cronjobs/nodes, prod sites + TLS, disks, hosts. TRIGGER on "is everything up", "what's broken / down", "check the cluster / prod / sites", after a deploy, before touching infra, or when a hub session starts and the pulse hook shows red. SKIP for repo state (brief), tokens (tally), logs content (squirt — use it *after* pulse points at a failing job).
---

# pulse — is it running

```sh
pulse                 # crit → warn → green folded
pulse --brief         # ≤ 12 lines, exit 1 on crit (hooks)
pulse snap pre-deploy && … deploy … && pulse diff pre-deploy
```

1. Lead with `✗` lines; each carries the next command (`kubectl -n … logs job/…`) — run that, pipe logs through `squirt`.
2. Never "fix" from the digest alone; pulse is read-only and so is your first step.
3. Green is folded on purpose — don't ask pulse to list healthy things.
