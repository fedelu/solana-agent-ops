---
globs:
 - "src/**/*.{ts,js}"
 - "**/bot/**/*.{ts,js}"
 - "**/agent/**/*.{ts,js}"
 - "**/keeper/**/*.{ts,js}"
exclude:
 - "**/node_modules/**"
 - "**/dist/**"
 - "**/*.d.ts"
---

# TypeScript Rules for Solana Agent Ops

These are **law** for code that signs and sends transactions unattended. They override style preference.

## Secrets

- **NEVER** put a secret key in source, a log, `/tmp`, or a tracked `.env`. Load by reference from
 env/KMS/secrets-manager at runtime. A 64-byte array literal or base58 secret in code is a bug.
- Log **public keys and signatures** (both public). Never log secret material or full env dumps.
- `.env` is gitignored; only `.env.example` (public values) is committed.

## Sending transactions

- **No raw `sendTransaction`** in business logic. Every send goes through the simulate → size-CU →
 size-fee → confirm/retry pipeline (see `transaction-landing.md`).
- Always **simulate before sending**. Surface sim failures; never feed them into a retry loop.
- Set the **CU limit from simulation + margin**; never ship the 200k default.
- Size the **priority fee from the live fee market**; always enforce a **max-fee ceiling**.
- Confirm via a loop keyed on **`lastValidBlockHeight`**, re-broadcasting the *same signed tx*. Never a
 `setTimeout`-based "probably landed."
- Gate value-moving logic on `confirmed`/`finalized`, **never `processed`**.

## Idempotency & retries

- A retry must re-broadcast the **same signed transaction**, or first prove the effect hasn't applied.
- Every action has a **deterministic idempotency key** (not time/random based).
- Write `pending` to the action store **before** sending; `confirmed` only **after** confirmation.

## Safety

- Enforce **spend caps** (per-tx/cycle/day) and a **max-fee bound** before every value-moving send.
- A **circuit breaker** and **kill switch** are checked every cycle; the kill switch **fails safe**.
- **Bounds-check every external input**: slippage, oracle staleness/deviation, config schema+ranges.
- New agents default to **`DRY_RUN=true` and `CLUSTER=devnet`**. Mainnet is a deliberate config change.

## Resilience

- Distinguish **transient** (retry with capped exponential backoff + jitter) from **terminal** (surface).
- Disable RPC-internal retries (`maxRetries: 0`); the app owns the retry loop.
- Reads: batch (`getMultipleAccounts`), cache immutables, subscribe instead of tight-polling.

## Scheduling

- Scheduled agents do **one cycle per run**, no internal `while(true)`.
- Guard overlap with a **TTL lock**; wrap the cycle in a **hard timeout**.
- **Exit 0 on transient faults**; non-zero (with an alert) only on genuine breakage.

## Types & errors

- No `any` on transaction, account, or money-handling code paths. Type lamports/amounts explicitly.
- Use a real logger (pino), structured JSON, not `console.log`, for anything that runs unattended.
