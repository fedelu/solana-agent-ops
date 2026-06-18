# Monitoring & Alerting

> An unattended agent is only as good as your ability to know when it stops working. The failure you
> never get paged about is the expensive one.

Read this when adding observability to an agent: what to measure, when to alert, and how to avoid both
silent failures and alert fatigue.

## Monitor outcomes, not just liveness

"The process ran" ≠ "the work happened." A bot can exit 0 every cycle while doing nothing useful (stuck
on a stale blockhash, out of funds, RPC returning empty). Watch the **on-chain effect**, not the process:

| Layer | Signal | Why |
|-------|--------|-----|
| Liveness | Last successful cycle timestamp (heartbeat) | Detects a wedged/dead scheduler |
| Outcome | Did the expected on-chain state change? (balance moved, position rebalanced, counter advanced) | Detects "running but useless" |
| Economic | Spend vs. cap, realized PnL/fees, slippage actually incurred | Detects misbehaving-but-alive bots |
| Resource | Hot-wallet + funder balances, RPC error rate, latency | Detects the slow slide into outage |

The decoupling rule from [scheduling.md](scheduling.md): the agent exits 0 on transient faults; a
**separate monitor** judges success from outcomes. If you only alert on crashes, you'll miss the bot
that's been quietly idle for two days.

## Heartbeats: alert on absence

The strongest single signal is a heartbeat written at the end of every successful cycle, with a watcher
that alerts when it goes **stale**, because a dead process can't send you an error, but it also can't
update its heartbeat.

```ts
// End of a successful cycle:
await store.put("heartbeat:agent-07", { ts: now(), cycle: n, lastSig: sig });

// Separate watcher (its own cron), alerts on staleness, the thing the agent itself can't report:
const hb = await store.get("heartbeat:agent-07");
if (!hb || now() - hb.ts > STALE_MS) await alert(`agent-07 heartbeat stale (${age(hb?.ts)})`);
```

Dead-man's-switch services (healthchecks.io, Better Stack, cronitor) implement exactly this: ping on
success, they page you on missed pings. Cheap and effective for scheduled agents.

## What to alert on (and what not to)

**Page-worthy (act now):**

- Heartbeat stale beyond N intervals → agent down
- Hot wallet or **funder** below funding threshold → activity about to halt ([keypair-fleet.md](keypair-fleet.md))
- Spend cap or circuit breaker tripped → ([safety.md](safety.md))
- All RPC endpoints unhealthy → ([rate-limiting.md](rate-limiting.md))
- A non-transient (non-zero exit) failure

**Log-only (review later, don't page):**

- Individual transient retries, single 429s, one expired blockhash that the loop recovered from
- A skipped cycle due to the overlap lock
- Routine "nothing to do this cycle"

Alerting on transient noise trains you to ignore alerts, then you miss the real one. **Alert on
sustained or threshold conditions, not single events.** (e.g. "3 consecutive cycles failed to land,"
not "one send retried.")

## Structured logs, not `console.log`

Emit JSON with stable fields so logs are queryable and feed dashboards/alerts:

```ts
log.info({ agent: "agent-07", cycle: n, action: "rebalance", sig, cuUsed, feeLamports, durationMs }, "cycle ok");
log.warn({ agent: "agent-07", cycle: n, err: code, attempt }, "transient retry");
```

- Use a real logger (pino/bunyan) with levels; ship to a sink you can search (journald, Loki, Datadog, CloudWatch).
- **Never log secret keys.** Log public keys and signatures (both are public). The `/audit-agent-safety`
 command greps logs for accidental secret leakage.
- Always log the **signature** of every send, it's your link to on-chain truth for diagnosis
 ([transaction-landing.md](transaction-landing.md)).

## Alert channels

Match urgency to channel; route, don't broadcast everything everywhere:

- **ntfy / Telegram / Slack webhook**, instant, simple, great for a solo operator or small team. A
 bot posting `agent-07: funder below 0.1 SOL` to a Telegram ops channel is often all you need.
- **PagerDuty / Opsgenie**, when you need escalation policies and on-call rotation.
- **Email/digest**, daily summaries (cycles run, total spend, PnL), never for urgent conditions.

```ts
async function alert(msg: string, level: "page" | "warn" = "warn") {
 // ntfy: a one-line POST, no SDK. Use a private topic.
 await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
 method: "POST",
 headers: { Priority: level === "page" ? "urgent" : "default", Tags: level === "page" ? "rotating_light" : "warning" },
 body: msg,
 });
}
```

## A minimal dashboard

You don't need Grafana on day one. A daily/once-per-cycle digest covers most needs:

- Per agent: last cycle time, cycles today, actions taken, total spend vs cap, current balance
- Fleet: funder balance, RPC error rate, any tripped breakers
- Economic: fees paid, realized PnL, biggest slippage event

Persisting these as structured records (the same action log from [idempotency.md](idempotency.md)) means
the digest is a query, not new instrumentation. Graduate to Grafana/Datadog when you have multiple
operators or need historical trends.

## Checklist

- [ ] Heartbeat written on success; a separate watcher alerts on staleness
- [ ] Alerts fire on outcomes/thresholds (funds, breakers, sustained failures), not transient noise
- [ ] Structured JSON logs with agent/cycle/sig/spend fields, shipped to a searchable sink
- [ ] Every send's signature logged; no secret ever logged
- [ ] Urgent vs digest routed to appropriate channels
- [ ] Funder balance and RPC health monitored, not just per-agent liveness
