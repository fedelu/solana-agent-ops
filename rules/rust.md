---
globs:
 - "**/bot/**/*.rs"
 - "**/agent/**/*.rs"
 - "**/keeper/**/*.rs"
 - "**/bin/**/*.rs"
exclude:
 - "**/target/**"
---

# Rust Rules for Solana Agent Ops

For keepers/bots written in Rust (latency-sensitive senders, high-frequency keepers). Same operating
invariants as the TypeScript rules, enforced with Rust idioms.

## Secrets

- Load `Keypair` from env/KMS/secrets-manager at runtime, never a literal or a `/tmp` path. Don't commit
 keypair files. Zero secret buffers after use (`zeroize`) where practical.
- Log `Pubkey` and signatures only, never the secret bytes.

## Sending transactions

- Build via the simulate → size-CU → size-fee → confirm pipeline. Use `simulate_transaction` first and
 read `units_consumed`; set the CU limit from it with margin via `ComputeBudgetInstruction::set_compute_unit_limit`.
- Size priority fee from `get_recent_prioritization_fees`; `set_compute_unit_price`; enforce a max-fee bound.
- Confirm against `last_valid_block_height` in a re-broadcast loop; don't trust a single
 `send_and_confirm_transaction` under load. Disable client-internal retries and own the loop.
- Use `CommitmentConfig::confirmed()` for "did it land"; `finalized()` before treating funds as moved.

## Errors & resilience

- Model errors with `thiserror`; **distinguish transient (retry) from terminal (surface)**, never
 blanket-retry. Retry transient with capped exponential backoff + jitter.
- No `.unwrap()` / `.expect()` on RPC, signing, or money paths. Propagate with `?` and handle.
- Bound every external input (slippage, oracle staleness/confidence, config) before it reaches a tx.

## Idempotency & safety

- Deterministic idempotency keys; persist `pending` before send, `confirmed` after. Reconcile on restart.
- Enforce spend caps + a circuit breaker + a kill switch checked each cycle; the kill switch fails safe.
- Default new agents to dry-run + devnet via config; mainnet is an explicit change.

## Scheduling

- One cycle per run for scheduled keepers; no internal infinite loop unless a supervised daemon.
- TTL lock for overlap; hard per-cycle timeout. Exit code 0 on transient, non-zero only on real breakage.
- Use a structured logger (`tracing`), not `println!`, for unattended processes.
