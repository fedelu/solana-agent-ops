---
description: "Diagnose why a Solana transaction didn't land or failed, from a signature or a description"
---

You are diagnosing a stuck, dropped, or failed Solana transaction. Work the decision tree from
[transaction-landing.md](../skill/transaction-landing.md), cheapest checks first, and end with a
specific fix, not a list of possibilities.

## Input

A transaction **signature**, or a description ("my swap keeps failing"). If you have a signature, query
the chain. If you only have a description, ask for the signature or the build code, don't guess.

## Step 1: Did it land at all?

```bash
# Via any RPC. Replace <SIG> and <RPC_URL>.
curl -s <RPC_URL> -X POST -H "Content-Type: application/json" -d '{
 "jsonrpc":"2.0","id":1,"method":"getSignatureStatuses",
 "params":[["<SIG>"],{"searchTransactionHistory":true}]
}'
```

- **`null` status (not found)** → it never landed: dropped or expired before confirmation. Go to Step 3A.
- **Found with `err`** → it landed and *failed*. Go to Step 2 (logic bug, do NOT advise a retry).
- **Found, `err: null`** → it succeeded. The bot's local state is out of sync → point at
 [idempotency.md](../skill/idempotency.md) (reconcile on-chain effect vs local log).

## Step 2: It landed but failed, read the logs

```bash
curl -s <RPC_URL> -X POST -H "Content-Type: application/json" -d '{
 "jsonrpc":"2.0","id":1,"method":"getTransaction",
 "params":["<SIG>",{"maxSupportedTransactionVersion":0,"encoding":"json"}]
}'
```

Read `meta.err` and `meta.logMessages`:

- `InsufficientFundsForRent` / custom `0x1` → fund the account/fee payer → [keypair-fleet.md](../skill/keypair-fleet.md)
- `ComputeBudgetExceeded` / "exceeded CUs" → CU limit too low; set it from simulation + margin (Step in landing.md)
- Anchor custom error (`0x1770`+ → code 6000+) → decode against the program IDL; it's a program-level reject, fix the inputs/logic
- `AccountNotFound` / `AccountOwnedByWrongProgram` → wrong account / missing init / stale derivation

A failed-on-chain tx is **never** fixed by retrying the same thing. Fix the cause.

## Step 3A: It never landed, why?

Establish the likely cause:

- **Priority fee too low for the congestion** → check what fee it used vs `getRecentPrioritizationFees`
 for the writable accounts. Recommend percentile-based sizing (landing.md).
- **Blockhash expired** → was the confirm loop keyed on `lastValidBlockHeight`? If it used a wall-clock
 timeout or no loop, that's the bug. Recommend the re-broadcast-until-expiry loop.
- **Dropped under load** → recommend a staked-connection RPC / Helius Sender / Jito for the send path.
- **RPC rate-limited (429)** during send → [rate-limiting.md](../skill/rate-limiting.md).

## Step 4: Output

Give the user:
1. **Verdict**, one line: landed-and-failed (logic), never-landed (delivery), or succeeded (state desync).
2. **Root cause**, the specific reason from the logs/statuses.
3. **Fix**, concrete change, with the relevant skill-file pattern. If it's a delivery issue, include the
 corrected send/confirm loop. If logic, the input/program fix.
4. **Prevention**, the checklist item from [transaction-landing.md](../skill/transaction-landing.md) that
 would have caught it.
