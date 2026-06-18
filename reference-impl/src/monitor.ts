// Monitoring, structured logs, heartbeat, alerts. (monitoring.md)
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";

type Level = "info" | "warn" | "error";

function emit(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  // Structured JSON, queryable, never logs secrets (we only ever pass public keys / signatures).
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
  console.log(line);
}

export const log = {
  info: (msg: string, f?: Record<string, unknown>) => emit("info", msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => emit("warn", msg, f),
  error: (msg: string, f?: Record<string, unknown>) => emit("error", msg, f),
};

// Heartbeat: written on a successful cycle. A separate watcher alerts on staleness (monitoring.md).
export function heartbeat(fields: Record<string, unknown>): void {
  mkdirSync(config.stateDir, { recursive: true });
  const rec = { ts: Date.now(), ...fields };
  writeFileSync(join(config.stateDir, "heartbeat.json"), JSON.stringify(rec, null, 2));
  appendFileSync(join(config.stateDir, "cycles.log"), JSON.stringify(rec) + "\n");
}

// Alert: ntfy if configured, else log-only. "page" raises priority. (monitoring.md)
export async function alert(msg: string, level: "page" | "warn" = "warn"): Promise<void> {
  log[level === "page" ? "error" : "warn"](`ALERT: ${msg}`);
  if (!config.ntfyTopic) return;
  try {
    await fetch(`https://ntfy.sh/${config.ntfyTopic}`, {
      method: "POST",
      headers: {
        Priority: level === "page" ? "urgent" : "default",
        Tags: level === "page" ? "rotating_light" : "warning",
      },
      body: msg,
    });
  } catch (e) {
    log.warn("alert delivery failed", { err: String(e) });
  }
}
