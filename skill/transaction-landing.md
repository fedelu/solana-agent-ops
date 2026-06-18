# Transaction Landing

> The single most common production failure: the transaction was *built correctly* and still never
> confirmed. This file is the playbook for making transactions land, and for diagnosing why one didn't.

Read this when a transaction is dropped, expires, lands slowly, or you're sizing compute/fees for an
unattended sender.

## Why transactions don't land

There are only a handful of root causes. Diagnose in this order, cheapest first:

| Symptom | Root cause | Fix |
|---------|-----------|-----|
| `BlockhashNotFound` / "block height exceeded" | Blockhash expired before landing (>~60–90s, or low priority) | Fresh blockhash + higher priority fee; retry loop below |
| Tx never appears, no error | Dropped by RPC/leader under load (low fee) | Priority fee sizing + send to a staked-connection RPC / Jito |
| Sim passes, on-chain fails | Stale state between sim and land, or CU limit too low | Re-sim close to send; set CU limit from sim + margin |
| `Transaction simulation failed` | Logic error, missing signer, insufficient funds | Read the sim logs, do **not** retry, it will never land |
| Confirms then "disappears" | Confirmed at `processed`/`confirmed`, then forked out | Wait for `confirmed` (or `finalized` for value movement) |
| Intermittent under volume | RPC rate limit (429) upstream | See [rate-limiting.md](rate-limiting.md) |

**Rule: a transaction that fails simulation must never enter a retry loop.** Retrying a logically
invalid transaction wastes fees and masks the real bug. Retries are only for *transient* delivery
failures (expiry, drop), never for `InstructionError`.

## The landing pipeline

Build every unattended send as this pipeline. Each stage maps to a fix above.

```
build → simulate → size CU → size priority fee → (optional) bundle → send → confirm → retry-or-fail
```

### 1. Simulate first, always

Simulation is free and catches the majority of failures before they cost a fee. It also returns the
**actual compute units consumed**, which you need for the next step.

```ts
import {
 createSolanaRpc,
 getComputeUnitEstimateForTransactionMessageFactory,
} from "@solana/kit";

const rpc = createSolanaRpc(RPC_URL);

// @solana/kit ships a CU estimator that simulates and returns consumed units.
const getCuEstimate = getComputeUnitEstimateForTransactionMessageFactory({ rpc });
const unitsConsumed = await getCuEstimate(txMessage); // throws on sim failure, surface it, don't retry
```

web3.js v1 equivalent:

```ts
const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
if (sim.value.err) throw new Error(`sim failed: ${JSON.stringify(sim.value.err)}\n${sim.value.logs?.join("\n")}`);
const unitsConsumed = sim.value.unitsConsumed!;
```

### 2. Set the compute-unit limit from simulation

Never ship the default 200k CU. Too low → tx fails mid-execution; too high → you overpay priority fees
(fee is per-CU-requested for the budget, and a bloated limit also lowers your effective fee density and
can deprioritize you). Size it from the simulated value plus a safety margin.

```ts
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";

// +10–15% margin absorbs state drift between sim and land.
const cuLimit = Math.ceil(unitsConsumed * 1.15);
const cuLimitIx = getSetComputeUnitLimitInstruction({ units: cuLimit });
```

### 3. Size the priority fee from the live fee market

A flat priority fee is wrong in both directions: it overpays in calm markets and underpays (drops)
during congestion. Query recent fees for the accounts your tx writes to, and pick a percentile.

```ts
// Sample the fee market for the writable accounts this tx touches.
const recent = await rpc.getRecentPrioritizationFees(writableAccounts).send();
const fees = recent.map((r) => Number(r.prioritizationFee)).filter((f) => f > 0).sort((a, b) => a - b);

// Percentile by urgency: p50 for routine, p75–p90 when you must land this block.
const pick = (p: number) => fees.length ? fees[Math.min(fees.length - 1, Math.floor(fees.length * p))] : 0;
const microLamportsPerCu = Math.max(pick(0.75), 1_000); // floor so calm markets still get a nonzero bid
```

```ts
import { getSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";

const priorityIx = getSetComputeUnitPriceInstruction({ microLamports: microLamportsPerCu });
// Prepend BOTH compute-budget instructions before your real instructions.
```

**Cost intuition:** total priority fee ≈ `cuLimit * microLamportsPerCu / 1e6` lamports. Sizing the CU
limit tightly (step 2) directly caps this. Always enforce a hard ceiling (see [safety.md](safety.md))
so a fee-market spike can't drain a hot wallet.

> Vendor shortcut: Helius exposes a `getPriorityFeeEstimate` that returns percentile recommendations in
> one call. Use it if you're on Helius; the `getRecentPrioritizationFees` path above is the
> vendor-neutral fallback that works on any RPC. See [resources.md](resources.md).

### 4. Confirm with a fresh blockhash and a deadline

The blockhash defines the tx's expiry window (~150 blocks, ~60–90s). Fetch it *last*, right before
signing, and use its `lastValidBlockHeight` as the retry deadline, not a wall-clock timer.

```ts
const { value: latest } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
// set latest.blockhash on the message, then sign.
```

### 5. Send + confirm + retry (the loop)

The robust pattern: send, then poll for confirmation, re-broadcasting the *same signed transaction*
until it confirms or its blockhash expires. Re-broadcasting the identical tx is safe (same signature =
deduped on-chain); building a *new* tx on each retry is **not** safe unless idempotent
(see [idempotency.md](idempotency.md)).

```ts
async function sendAndConfirm(signedTx, lastValidBlockHeight: bigint): Promise<string> {
 const sig = getSignatureFromTransaction(signedTx);
 const wire = getBase64EncodedWireTransaction(signedTx);

 while (true) {
 // skipPreflight: we already simulated in step 1; preflight here just adds latency.
 await rpc.sendTransaction(wire, { skipPreflight: true, encoding: "base64", maxRetries: 0n }).send()
 .catch(() => {/* transient send error, the confirm poll below is the source of truth */});

 const { value: statuses } = await rpc.getSignatureStatuses([sig]).send();
 const st = statuses[0];
 if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") {
 if (st.err) throw new Error(`landed with error: ${JSON.stringify(st.err)}`);
 return sig;
 }

 const { value: height } = await rpc.getBlockHeight({ commitment: "confirmed" }).send();
 if (height > lastValidBlockHeight) throw new BlockhashExpiredError(sig); // rebuild with fresh blockhash + bump fee

 await sleep(2_000); // re-broadcast every ~2s while the blockhash is alive
 }
}
```

On `BlockhashExpiredError`: rebuild with a fresh blockhash, **bump the priority fee** (the market was
clearly above your bid), and only re-enter the loop if the action is idempotent or hasn't landed.
Cap total attempts (e.g. 3) and then escalate to alerting ([monitoring.md](monitoring.md)).

### Commitment levels, pick by stakes

- `processed`, fastest, can be rolled back. Never use it to gate value movement.
- `confirmed`, voted by supermajority; the right default for "did my tx land."
- `finalized`, irreversible. Use before treating funds as truly moved (withdrawals, accounting).

A common bug: confirming at `processed`, acting on it, then the slot forks out and the action is undone
on-chain while your bot believes it happened. Gate irreversible logic on `finalized`.

## Jito bundles, when you need atomicity or MEV protection

Reach for Jito bundles when:

- You need **all-or-nothing** across multiple transactions (e.g. open + hedge), or
- Your tx is **front-runnable** (liquidations, arb, large swaps), or
- You want to **pay a tip instead of a priority fee** to land during congestion via the block engine.

Mechanics that differ from normal sends:

- A bundle is up to 5 txs, executed **atomically and in order**, if any fails, none land.
- You pay a **tip** (a transfer to a Jito tip account) instead of relying solely on priority fee.
- You submit to the **block engine**, not your RPC; confirm via bundle status, then verify each
 signature landed as usual.

```ts
// Last instruction of the last tx in the bundle: tip a Jito tip account.
const tipIx = getTransferSolInstruction({
 source: payer,
 destination: JITO_TIP_ACCOUNT, // rotate among the published tip accounts
 amount: lamports(tipLamports), // size like a priority fee: percentile of recent tips, with a cap
});
// Submit base64 txs to the block-engine sendBundle endpoint; poll getBundleStatuses.
```

Keep the vendor-neutral fallback: if the bundle path is unavailable, degrade to the priority-fee path
above. Never make Jito a hard dependency for a bot that also works fine with normal sends.

## Durable nonces, for slow or offline signing

Standard blockhashes expire in ~60–90s. If signing is slow (hardware wallet, multi-party, an action
queued for later), use a **durable nonce** so the transaction never expires until consumed.

Use when: cold-signing flows, scheduled future execution, multisig collection. Don't use for
high-frequency hot-path sends, a recent blockhash is simpler and the nonce account adds a write
(serialized) dependency that limits throughput.

```
1. Create a nonce account (one-time, rent-funded).
2. First instruction = advanceNonce (authority signs).
3. Use the stored nonce as the tx's "blockhash".
 The tx stays valid until the nonce advances, then that exact nonce can never replay (built-in
 anti-replay; pairs naturally with idempotency.md).
```

## Diagnosing a specific stuck/failed signature

When the user pastes a signature or says "this tx failed," walk the tree:

1. `getSignatureStatuses([sig])`, did it land at all?
 - **Not found** → it was dropped or never broadcast. Check fee/blockhash; it likely expired. Rebuild.
 - **Found with `err`** → it landed and *failed*. Go to step 2, this is a logic bug, not a delivery problem.
 - **Found, no err** → it succeeded; the bot's local state is out of sync (see [idempotency.md](idempotency.md)).
2. `getTransaction(sig, { maxSupportedTransactionVersion: 0 })` → read `meta.logMessages` and `meta.err`.
 - `InsufficientFundsForRent` / `0x1` → fund the account / fee payer ([keypair-fleet.md](keypair-fleet.md)).
 - Anchor error code (`0x1770`+ = custom 6000+) → decode against the program IDL; it's a program-level reject.
 - `ComputeBudgetExceeded` → CU limit too low (step 2).
3. If never found and fees looked fine → it was dropped under congestion. Resend with a higher
 percentile fee and/or a staked-connection RPC or Jito.

The `/diagnose-stuck-tx` command automates this walk, see `commands/diagnose-stuck-tx.md`.

## Checklist for any unattended sender

- [ ] Simulates before sending; surfaces sim failures instead of retrying them
- [ ] CU limit set from simulation + margin (not the 200k default)
- [ ] Priority fee sized from the live fee market, with a hard per-tx ceiling
- [ ] Fresh blockhash fetched immediately before signing
- [ ] Confirm loop keyed on `lastValidBlockHeight`, re-broadcasting the *same* signed tx
- [ ] Value-moving actions gated on `confirmed`/`finalized`, never `processed`
- [ ] Retries bounded; exhaustion escalates to alerting
- [ ] Retry path is idempotent (see [idempotency.md](idempotency.md)) or proven not-yet-landed first
