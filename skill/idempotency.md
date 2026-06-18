# Idempotency

> The crash you didn't plan for: the process dies *after* sending a transaction but *before* recording
> that it sent. On restart, a naive bot does it again. On Solana, "again" can mean a second swap, a
> second transfer, a doubled position.

Read this when an agent retries, restarts, or runs on a schedule and an action must happen **exactly
once**, not zero times, not twice.

## The core problem

A send is not atomic with recording the send. Any of these gaps re-runs an action:

```
build → send → [CRASH] → ...restart... → build → send ← double-acted
build → send → confirm-times-out → retry with NEW tx ← maybe double-acted
cron fires twice (overlap) → two processes do the same job ← double-acted
```

You cannot prevent crashes. You *can* make replay safe. Two complementary tools: **idempotency keys**
(decide whether to act) and **on-chain effects as the source of truth** (verify whether you already did).

## Rule 1: Re-broadcasting the *same signed transaction* is always safe

A transaction's signature is its identity. Sending the identical signed bytes twice results in **one**
on-chain execution, the second is deduped by the network. So the safe retry is: sign once, re-broadcast
that same blob until it confirms or its blockhash expires (the loop in
[transaction-landing.md](transaction-landing.md)).

**Danger only appears when a retry builds a NEW transaction** (new blockhash, new nonce). Now there are
two distinct signatures that can *both* land. Everything below is about making *that* safe.

## Rule 2: Derive an idempotency key for every action

Before acting, compute a deterministic key from *what the action is*, not when it ran:

```ts
// Same logical action → same key, across restarts and retries.
function actionKey(a: { kind: string; account: string; epoch: number; nonce?: string }) {
 return `${a.kind}:${a.account}:${a.epoch}${a.nonce ? ":" + a.nonce : ""}`;
 // e.g. "rebalance:7xQ…pool:412", one rebalance per pool per epoch, no matter how many times the loop runs
}
```

Persist a small **action log** keyed by this. Before acting, check it; after confirming, record it.

```ts
type ActionRecord = { key: string; status: "pending" | "sent" | "confirmed" | "failed"; sig?: string; ts: number };

async function runOnce(key: string, doIt: () => Promise<string>) {
 const prior = await store.get(key);
 if (prior?.status === "confirmed") return prior.sig; // already done, no-op
 if (prior?.status === "sent") return await reconcile(prior); // crashed mid-flight, verify on-chain (Rule 3)

 await store.put({ key, status: "pending", ts: now() }); // claim BEFORE sending
 const sig = await doIt();
 await store.put({ key, status: "confirmed", sig, ts: now() });
 return sig;
}
```

**Write `pending` before you send, not after.** If you crash between send and record, the next run sees
`pending`/`sent` and reconciles instead of blindly re-sending.

## Rule 3: On-chain state is the tiebreaker

When the local log says `pending`/`sent` but you're not sure the tx landed, **ask the chain**, it's the
only source of truth that survives your crash:

```ts
async function reconcile(rec: ActionRecord): Promise<string> {
 if (rec.sig) {
 const { value } = await rpc.getSignatureStatuses([rec.sig]).send();
 const st = value[0];
 if (st && !st.err) { await store.put({ ...rec, status: "confirmed" }); return rec.sig; } // it landed
 }
 // No sig, or it didn't land → verify the EFFECT, not the tx:
 // e.g. "is the position already rebalanced this epoch?" via getAccountInfo / program state.
 if (await effectAlreadyApplied(rec.key)) { await store.put({ ...rec, status: "confirmed" }); return rec.sig ?? "applied"; }
 return await retryFresh(rec); // safe to rebuild, we've proven it has NOT happened
}
```

Prefer **effect checks** over signature checks where possible: "does the on-chain state already reflect
this action?" is robust even if you lost the signature. Design actions so their effect is queryable
(a counter, an epoch marker, a position state).

## Rule 4: Use on-chain anti-replay where the protocol gives it to you

Some mechanisms make double-execution *impossible at the chain level*, lean on them:

- **Durable nonces**: a nonce can only be consumed once; the next use requires it to have advanced. A
 queued action keyed to a specific nonce can't replay. (See [transaction-landing.md](transaction-landing.md).)
- **PDA "once" markers**: initialize a PDA as part of the action (`init`, not `init_if_needed`). A second
 attempt fails with "already in use", the chain enforces exactly-once for you.
- **Monotonic sequence/epoch checks in-program**: if your program rejects an action whose sequence
 number isn't strictly greater, replays bounce off-chain logic.

If the program you call already has one of these, your off-chain log becomes a performance optimization
(skip work early) rather than the sole guard.

## Rule 5: Don't let the scheduler run two copies

Cron overlap (a run takes longer than the interval) silently doubles everything. Guard with a lock:

```ts
// A lease/lock with a TTL > max run time. File lock for single-box; Redis/DB lease for distributed.
const lease = await lock.acquire("agent-cycle", { ttlMs: 120_000 });
if (!lease) { log.warn("previous cycle still running, skipping"); process.exit(0); } // benign skip, exit 0
try { await cycle(); } finally { await lease.release(); }
```

See [scheduling.md](scheduling.md) for where this sits in the run lifecycle.

## Choosing a state store

| Store | Use when |
|-------|----------|
| In-memory `Map` | Single long-lived process, actions cheap to re-derive, **lost on restart, weak guarantee** |
| Local file (JSON/SQLite) | Single box; survives restarts; simplest durable option |
| Redis | Distributed agents needing shared locks + fast key checks |
| Postgres/Dynamo | Audit trail required, many agents, strong durability |

The store only needs the action log + locks, keep it small. Don't mirror chain state into it; **query
the chain** for truth (Rule 3) and use the store for *intent* and *dedup*.

## Anti-patterns

- ❌ Recording success *before* the tx confirms (records a lie if it never lands).
- ❌ Keying idempotency on a timestamp or random id (every run looks new → never dedups).
- ❌ Retrying by rebuilding a fresh tx without first checking the effect didn't already apply.
- ❌ `init_if_needed` where `init` was meant, quietly re-runs instead of failing the replay.
- ❌ Trusting only the local log after a crash, it may be stale; the chain is the tiebreaker.

## Checklist

- [ ] Transient retries re-broadcast the *same signed tx*, not a rebuilt one
- [ ] Every action has a deterministic idempotency key (not time/random based)
- [ ] `pending` is written *before* the send; `confirmed` only *after* confirmation
- [ ] Restart reconciles `pending`/`sent` against on-chain effect/signature before re-acting
- [ ] Protocol-level anti-replay (durable nonce / `init` PDA / sequence) used where available
- [ ] Scheduler overlap prevented with a TTL lock; benign skip exits 0
