// Safety rails, spend caps, circuit breaker, kill switch. Enforced in code. (safety.md)
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { getJSON, putJSON } from "./state.ts";
import { alert, log } from "./monitor.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

type Spend = { perCycle: number; day: { ts: number; amount: number }[] };
type Breaker = { tripped: boolean; reason?: string; ts?: number };

export class CapExceeded extends Error {
  cap: string;
  amount: bigint;
  constructor(cap: string, amount: bigint) {
    super(`spend cap exceeded: ${cap} by ${amount}`);
    this.cap = cap;
    this.amount = amount;
  }
}

// Kill switch: presence of .state/KILL (or a config flag) halts the agent. Fails safe. (safety.md)
export function killActive(): boolean {
  return existsSync(join(config.stateDir, "KILL"));
}

// Circuit breaker, persisted so a crash loop can't auto-reset it. Serious trips need manual reset.
export function breakerTripped(): Breaker {
  return getJSON<Breaker>("breaker.json", { tripped: false });
}
export async function tripBreaker(reason: string): Promise<void> {
  putJSON<Breaker>("breaker.json", { tripped: true, reason, ts: Date.now() });
  await alert(`breaker tripped: ${reason}, agent halted, manual reset required (rm .state/breaker.json)`, "page");
}

// Spend caps: most restrictive wins; counters persist so a restart can't reset the daily budget.
export function assertWithinCaps(amount: bigint): void {
  if (amount > config.caps.perTx) throw new CapExceeded("perTx", amount);
  const s = getJSON<Spend>("spend.json", { perCycle: 0, day: [] });
  const n = Number(amount);
  if (s.perCycle + n > Number(config.caps.perCycle)) throw new CapExceeded("perCycle", amount);
  const dayTotal = s.day.filter((e) => Date.now() - e.ts < DAY_MS).reduce((a, e) => a + e.amount, 0);
  if (dayTotal + n > Number(config.caps.perDay)) throw new CapExceeded("perDay", amount);
}

export function recordSpend(amount: bigint): void {
  const s = getJSON<Spend>("spend.json", { perCycle: 0, day: [] });
  const n = Number(amount);
  s.perCycle += n;
  s.day = s.day.filter((e) => Date.now() - e.ts < DAY_MS);
  s.day.push({ ts: Date.now(), amount: n });
  putJSON("spend.json", s);
}

export function resetCycleSpend(): void {
  const s = getJSON<Spend>("spend.json", { perCycle: 0, day: [] });
  s.perCycle = 0;
  putJSON("spend.json", s);
}

export function assertMaxFee(feeLamports: bigint): void {
  if (feeLamports > config.caps.maxFee) {
    throw new CapExceeded(`maxFee(${feeLamports} > ${config.caps.maxFee})`, feeLamports);
  }
}

// Guard run at the top of every cycle. Returns false → stand down (exit 0). (safety.md)
export function preflightGuard(): boolean {
  if (killActive()) {
    log.warn("kill switch active, standing down");
    return false;
  }
  const b = breakerTripped();
  if (b.tripped) {
    log.error("breaker tripped, refusing to act", { reason: b.reason });
    return false;
  }
  return true;
}
