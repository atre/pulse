import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateHost, parseDf, parseDocker, shortUptime } from '../src/probe/hosts.js';
import type { HostConfig } from '../src/types.js';

const host = (extra: Partial<HostConfig> = {}): HostConfig => ({ name: 'prod-host', ssh: 'root@203.0.113.10', ...extra });

const DF_OK = `Filesystem     1024-blocks     Used Available Capacity Mounted on
/dev/sda1         103080240 30032988  67801932      30% /
tmpfs                  8192        0      8192       0% /dev
overlay           103080240 30032988  67801932      30% /var/lib/docker/overlay2/abc`;

const DF_WARN = `Filesystem     1024-blocks     Used Available Capacity Mounted on
/dev/sda1         103080240 90000000   8000000      88% /data`;

const DF_CRIT = `Filesystem     1024-blocks     Used Available Capacity Mounted on
/dev/sda1         103080240 97000000   3000000      95% /`;

const UPTIME = ' 14:32:01 up 12 days,  3:04,  1 user,  load average: 0.08, 0.03, 0.01';

const DOCKER_OK = `{"Names":"storefront","State":"running","Status":"Up 3 days"}
{"Names":"cloudflared","State":"running","Status":"Up 3 days"}`;

const DOCKER_BAD = `{"Names":"storefront","State":"running","Status":"Up 3 days"}
{"Names":"worker","State":"restarting","Status":"Restarting (1) 5 seconds ago"}
{"Names":"cache","State":"running","Status":"Up 2 hours (unhealthy)"}`;

test('parseDf: skips header, parses capacity + mount', () => {
  assert.deepEqual(parseDf(DF_OK), [
    { mount: '/', usedPct: 30 },
    { mount: '/dev', usedPct: 0 },
    { mount: '/var/lib/docker/overlay2/abc', usedPct: 30 },
  ]);
});

test('parseDocker: one JSON object per line', () => {
  assert.deepEqual(parseDocker(DOCKER_OK), [
    { Names: 'storefront', State: 'running', Status: 'Up 3 days' },
    { Names: 'cloudflared', State: 'running', Status: 'Up 3 days' },
  ]);
});

test('shortUptime: extracts uptime + load average', () => {
  assert.equal(shortUptime(UPTIME), 'up 12 days, 3:04, load 0.08');
});

test('evaluateHost: healthy df/uptime/docker → ok host + ok df findings (/dev pseudo-mount skipped)', () => {
  const stdout = [DF_OK, UPTIME, DOCKER_OK].join('\n---\n');
  const findings = evaluateHost(host(), { stdout });
  assert.deepEqual(
    findings.map((f) => f.id),
    ['host:prod-host', 'host:prod-host:/', 'host:prod-host:/var/lib/docker/overlay2/abc'],
  );
  assert.ok(findings.every((f) => f.severity === 'ok'));
  assert.equal(findings[0].title, 'up 12 days, 3:04, load 0.08');
});

test('evaluateHost: 88% used df → warn', () => {
  const stdout = [DF_WARN, UPTIME, DOCKER_OK].join('\n---\n');
  const findings = evaluateHost(host(), { stdout });
  const df = findings.find((f) => f.id === 'host:prod-host:/data');
  assert.equal(df!.severity, 'warn');
  assert.equal(df!.title, '88% used');
  assert.match(df!.hint!, /ssh root@203\.0\.113\.10 df -h \/data/);
});

test('evaluateHost: 95% used df → crit', () => {
  const stdout = [DF_CRIT, UPTIME, DOCKER_OK].join('\n---\n');
  const findings = evaluateHost(host(), { stdout });
  const df = findings.find((f) => f.id === 'host:prod-host:/');
  assert.equal(df!.severity, 'crit');
  assert.equal(df!.title, '95% used');
});

test('evaluateHost: restarting/unhealthy containers → crit each, healthy container silent', () => {
  const stdout = [DF_OK, UPTIME, DOCKER_BAD].join('\n---\n');
  const findings = evaluateHost(host(), { stdout });
  const worker = findings.find((f) => f.id === 'host:prod-host/worker');
  const cache = findings.find((f) => f.id === 'host:prod-host/cache');
  assert.equal(worker!.severity, 'crit');
  assert.equal(worker!.title, 'restarting — Restarting (1) 5 seconds ago');
  assert.equal(cache!.severity, 'crit');
  assert.match(worker!.hint!, /docker logs worker --tail 50/);
  assert.equal(findings.find((f) => f.id === 'host:prod-host/storefront'), undefined);
});

test('evaluateHost: ssh failure → warn "unreachable", hosts are optional', () => {
  const findings = evaluateHost(host(), { error: 'Connection timed out' });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'warn');
  assert.equal(findings[0].title, 'unreachable — Connection timed out');
});

test('evaluateHost: checks limits which sections run', () => {
  const stdout = [DF_OK].join('\n---\n');
  const findings = evaluateHost(host({ checks: ['df'] }), { stdout });
  assert.deepEqual(
    findings.map((f) => f.id),
    ['host:prod-host', 'host:prod-host:/', 'host:prod-host:/var/lib/docker/overlay2/abc'],
  );
  assert.equal(findings[0].title, 'reachable');
});
