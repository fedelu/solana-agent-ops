// Tiny durable JSON state store + TTL lock. Single-box; swap for Redis/DB when distributed.
// Backs idempotency (action log), safety (spend counters, breaker), and scheduling (overlap lock).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";

function path(name: string): string {
  mkdirSync(config.stateDir, { recursive: true });
  return join(config.stateDir, name);
}

export function getJSON<T>(name: string, fallback: T): T {
  const p = path(name);
  if (!existsSync(p)) return fallback;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function putJSON<T>(name: string, value: T): void {
  writeFileSync(path(name), JSON.stringify(value, null, 2));
}

// TTL lock: prevents scheduler overlap (scheduling.md / idempotency.md). Returns a release fn or null.
export function acquireLock(name: string, ttlMs: number): null | (() => void) {
  const p = path(`${name}.lock`);
  if (existsSync(p)) {
    try {
      const held = JSON.parse(readFileSync(p, "utf8")) as { ts: number };
      if (Date.now() - held.ts < ttlMs) return null; // still held and not expired
    } catch {
      /* corrupt lock, treat as stale, reclaim */
    }
  }
  writeFileSync(p, JSON.stringify({ ts: Date.now(), pid: process.pid }));
  return () => {
    try {
      rmSync(p);
    } catch {
      /* already gone */
    }
  };
}
