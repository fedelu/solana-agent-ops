---
name: solana-agent-ops
description: Production operations for autonomous agents and bots that transact on Solana. Covers reliable transaction landing (simulate-first, compute-budget and priority-fee sizing, Jito bundles, durable nonces, confirm/retry), keypair-fleet custody and funding automation, exactly-once idempotency, RPC rate-limiting and failover, scheduling, monitoring and alerting, and safety rails (kill switches, spend caps, circuit breakers). Use when building, hardening, or debugging anything that signs and sends Solana transactions unattended: trading, arb, or liquidation bots, market makers, AI agents executing on-chain, cron jobs, keepers, or airdrop and distribution scripts.
user-invocable: true
---

# Solana Agent Ops Skill

This is the layer between "my bot works on my laptop" and "my bot runs unattended on mainnet without
losing money."

It assumes you already know how to build a transaction. What it covers is everything that makes an agent
survive production: landing transactions reliably, holding keys for a fleet of signers safely, never
double-spending on a retry, staying under RPC limits, running on a scheduler, and shutting itself down
before it does damage.

For core transaction construction, `@solana/kit`, and program and client patterns, this extends
[solana-dev-skill](https://github.com/solana-foundation/solana-dev-skill). This is the operations addon
on top of it; it doesn't re-teach how to build instructions.

## When to use this skill

Route here when the user is doing any of:

- Building or operating a bot, keeper, or agent that signs and sends transactions without a human watching
- Asking why a transaction isn't landing: dropped, expired blockhash, or never confirmed
- Running many signer wallets and worrying about key storage, funding, or rotation
- Worried that a retry might double-spend, or an action might run twice
- Hitting 429s or rate limits from an RPC provider
- Putting an agent on a cron or scheduler and wanting it to fail safely
- Adding monitoring, alerts, kill switches, or spend caps to an existing bot

If the task is one-shot transaction construction (build an instruction, a CPI, a PDA), that belongs to
[solana-dev-skill](https://github.com/solana-foundation/solana-dev-skill), not here.

## Task routing

Read only the file you need. One primary target per task.

| Task | Read |
|------|------|
| Transaction dropped / expired / not landing / slow | [transaction-landing.md](transaction-landing.md) |
| Sizing compute units + priority fees | [transaction-landing.md](transaction-landing.md) |
| Jito bundles / MEV / atomic multi-tx | [transaction-landing.md](transaction-landing.md) |
| Managing N signer wallets, key storage, funding top-ups | [keypair-fleet.md](keypair-fleet.md) |
| "Did this already run?" / preventing double execution | [idempotency.md](idempotency.md) |
| 429s, RPC budgets, endpoint failover | [rate-limiting.md](rate-limiting.md) |
| Running on cron / one-cycle-per-run / exit codes | [scheduling.md](scheduling.md) |
| Health checks, balance/failure alerts, dashboards | [monitoring.md](monitoring.md) |
| Kill switches, spend caps, circuit breakers, dry-run | [safety.md](safety.md) |
| Official docs, RPC providers, libraries | [resources.md](resources.md) |

## The operating model (read this first)

Every production agent should be built around four invariants. The module files are organized around
enforcing them:

1. Simulate before you send. A transaction that fails simulation will fail on-chain, so find out for
   free. ([transaction-landing.md](transaction-landing.md))
2. Every send is idempotent. If the process crashes and restarts mid-action, replaying it must not
   double-act. That means idempotency keys plus on-chain or state-store checks, not hoping it didn't run.
   ([idempotency.md](idempotency.md))
3. Money has a ceiling per cycle. Spend caps, slippage bounds, and a circuit breaker that trips on
   anomalies, all enforced in code rather than in your head. ([safety.md](safety.md))
4. One cycle per run, exit cleanly. Schedulers re-invoke you, so a process that exits non-zero on a
   transient RPC blip will page you at 3am for nothing. ([scheduling.md](scheduling.md))

## Default stack (June 2026)

- Client: `@solana/kit` (web3.js v2). web3.js v1 patterns are noted where the ecosystem still uses them.
- Runtime: Node 22+ / TypeScript 5.5+. Rust patterns are given for keepers that need to be fast.
- RPC: vendor-neutral. Helius, Triton, and QuickNode specifics are flagged, never required.
- Bundles: Jito (`jito-ts` or the block-engine REST), optional, for atomicity and MEV protection.
- Scheduling: plain cron, systemd timers, GitHub Actions, or serverless cron, all one cycle per run.

See [resources.md](resources.md) for the canonical links behind each of these.

## Related kit skills (don't duplicate)

- Building agents as a framework: SendAI `solana-agent-kit`. This skill is the ops layer on top of it.
- RPC vendor APIs (Helius Sender, the priority-fee API, Laserstream): the Helius skill. This one stays
  vendor-neutral and tells you which vendor feature solves which ops problem.
- Multisig key custody for treasuries and upgrade authority: the Squads skill. This skill covers
  operational signer-fleet custody, the hot keys that send routine transactions, which is a different
  problem.
