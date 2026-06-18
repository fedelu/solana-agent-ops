---
description: "Audit an autonomous Solana agent/bot codebase against the pre-mainnet safety gate"
---

You are auditing a bot/agent/keeper before it runs unattended on mainnet. Check the code against the
pre-mainnet gate in [safety.md](../skill/safety.md) and the operating invariants in
[SKILL.md](../skill/SKILL.md). Be a skeptic: assume guardrails are missing until you see them in code.

## Scope

Point this at the agent's source (the loop that signs and sends). Read the actual code, do not accept
"we handle that" without seeing it. Report findings by severity with file:line references.

## What to check (and how)

### Critical (block mainnet until fixed)

1. **Secret key exposure.** Grep for keys in source, logs, `/tmp`, and tracked `.env`:
   ```bash
 grep -rnE '([1-9A-HJ-NP-Za-km-z]{80,}|\[(\s*\d+\s*,){63,}\s*\d+\s*\])' --include='*.{ts,js,json,env}' . 2>/dev/null
 git ls-files | grep -E '(^|/)\.env$' ; grep -rn '/tmp/' --include='*.{ts,js}' .
   ```
 Any base58 secret / 64-byte array literal in source, any tracked `.env`, any keypair written to `/tmp`
 → critical. Secrets must come from env/KMS by reference ([keypair-fleet.md](../skill/keypair-fleet.md)).
2. **No spend cap.** Is there a per-tx / per-cycle / per-day ceiling enforced *before* every value-moving
 send, with persisted counters? Absent → a bug can drain the wallet. Critical.
3. **No kill switch.** Is "should I act?" checked against external runtime state each cycle, failing safe?
 Absent → no way to stop a misbehaving fleet without redeploy. Critical.
4. **Non-idempotent retries.** Does any retry rebuild a *new* transaction without first checking the
 effect didn't already apply? → double-spend risk ([idempotency.md](../skill/idempotency.md)). Critical.

### High

5. **No simulation before send**, or retrying sim failures.
6. **CU limit hardcoded / default 200k** instead of sized from simulation.
7. **Flat or missing priority fee**; no max-fee bound (fee-spike drain).
8. **Confirm loop missing or wall-clock-based** instead of `lastValidBlockHeight`.
9. **No circuit breaker** on repeated failure / anomaly, or one that auto-resets on serious trips.
10. **No input bounds**: unbounded slippage, no oracle staleness/deviation check, unvalidated config.

### Medium

11. Single RPC endpoint (no failover); RPC-internal retries fighting the app retry loop.
12. Scheduler overlap unguarded (no TTL lock); exits non-zero on transient faults.
13. No heartbeat / outcome monitoring; alerts on noise instead of thresholds.
14. Secrets logged (even public-key-only logging is fine; flag secret logging only).
15. No testnet/dry-run path; deploys straight to mainnet at full size.

## Output

1. **Verdict**: `SAFE FOR MAINNET` / `NOT SAFE, N critical, M high`.
2. **Findings table**: severity · file:line · issue · fix (cite the skill-file pattern).
3. **The pre-mainnet gate** from [safety.md](../skill/safety.md), each box ticked or flagged with the gap.
4. **Prioritized fix list**, criticals first; offer to implement them.

Do not declare an agent safe with any unaddressed . If the user wants to waive one, state the blast
radius explicitly and require them to accept it.
