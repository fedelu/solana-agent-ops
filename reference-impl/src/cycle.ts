// The ONE cycle. Wires the four invariants together. (SKILL.md)
import { address } from "@solana/kit";
import { config } from "./config.ts";
import { loadSigner, ensureFunded } from "./fleet.ts";
import { transfer } from "./landing.ts";
import { actionKey, getRecord, markSent, runOnce } from "./idempotency.ts";
import { assertWithinCaps, preflightGuard, recordSpend, resetCycleSpend, tripBreaker } from "./safety.ts";
import { rpc } from "./rpc.ts";
import { heartbeat, log } from "./monitor.ts";

// Track consecutive failures across runs → trip the breaker (safety.md).
import { getJSON, putJSON } from "./state.ts";

export async function runCycle(): Promise<void> {
  // 1. Safety preflight: kill switch + breaker. Stand down (no-op, exit 0) if either is set.
  if (!preflightGuard()) return;

  resetCycleSpend();
  const signer = await loadSigner();

  // 2. Keep the signer funded (devnet airdrop; mainnet would alert + back off).
  await ensureFunded(signer);

  // 3. The action, made exactly-once. Key it deterministically so a re-run within the same
  //    minute-bucket dedups instead of double-sending. (idempotency.md)
  const bucket = Math.floor(Date.now() / 60_000); // one demo transfer per minute, at most
  const key = actionKey(["self-transfer", signer.address, bucket]);

  try {
    const result = await runOnce(
      key,
      async () => {
        // 4. Spend cap enforced BEFORE the send (safety.md).
        assertWithinCaps(config.amountLamports);
        const r = await transfer({
          signer,
          destination: address(signer.address), // self-transfer: a real, cheap, safe demo action
          amount: config.amountLamports,
          onSent: (sig) => markSent(key, sig),
        });
        if (!r.dryRun) recordSpend(config.amountLamports);
        return r.sig;
      },
      // reconcile: did a prior in-flight attempt actually land? Ask the chain. (idempotency.md)
      async (rec) => {
        if (!rec.sig || rec.sig === "DRY_RUN") return null;
        const { value } = await rpc.getSignatureStatuses([rec.sig as never]).send();
        const st = value[0];
        return st && !st.err ? rec.sig : null;
      },
    );

    recordOutcome(true);
    heartbeat({ key, sig: result, cluster: config.cluster, dryRun: config.dryRun });
    log.info("cycle ok", { key, sig: result });
  } catch (e) {
    const failures = recordOutcome(false);
    if (failures >= 3) await tripBreaker(`${failures} consecutive cycle failures`);
    throw e; // index.ts decides exit code (transient → 0, terminal → 1)
  }
}

function recordOutcome(ok: boolean): number {
  const s = getJSON<{ consecutiveFailures: number }>("outcomes.json", { consecutiveFailures: 0 });
  s.consecutiveFailures = ok ? 0 : s.consecutiveFailures + 1;
  putJSON("outcomes.json", s);
  return s.consecutiveFailures;
}

export { getRecord };
