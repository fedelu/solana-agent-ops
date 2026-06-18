# Safety Rails

> Every other module keeps the agent *working*. This one keeps a working agent from *doing damage*, a
> fat-fingered config, a price-feed glitch, or a logic bug turning into a drained wallet at machine speed.

Read this before any agent touches mainnet, and whenever adding spend limits, kill switches, or
guardrails to an existing bot.

## The mental model: an agent is a loaded gun pointed at your funds

It signs and sends without a human in the loop, fast, forever. Assume every input can be wrong (oracle
glitch, stale state, malformed config) and every guardrail will eventually be the only thing between you
and a loss. Defense in depth: caps, breakers, bounds, and an off-switch, enforced in code, not vigilance.

## 1. Spend caps (the hard ceiling)

A bug should cost you a capped amount, not everything. Enforce caps the agent **cannot exceed**, checked
before every value-moving send:

```ts
// Layered caps. The most restrictive wins. Persist counters (idempotency.md store) so a restart
// doesn't reset the daily budget mid-day.
const CAPS = {
 perTx: 0.10 * LAMPORTS_PER_SOL, // no single action larger than this
 perCycle: 0.30 * LAMPORTS_PER_SOL, // total per scheduled run
 perDay: 2.00 * LAMPORTS_PER_SOL, // rolling 24h
};

async function assertWithinCaps(amount: number) {
 if (amount > CAPS.perTx) throw new CapExceeded("perTx", amount);
 const cycle = await spend.get("cycle"); if (cycle + amount > CAPS.perCycle) throw new CapExceeded("perCycle");
 const day = await spend.rolling24h(); if (day + amount > CAPS.perDay) throw new CapExceeded("perDay");
}
```

Separately cap **fees**: a priority-fee or Jito-tip spike shouldn't quietly drain a hot wallet. Reject
any tx whose `cuLimit * microLamportsPerCu` (plus tip) exceeds a max-fee bound
([transaction-landing.md](transaction-landing.md)).

A `CapExceeded` should **trip the breaker** (below) and alert, hitting a cap means reality diverged from
your assumptions, which is exactly when to stop and look.

## 2. Circuit breakers (stop on anomaly)

When something looks wrong, halt the whole agent rather than push through. Trip on:

- Consecutive failures (e.g. 3 sends in a row didn't land)
- A spend/fee cap exceeded
- An oracle/price moved more than X% between cycles (likely a bad feed, not a real move)
- Slippage on the last action exceeded the bound
- Realized loss over a window beyond a threshold

```ts
// A persisted breaker survives restarts, a crash loop must NOT auto-reset it.
async function guard() {
 const b = await breaker.get();
 if (b.tripped) { log.error({ reason: b.reason }, "breaker tripped, refusing to act"); process.exit(0); }
}
async function trip(reason: string) {
 await breaker.set({ tripped: true, reason, ts: now() });
 await alert(`breaker tripped: ${reason}, agent halted, manual reset required`, "page");
}
```

**Require a manual reset** for serious trips (cap exceeded, repeated losses). An auto-resetting breaker
that flaps will happily resume losing money. Auto-reset is acceptable only for clearly-transient trips
(e.g. RPC outage) after a cooldown.

## 3. A kill switch you can hit from your phone

When something is wrong at 2am, you need to stop the fleet *now*, without SSH and a redeploy. Make
"should I act?" a runtime check against external state:

```ts
// Checked at the top of every cycle, before any send.
async function killCheck() {
 // Any of: a flag in your state store, a value in a config service, a pinned message in the ops channel,
 // or simply presence of a file. Cheapest reliable option you can flip from a phone wins.
 if (await store.get("KILL_SWITCH")) { log.warn("kill switch active, standing down"); process.exit(0); }
}
```

Granularity helps: a global kill plus per-agent kills lets you stop one misbehaving wallet without
halting the fleet. The kill switch must **fail safe**, if you can't read its state, treat it as ON
(don't act when you're blind).

## 4. Bounds on every external input

Never trust an input to be sane. Validate before it reaches a transaction:

- **Prices/oracles**: check staleness (publish time), confidence interval, and deviation vs last value.
 Reject a price that's stale, low-confidence, or moved implausibly. A glitched feed is the classic
 "bot bought the top / sold the bottom" cause.
- **Slippage**: always set a minimum-out / max-in on swaps. Never send a swap with unbounded slippage.
- **Config**: validate at startup (schema + range checks). A misplaced decimal in a config value is a
 100x-size order. Fail to start rather than start wrong.
- **Account state**: re-read close to the send; act on `confirmed`/`finalized`, not `processed`
 ([transaction-landing.md](transaction-landing.md)).

## 5. Testnet-first and dry-run by default

- **New agent or new logic → devnet/testnet first.** Same code, different cluster. Prove the loop, the
 caps, the breaker, and the kill switch all fire correctly before a single mainnet lamport is at risk.
- **Dry-run mode**: a flag that runs the full pipeline, build, simulate, size, log the *intended*
 action, but skips the final send. Run a new mainnet config in dry-run for a while and eyeball that
 the actions it *would* take are sane.
- **Ramp gradually**: tiny caps at first, widen as confidence grows. Don't deploy at full size.

```ts
if (DRY_RUN) { log.info({ intended }, "DRY RUN, would send"); return; } // pipeline ran, no send
```

## 6. MEV / front-running awareness

For value-extractable actions (swaps, liquidations, arb), assume the mempool is adversarial:

- Use **Jito bundles** for atomicity + private submission where front-running is a real risk
 ([transaction-landing.md](transaction-landing.md)).
- Set **tight slippage** so a sandwich has little room.
- Avoid **predictable timing/sizing**, jitter cycle times and vary amounts so your actions aren't a
 signal others trade against ([rate-limiting.md](rate-limiting.md), [keypair-fleet.md](keypair-fleet.md)).

## Pre-mainnet gate

Do not point an agent at mainnet until **all** of these are true. The `/audit-agent-safety` command
checks this list against a codebase.

- [ ] Per-tx, per-cycle, per-day spend caps enforced in code, with persisted counters
- [ ] Max-fee (priority + tip) bound enforced per tx
- [ ] Circuit breaker that trips on repeated failure / cap / anomaly and requires manual reset
- [ ] Kill switch checked every cycle, fails safe (blind = off), flippable without redeploy
- [ ] Every external input bounds-checked: oracle staleness/deviation, slippage, config schema
- [ ] Proven on devnet/testnet; ran in dry-run on mainnet config before going live
- [ ] Caps start small and ramp; no full-size first deploy
- [ ] No secret keys in source/logs/`/tmp`; high-value funds behind multisig ([keypair-fleet.md](keypair-fleet.md))
- [ ] Monitoring + alerting live before launch, not after ([monitoring.md](monitoring.md))
