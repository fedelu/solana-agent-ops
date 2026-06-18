---
description: "Scaffold a production-ready Solana agent/bot with landing, idempotency, safety, and scheduling wired in"
---

You are scaffolding a new Solana agent/bot that signs and sends transactions unattended. Produce a
project that is *safe and resilient by default*, the four invariants from [SKILL.md](../skill/SKILL.md)
built in from line one, not bolted on later.

## Step 1: Establish requirements

Ask only what you can't infer:
- **What does each cycle do?** (rebalance, sweep, liquidate, distribute, react to a price...)
- **Execution model**: scheduled (one-cycle-per-run) or daemon? Default to scheduled ([scheduling.md](../skill/scheduling.md)).
- **One signer or a fleet?** Where will secrets live (env/KMS/file)? ([keypair-fleet.md](../skill/keypair-fleet.md))
- **Value per action** → sets spend caps ([safety.md](../skill/safety.md)).
- **Cluster**: start devnet. (Always scaffold devnet-first.)

## Step 2: Generate the structure

Mirror the reference implementation shipped with this skill (`reference-impl/`). Produce:

```
src/
 config.ts # env-driven config, validated at startup (schema + ranges). NO secrets in code.
 rpc.ts # RPC pool with failover + withRetry (rate-limiting.md)
 fleet.ts # signer loading by reference + funding/top-up (keypair-fleet.md)
 landing.ts # simulate → size CU → size fee → confirm/retry loop (transaction-landing.md)
 idempotency.ts # action log + locks; runOnce/reconcile (idempotency.md)
 safety.ts # spend caps, circuit breaker, kill switch, dry-run (safety.md)
 monitor.ts # heartbeat + alert() (monitoring.md)
 cycle.ts # the ONE cycle: killCheck → guard → lock → ensureFunded → do work via runOnce → heartbeat
 index.ts # entrypoint: run one cycle, exit 0 on transient, non-zero only on real breakage
.env.example # PUBLIC values only
README.md # how to configure + run on devnet first
```

## Step 3: Wire the invariants (non-negotiable defaults)

- **Every send** goes through `landing.ts` (simulate-first, CU+fee sized, confirm loop). No raw `sendTransaction`.
- **Every action** goes through `runOnce(key, ...)` from `idempotency.ts`. Deterministic keys.
- **Every value-moving send** passes `assertWithinCaps()` and is gated by the breaker + kill switch.
- **`index.ts`** does exactly one cycle, with a TTL lock and a hard timeout, and exits 0 on transient faults.
- **`config.ts`** defaults `DRY_RUN=true` and `CLUSTER=devnet`. Going live is a deliberate config change.

## Step 4: Hand off

- Show the user how to run it on **devnet in dry-run** first, then enable sends, then (only after the
 safety gate passes) point at mainnet with small caps.
- Run `/audit-agent-safety` against the result and confirm the pre-mainnet gate before suggesting mainnet.
- Set up at least a heartbeat + one alert channel ([monitoring.md](../skill/monitoring.md)) before launch.

Reuse the reference implementation's modules verbatim where they fit, they're written to be lifted.
Keep it vendor-neutral; flag Helius/Jito only as optional accelerators.
