// Entrypoint: ONE cycle per run, overlap-locked, time-bounded, exit 0 on transient. (scheduling.md)
import { config } from "./config.ts";
import { acquireLock } from "./state.ts";
import { isTransient } from "./rpc.ts";
import { runCycle } from "./cycle.ts";
import { alert, log } from "./monitor.ts";

// Load .env if present (public values only; secrets come from the environment / KMS).
try {
  process.loadEnvFile(".env");
} catch {
  /* no .env, rely on real env vars */
}

async function main(): Promise<void> {
  log.info("cycle start", { cluster: config.cluster, dryRun: config.dryRun });

  // Overlap guard: if a previous cycle is still running, skip benignly (exit 0). (scheduling.md)
  const release = acquireLock("agent-cycle", config.cycleTimeoutMs + 30_000);
  if (!release) {
    log.warn("previous cycle still running, skipping");
    process.exit(0);
  }

  let exitCode = 0;
  try {
    // Hard per-cycle timeout so a hung RPC call can't wedge the schedule. (scheduling.md)
    await Promise.race([
      runCycle(),
      new Promise((_r, reject) =>
        setTimeout(() => reject(new Error(`cycle exceeded ${config.cycleTimeoutMs}ms`)), config.cycleTimeoutMs),
      ),
    ]);
    log.info("cycle complete");
  } catch (e) {
    if (isTransient(e)) {
      log.warn("transient fault, will retry next cycle", { err: String(e) });
      // exitCode stays 0, do NOT page on transient faults (scheduling.md)
    } else {
      log.error("non-recoverable cycle failure", { err: String(e) });
      await alert(`agent cycle failed: ${String(e)}`, "page");
      exitCode = 1;
    }
  } finally {
    // Release BEFORE exiting, process.exit() inside catch would skip this and leak the lock.
    release();
  }
  process.exit(exitCode);
}

main().catch((e) => {
  log.error("fatal", { err: String(e) });
  process.exit(1);
});
