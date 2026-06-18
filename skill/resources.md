# Resources

Canonical, current-to-June-2026 references behind this skill. Vendor links are grouped so you can stay
neutral and pick what fits.

## Core libraries

- **@solana/kit** (web3.js v2), https://github.com/anza-xyz/kit · docs: https://www.solana-kit.com
- **@solana-program/compute-budget**, CU limit + price instructions (used in transaction-landing.md)
- **@solana-program/system**, transfers, nonce accounts
- **web3.js v1** (legacy, still widespread), https://solana-labs.github.io/solana-web3.js
- **Anchor** (client + IDL), https://www.anchor-lang.com

## RPC + sending (vendor-neutral, pick one+ as primary/secondary)

- **Helius**, RPC, `getPriorityFeeEstimate`, Sender (high-throughput sends), Laserstream, webhooks.
 https://docs.helius.dev
- **Triton One**, staked connections, low-latency sends. https://triton.one
- **QuickNode**, RPC, streams, functions. https://www.quicknode.com
- **Solana public RPC**, `api.{mainnet-beta,devnet,testnet}.solana.com`, rate-limited; dev/fallback only.

> Use the vendor-neutral `getRecentPrioritizationFees` + `getLatestBlockhash` paths from
> [transaction-landing.md](transaction-landing.md) as the baseline; vendor APIs (Helius fee estimate,
> Sender) are optional accelerators.

## Jito (bundles, MEV, tips)

- **Jito** block engine + `jito-ts`, bundles, tip accounts, `sendBundle`/`getBundleStatuses`.
 https://docs.jito.wtf · tip accounts published in their docs (rotate among them).

## Streaming / subscriptions (avoid polling, rate-limiting.md)

- WebSocket `accountSubscribe` / `logsSubscribe` (built into RPC)
- **Helius Laserstream**, **Yellowstone gRPC (Geyser)**, high-throughput account/tx streams.

## Durable nonces & anti-replay

- Durable nonce accounts, https://solana.com/docs/core/transactions/durable-nonce
- PDA `init` (not `init_if_needed`) as a once-marker, Anchor docs.

## Key custody

- **Squads** (multisig for treasury / upgrade authority), https://squads.so · kit skill: `ext/sendai/skills/squads/`
- KMS/HSM signing: AWS KMS, GCP KMS, **Turnkey** (https://turnkey.com), Fireblocks.
- Local encryption: `age` (https://age-encryption.org), `sops`, libsodium secretbox.

## Scheduling & supervision

- systemd timers, `man systemd.timer` (prefer over cron on Linux)
- GitHub Actions cron, https://docs.github.com/actions (best-effort timing; ≥5 min)
- Vercel Cron, AWS EventBridge→Lambda, Cloudflare Cron Triggers (serverless one-cycle jobs)
- pm2 / k8s Deployments (daemon supervision)

## Monitoring & alerting

- **ntfy** (https://ntfy.sh), one-line POST push notifications, ideal for solo/small-team ops
- Dead-man's-switch: healthchecks.io, Better Stack, cronitor
- Logging: pino (https://getpino.io); sinks: journald, Grafana Loki, Datadog, CloudWatch
- Telegram Bot API, Slack incoming webhooks, PagerDuty/Opsgenie (escalation)

## Related kit skills

- **solana-dev-skill** (core: tx construction, @solana/kit, programs), https://github.com/solana-foundation/solana-dev-skill
- **SendAI solana-agent-kit** (agent *framework*; this skill is the *ops* layer), `ext/sendai/skills/solana-agent-kit/`
- **Helius skill** (vendor RPC specifics), `ext/helius/helius-skills/helius/`
- **Squads skill** (multisig custody), `ext/sendai/skills/squads/`
- Security/audit skills (Trail of Bits, Ghost, defending-code, QEDGen), for *program* security, complementary to this *ops* skill.
