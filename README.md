# Solana Agent Ops

A Claude Code / Codex skill for the bit nobody writes down: running a Solana bot in production without
losing money to it.

Building the bot is the easy part. You learn the hard part the expensive way, when the thing has been
live for two weeks and you discover that a restart double-sent, or a fee spike quietly drained a hot
wallet overnight, or the transaction you were sure landed never did. This skill is the stuff I wish
someone had handed me before the first bot, not after.

It is an addon to [solana-dev-skill](https://github.com/solana-foundation/solana-dev-skill). That skill
teaches you how to build a transaction. This one keeps the agent that sends it alive and honest.

## Who it's for

Anyone shipping something that signs and sends Solana transactions with no human watching: trading and
arb bots, liquidators, market makers, keepers, airdrop and distribution scripts, and AI agents acting
on-chain. If a process of yours can move funds at 3am, this is for you.

## The problem, concretely

Every team rediscovers the same five potholes, usually in production:

- Transactions that simulate fine and still never land (expired blockhash, dropped under congestion, a
  priority fee set too low).
- A crash-and-restart that runs the same action twice and double-spends.
- Hot signer keys sitting in `/tmp` or committed to a repo.
- A fee-market spike that empties a wallet because nothing capped the spend.
- A cron job that pages you at 3am over a transient 429 that fixed itself.

None of it is novel program logic. It is operations, and it had no home in the kit until now.

## What's inside

The skill uses progressive disclosure: `skill/SKILL.md` is a router, and it pulls in only the one module
a task needs, so it stays cheap on context.

| Module | What it covers |
|--------|----------------|
| `transaction-landing.md` | Simulate first, size the CU limit and priority fee, Jito bundles, durable nonces, the confirm loop, and how to diagnose a stuck signature |
| `keypair-fleet.md` | Custody for one signer or twenty-four, rotation, funding thresholds and auto top-up, and why keys never go in `/tmp` |
| `idempotency.md` | Exactly-once execution, deterministic action keys, reconciling against the chain after a crash |
| `rate-limiting.md` | Doing fewer requests, backoff with jitter, failover across providers |
| `scheduling.md` | One cycle per run, overlap locks, and exit codes that don't wake you for nothing |
| `monitoring.md` | Heartbeats, alerting on outcomes instead of noise, what to actually watch |
| `safety.md` | Spend caps, circuit breakers, kill switches, dry-run, the pre-mainnet gate |
| `resources.md` | The canonical docs and providers behind all of the above |

There's also an `agent-ops-engineer` subagent, three commands (`/diagnose-stuck-tx`,
`/audit-agent-safety`, `/scaffold-agent-bot`), TypeScript and Rust ops rules, and a runnable
`reference-impl/`: a small real bot that lands transactions on devnet using every pattern here. It isn't
pseudocode. I ran it.

## Install

```bash
# Installs the skill into ~/.claude/skills/ next to solana-dev-skill
./install.sh

# Add --with-config to also copy the agent, commands, and rules into ~/.claude/
./install.sh --with-config

# Or drop it straight into a project for the Solana AI Kit
cp -r skill ~/path/to/project/.claude/skills/solana-agent-ops
```

Then ask Claude things like:

- "Why isn't my transaction landing?" and paste the signature
- "Make this bot crash-safe so a restart doesn't double-send"
- "Set up funding top-ups for my 24 agent wallets"
- "Audit this keeper against the pre-mainnet safety gate"

## A few opinions baked in

It stays vendor-neutral. The portable pattern comes first; Helius, Jito, and Triton show up as optional
accelerators, never as hard dependencies, because your bot shouldn't die when one provider does. It
leads with `@solana/kit` (web3.js v2) and gives the v1 equivalent where the ecosystem still runs on it.
And it is pure docs plus reference TypeScript: no fetched binaries, no `curl | bash`, nothing the
installer does beyond copying files.

## License

MIT, Federico Delucchi, 2026. Built for the Solana AI Kit community skills bounty.
