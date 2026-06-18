# Rate Limiting & RPC Resilience

> The RPC endpoint is the one dependency every Solana agent shares and the one it abuses first. A bot
> that hammers a single RPC gets 429'd, then silently stops landing transactions.

Read this when you see `429`, `Too Many Requests`, timeouts under load, or you're sizing how hard an
agent can hit its RPC.

## Budget before you backoff

The first fix isn't retries, it's **doing fewer requests**. Most bots are accidentally chatty:

- **Batch reads.** `getMultipleAccounts` instead of N× `getAccountInfo`. One round trip for up to 100 accounts.
- **Cache the immutable.** Mint decimals, program IDs, ATAs, PDA addresses, blockhash (for ~30s), don't refetch every loop.
- **Subscribe, don't poll, for streams.** WebSocket `accountSubscribe` / Laserstream / Yellowstone gRPC
 for "tell me when this changes" beats polling `getAccountInfo` in a tight loop. Polling N accounts
 every 400ms is the classic 429 generator.
- **Right commitment.** Don't request `finalized` reads when `confirmed` is fine, and don't re-poll
 faster than the chain produces blocks (~400ms slots).

A request you never make can't be rate-limited. Budget the loop: count requests per cycle, multiply by
cycles/min, compare to your plan's limit, and leave headroom.

## Retry transient failures with capped exponential backoff + jitter

Distinguish **transient** (retry) from **terminal** (don't):

| Class | Examples | Action |
|-------|----------|--------|
| Transient | `429`, `503`, timeout, connection reset, `BlockhashNotFound` on read | Backoff + retry |
| Terminal | `InstructionError`, sim failure, `4xx` (non-429) auth/param errors | Surface, do not retry |

```ts
async function withRetry<T>(fn: () => Promise<T>, opts = { max: 5, baseMs: 250, capMs: 8_000 }): Promise<T> {
 let attempt = 0;
 for (;;) {
 try { return await fn(); }
 catch (e) {
 if (!isTransient(e) || attempt >= opts.max) throw e; // terminal or exhausted → bubble up
 const backoff = Math.min(opts.capMs, opts.baseMs * 2 ** attempt);
 const jitter = backoff * (0.5 + Math.random() * 0.5); // full jitter: avoid thundering herd
 await sleep(jitter);
 attempt++;
 }
 }
}
```

Honor `Retry-After` when the provider sends it, it's a precise instruction, better than your guess.

## Failover across endpoints

A single RPC is a single point of failure. Keep a prioritized pool and fail over on transient errors:

```ts
const endpoints = [
 { url: PRIMARY, weight: 3 }, // your paid/staked endpoint
 { url: SECONDARY, weight: 1 }, // a different provider, independent failure domain
];

async function rpcCall<T>(fn: (rpc: Rpc) => Promise<T>): Promise<T> {
 let lastErr;
 for (const ep of orderByHealth(endpoints)) {
 try { return await withRetry(() => fn(rpcFor(ep.url))); }
 catch (e) { lastErr = e; markUnhealthy(ep); } // demote, try next
 }
 throw lastErr; // all endpoints down → escalate to monitoring.md
}
```

Pick the secondary from a **different provider**, not a second URL on the same one, correlated outages
defeat the purpose. Track per-endpoint health (error rate, latency) and route to the healthiest;
re-probe demoted endpoints after a cooldown.

## Sending transactions is a different lane

Reads scale with caching; **sends** are about landing (see [transaction-landing.md](transaction-landing.md)),
but rate limits still apply:

- Use a **dedicated send path** when you have one (Helius Sender, staked connections, Jito block engine)
, these are built for high send throughput and bypass shared read limits.
- Don't let `sendTransaction` retry internally *and* your loop retry too, set `maxRetries: 0` on the RPC
 call and own the retry loop yourself, or you multiply requests and lose control of timing.
- Re-broadcasting the *same* signed tx (the confirm loop) is cheap and safe; rebuilding on each retry
 multiplies both fees and request count.

## Multi-agent fleets share the budget

N agents on one RPC key share one rate limit. Coordinate:

- **Stagger** cycle start times across the fleet (don't fire all 24 agents at `:00`). Add per-agent jitter.
- **Spread keys/endpoints** across agents where the provider allows it, so the blast radius of one key's
 limit is smaller.
- **Centralize** hot shared reads (e.g. one fee-market poll feeding all agents) instead of N agents
 each polling the same data.

## Checklist

- [ ] Reads batched (`getMultipleAccounts`) and immutable data cached
- [ ] Streams use subscriptions, not tight polling loops
- [ ] Transient vs terminal errors distinguished; only transient retried
- [ ] Backoff is exponential + full jitter, capped, honors `Retry-After`
- [ ] At least two endpoints from independent providers, with health-based failover
- [ ] RPC-internal retries disabled; the app owns the retry loop
- [ ] Fleet cycles staggered; shared reads centralized
