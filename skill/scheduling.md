# Scheduling

> A scheduler runs your agent on a timer and re-invokes it forever. The whole discipline is: **do one
> cycle, exit cleanly, and never let a transient blip turn into a 3am page.**

Read this when putting an agent on cron, systemd timers, GitHub Actions, or serverless cron, or when a
long-running bot keeps dying and you're deciding between a daemon and a scheduled job.

## Two execution models, pick deliberately

| Model | One-cycle-per-run (scheduled) | Long-running daemon |
|-------|-------------------------------|---------------------|
| Shape | Process starts → does one cycle → exits | Process stays up, loops internally |
| Restart | Scheduler re-invokes you | You need a supervisor (systemd, pm2, k8s) |
| State | Must persist between runs (file/Redis/DB) | Can hold state in memory |
| Failure | Crash = one skipped cycle, next run recovers | Crash = downtime until supervisor restarts |
| Best for | Periodic jobs: rebalances, sweeps, keepers, reports | Latency-sensitive: mempool watching, instant reactions |

**Default to one-cycle-per-run.** It's dramatically more robust: no memory leaks accumulate, every cycle
starts clean, and the scheduler is your supervisor. Use a daemon only when you genuinely need sub-second
reaction or a persistent subscription that's expensive to re-establish each run.

## The one-cycle contract

A scheduled agent must obey four rules. Violate any and the scheduler turns against you:

### 1. Do exactly one cycle, then exit

No internal `while(true)`. Start, work, stop. The scheduler owns the cadence.

### 2. Prevent overlap with a lock

If a cycle can outlast the interval, two copies will run and double-act. Acquire a TTL lock at the top;
a benign skip exits 0 (see [idempotency.md](idempotency.md)).

```ts
const lease = await lock.acquire("agent-cycle", { ttlMs: 120_000 }); // TTL > worst-case cycle time
if (!lease) { log.info("prior cycle running, skip"); process.exit(0); }
```

### 3. Exit 0 on transient failure, non-zero only on real breakage

This is the rule that saves your sleep. Schedulers (and humans) treat non-zero as "something is broken,
alert me." A transient RPC 429 or a single failed send is **not** broken, it's Tuesday.

```ts
try {
 await cycle();
 process.exit(0);
} catch (e) {
 if (isTransient(e)) { log.warn({ e }, "transient, will retry next cycle"); process.exit(0); }
 log.error({ e }, "non-recoverable"); await alert(e); process.exit(1); // genuine breakage → page
}
```

> Real-world pattern: a Crucible bot that **always exits 0**, logging errors instead of throwing, so the
> scheduler never alarms on transient faults, and a *separate* monitor (see [monitoring.md](monitoring.md))
> watches outcomes (did TVL change? did any cycle act?) rather than exit codes. Decouple "the process
> ran" from "the work succeeded."

### 4. Bound the run with a timeout

A hung RPC call can wedge a cycle forever, holding the lock and blocking all future runs. Wrap the
cycle in a hard deadline:

```ts
await Promise.race([
 cycle(),
 sleep(90_000).then(() => { throw new TimeoutError("cycle exceeded 90s"); }),
]);
```

## Picking an interval

- **Match the chain, not the clock.** Slots are ~400ms; `confirmed` lands in ~1–2s. Polling faster than
 state changes just burns rate limit ([rate-limiting.md](rate-limiting.md)).
- **Stagger fleets.** Don't run 24 agents at `* * * * *` on the same RPC key, add per-agent offset/jitter.
- **Align to the work.** Funding sweeps hourly, rebalances per-epoch or on a price-move trigger, reports
 daily. Don't run a 5-minute job every minute.

## Platform specifics

```bash
# cron, capture output, append to a log the monitor reads. */5 = every 5 min.
*/5 * * * * cd /opt/agent && /usr/bin/node dist/index.js >> /var/log/agent.log 2>&1
```

```ini
# systemd timer, preferred over cron on Linux: gives you OnFailure hooks, journald logs, RuntimeMaxSec.
# agent.service (Type=oneshot) + agent.timer (OnUnitActiveSec=5min). RuntimeMaxSec enforces rule 4.
```

- **GitHub Actions cron**: dead-simple for low-frequency jobs (≥5 min; runners are best-effort, can
 delay/skip, fine for sweeps/reports, not for latency-sensitive keepers). Secrets via Actions secrets.
- **Serverless cron** (Vercel Cron, AWS EventBridge → Lambda, Cloudflare Cron Triggers): great for
 one-cycle jobs; mind the **execution time limit** (rule 4 is enforced for you) and **cold starts**
 (re-establishing RPC connections each run, cache nothing across invocations).

## Daemon mode (when you must)

If you need a persistent process, you've taken on supervision yourself:

- Run under **systemd** (`Restart=always`, `RestartSec`) / **pm2** / a **k8s Deployment** with liveness probes.
- Add an **internal watchdog**: if the main loop hasn't progressed in N seconds, exit and let the
 supervisor restart you (crash-only design beats trying to self-heal a wedged process).
- Still **persist state**, a daemon restarts too, and in-memory-only state evaporates.
- Reconnect subscriptions on drop with backoff; a silently-dead WebSocket is the classic daemon failure.

## Checklist

- [ ] One cycle per run; no internal infinite loop (unless a deliberate, supervised daemon)
- [ ] Overlap-prevention lock with TTL > worst-case cycle time
- [ ] Exit 0 on transient faults; non-zero (with alert) only on genuine breakage
- [ ] Hard per-cycle timeout so a hung call can't wedge the schedule
- [ ] Interval matches the work and the chain; fleet cycles staggered
- [ ] State persisted between runs (scheduled model holds nothing in memory)
- [ ] Daemons run under a supervisor with a watchdog and subscription reconnect
