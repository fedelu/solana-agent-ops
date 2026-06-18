// RPC + resilience, single endpoint here for clarity; production adds failover. (rate-limiting.md)
import { createSolanaRpc } from "@solana/kit";
import { config } from "./config.ts";
import { log } from "./monitor.ts";

export const rpc = createSolanaRpc(config.rpcUrl);
export type Rpc = typeof rpc;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Transient (retry) vs terminal (surface). Never blanket-retry. (rate-limiting.md)
export function isTransient(e: unknown): boolean {
  const m = String((e as Error)?.message ?? e).toLowerCase();
  return (
    m.includes("429") ||
    m.includes("too many requests") ||
    m.includes("503") ||
    m.includes("timeout") ||
    m.includes("timed out") ||
    m.includes("fetch failed") ||
    m.includes("econnreset") ||
    m.includes("blockhashnotfound") ||
    m.includes("node is behind")
  );
}

// Capped exponential backoff + full jitter. (rate-limiting.md)
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { max?: number; baseMs?: number; capMs?: number } = {},
): Promise<T> {
  const { max = 5, baseMs = 250, capMs = 8_000 } = opts;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (!isTransient(e) || attempt >= max) throw e;
      const backoff = Math.min(capMs, baseMs * 2 ** attempt);
      const jitter = backoff * (0.5 + Math.random() * 0.5);
      log.warn("transient RPC error, backing off", { attempt, waitMs: Math.round(jitter) });
      await sleep(jitter);
      attempt++;
    }
  }
}
