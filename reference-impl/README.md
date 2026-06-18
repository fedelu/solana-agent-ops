# Reference bot

A small, real Solana agent that uses every pattern in the [solana-agent-ops](../skill/SKILL.md) skill.
It runs one cycle, does a cheap self-transfer through the full landing pipeline, and is safe by default.
Treat it as a template: each module is written to be copied straight into your own bot.

The demo action is a 1000-lamport transfer to the bot's own address. It's real, it's cheap, and it
exercises the whole build, simulate, size, send, and confirm path without needing a counterparty or a
funded second account.

## Where each pattern lives

| File | Skill module | What it shows |
|------|--------------|---------------|
| `src/landing.ts` | transaction-landing.md | Simulate first for the CU estimate, CU limit at estimate +15%, p75 priority fee, a hard max-fee ceiling, and a confirm loop keyed on `lastValidBlockHeight` that re-broadcasts the same signed tx |
| `src/idempotency.ts` | idempotency.md | Deterministic action keys, `pending` written before the send, reconcile against the chain on restart |
| `src/safety.ts` | safety.md | Per-tx, per-cycle, and per-day spend caps, a max-fee bound, a persisted circuit breaker that needs a manual reset, and a fail-safe kill switch |
| `src/fleet.ts` | keypair-fleet.md | Loading a secret by reference, a dev key that never lands in the repo, threshold-based funding |
| `src/rpc.ts` | rate-limiting.md | Telling transient errors from terminal ones, capped exponential backoff with full jitter |
| `src/index.ts` | scheduling.md | One cycle per run, a TTL overlap lock, a hard timeout, and exit 0 on transient faults |
| `src/monitor.ts` | monitoring.md | Structured JSON logs that never print secrets, a heartbeat on success, ntfy alerts |

## Run it

```bash
npm install
cp .env.example .env            # public values only

# Dry run: the full pipeline, no send. This is the default.
DRY_RUN=true npm start

# Live on devnet: needs a funded wallet (see below)
DRY_RUN=false CLUSTER=devnet npm start
```

On first run the bot generates a dev keypair and stores the seed in `.state/dev-seed.json`, which is
gitignored. Fund that address with a bit of devnet SOL (https://faucet.solana.com, or
`solana airdrop 1 <addr> --url devnet` when the faucet isn't rate-limited) and run with `DRY_RUN=false`
to watch it land a real transaction.

## What I actually verified

I ran these end to end while building the skill, against live devnet RPC, on `@solana/kit` v6 and Node 24:

- Typechecks clean (`tsc --noEmit`).
- Kill switch: `touch .state/KILL` and the next cycle logs `kill switch active, standing down` and exits 0.
- Spend cap: `CAP_PER_TX=500 AMOUNT_LAMPORTS=1000` gives `spend cap exceeded: perTx by 1000` and the send never happens.
- Circuit breaker: three failures in a row trip it, it writes `.state/breaker.json`, and every later cycle refuses to act until you delete that file.
- Rate limiting: real RPC 429s produce `transient RPC error, backing off` with exponential backoff and jitter, then it degrades gracefully.
- Scheduling: a concurrent run hits the lock and skips with `previous cycle still running, skipping`; transient faults exit 0, genuine breakage exits 1.
- Simulate-first guard: an unfunded send is rejected at simulation before any broadcast, which is exactly the point. A transaction that fails simulation never enters the retry loop.

Building it even caught a real bug, which I left fixed in `src/index.ts`: calling `process.exit()` inside
a `catch` skips the `finally`, so the overlap lock leaked. That is the precise failure the scheduling
module warns about, so it felt right to hit it in the reference too.

The one thing I couldn't capture was a live confirmed signature, because every devnet faucet was rate
limited the day I built this. Everything up to broadcast is exercised above. Fund the dev address and run
it to see the confirmed signature for yourself.

## Going to mainnet

Don't, until the pre-mainnet gate in [../skill/safety.md](../skill/safety.md) passes. The bot refuses to
run live on mainnet unless you set `I_PASSED_THE_SAFETY_GATE=yes`, which is a deliberate speed bump, not a
feature. Run `/audit-agent-safety` on your fork first.
