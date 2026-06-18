// Transaction landing pipeline: simulate → size CU → size fee → confirm/retry. (transaction-landing.md)
import {
  type Address,
  type Base64EncodedWireTransaction,
  type KeyPairSigner,
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  estimateComputeUnitLimitFactory,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import { rpc, withRetry } from "./rpc.ts";
import { config } from "./config.ts";
import { assertMaxFee } from "./safety.ts";
import { log } from "./monitor.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class BlockhashExpiredError extends Error {}

const estimateCu = estimateComputeUnitLimitFactory({ rpc });

// Size the priority fee from the live fee market (p75), with a floor. (transaction-landing.md)
async function samplePriorityFee(writable: Address[]): Promise<number> {
  try {
    const recent = await withRetry(() => rpc.getRecentPrioritizationFees(writable).send());
    const fees = recent
      .map((r) => Number(r.prioritizationFee))
      .filter((f) => f > 0)
      .sort((a, b) => a - b);
    if (fees.length === 0) return 1_000;
    const idx = Math.min(fees.length - 1, Math.floor(fees.length * 0.75));
    return Math.max(fees[idx], 1_000);
  } catch {
    return 1_000; // calm-market floor if the endpoint doesn't support the call
  }
}

export type SendResult = { sig: string; dryRun: boolean; cuLimit: number; microLamports: number; feeLamports: number };

// Build, simulate, size, (optionally) send + confirm a SOL transfer. onSent records the sig pre-confirm.
export async function transfer(params: {
  signer: KeyPairSigner;
  destination: Address;
  amount: bigint;
  onSent?: (sig: string) => void;
}): Promise<SendResult> {
  const { signer, destination, amount, onSent } = params;
  const writable = [address(signer.address), destination];

  const microLamports = await samplePriorityFee(writable);
  const transferIx = getTransferSolInstruction({ source: signer, destination, amount: lamports(amount) });

  // Need a lifetime to simulate. Fetch once for the estimate; refetch fresh right before signing.
  const { value: probe } = await withRetry(() => rpc.getLatestBlockhash({ commitment: "confirmed" }).send());
  const baseMsg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(probe, m),
    (m) => appendTransactionMessageInstructions([transferIx], m),
  );

  // 1. Simulate (throws on logic failure, surfaced, never retried) and read CU consumed.
  const unitsConsumed = await estimateCu(baseMsg);
  const cuLimit = Math.ceil(unitsConsumed * 1.15); // +15% margin for state drift
  const feeLamports = Math.ceil((cuLimit * microLamports) / 1_000_000);
  assertMaxFee(BigInt(feeLamports)); // hard fee ceiling (safety.md)

  log.info("sized transaction", { unitsConsumed, cuLimit, microLamports, feeLamports });

  if (config.dryRun) {
    log.info("DRY RUN, pipeline ran, send skipped", { destination, amount });
    return { sig: "DRY_RUN", dryRun: true, cuLimit, microLamports, feeLamports };
  }

  // 2. Final message: compute-budget ixs + fresh blockhash, then sign.
  const { value: latest } = await withRetry(() => rpc.getLatestBlockhash({ commitment: "confirmed" }).send());
  const finalMsg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
    (m) =>
      appendTransactionMessageInstructions(
        [
          getSetComputeUnitLimitInstruction({ units: cuLimit }),
          getSetComputeUnitPriceInstruction({ microLamports: BigInt(microLamports) }),
          transferIx,
        ],
        m,
      ),
  );

  const signed = await signTransactionMessageWithSigners(finalMsg);
  const sig = getSignatureFromTransaction(signed);
  const wire = getBase64EncodedWireTransaction(signed);
  onSent?.(sig); // idempotency: record 'sent' before confirming (idempotency.md)

  // 3. Send + confirm loop keyed on lastValidBlockHeight; re-broadcast the SAME signed tx.
  const sig2 = await confirmLoop(wire, sig, latest.lastValidBlockHeight);
  return { sig: sig2, dryRun: false, cuLimit, microLamports, feeLamports };
}

async function confirmLoop(
  wire: Base64EncodedWireTransaction,
  sig: string,
  lastValidBlockHeight: bigint,
): Promise<string> {
  for (;;) {
    await withRetry(() =>
      rpc
        .sendTransaction(wire, {
          encoding: "base64",
          skipPreflight: true, // we already simulated
          maxRetries: 0n, // app owns retries (rate-limiting.md)
          preflightCommitment: "confirmed",
        })
        .send(),
    ).catch((e) => log.warn("send blip, confirm poll is source of truth", { err: String(e) }));

    const { value: statuses } = await rpc.getSignatureStatuses([sig as never]).send();
    const st = statuses[0];
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
      if (st.err) throw new Error(`landed with error: ${JSON.stringify(st.err)}`);
      log.info("confirmed", { sig, status: st.confirmationStatus });
      return sig;
    }

    const height = await rpc.getBlockHeight({ commitment: "confirmed" }).send();
    if (height > lastValidBlockHeight) throw new BlockhashExpiredError(`blockhash expired before ${sig} landed`);
    await sleep(2_000);
  }
}
