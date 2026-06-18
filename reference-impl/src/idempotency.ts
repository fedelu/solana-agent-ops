// Idempotency, exactly-once execution across crashes/retries. (idempotency.md)
import { getJSON, putJSON } from "./state.ts";
import { log } from "./monitor.ts";

type Status = "pending" | "sent" | "confirmed" | "failed";
type Record = { key: string; status: Status; sig?: string; ts: number };
type Logbook = { [key: string]: Record };

const FILE = "actions.json";

function read(): Logbook {
  return getJSON<Logbook>(FILE, {});
}
function write(book: Logbook): void {
  putJSON(FILE, book);
}

export function getRecord(key: string): Record | undefined {
  return read()[key];
}

function set(rec: Record): void {
  const book = read();
  book[rec.key] = rec;
  write(book);
}

// runOnce: claim BEFORE acting; record confirmed only AFTER. Reconcile on restart via the chain.
export async function runOnce(
  key: string,
  doIt: () => Promise<string>,
  reconcile: (rec: Record) => Promise<string | null>,
): Promise<string> {
  const prior = read()[key];

  if (prior?.status === "confirmed") {
    log.info("action already confirmed, no-op", { key, sig: prior.sig });
    return prior.sig ?? "confirmed";
  }
  if (prior && (prior.status === "pending" || prior.status === "sent")) {
    // Crashed mid-flight, ask the chain whether it actually happened before re-acting.
    const settled = await reconcile(prior);
    if (settled) {
      set({ ...prior, status: "confirmed", sig: settled });
      log.info("reconciled prior in-flight action", { key, sig: settled });
      return settled;
    }
    log.warn("prior action proven NOT applied, safe to retry fresh", { key });
  }

  set({ key, status: "pending", ts: Date.now() }); // claim before send
  try {
    const sig = await doIt();
    set({ key, status: "confirmed", sig, ts: Date.now() });
    return sig;
  } catch (e) {
    set({ key, status: "failed", ts: Date.now() });
    throw e;
  }
}

// Mark a send as broadcast (sig known) before confirmation, so a crash mid-confirm can reconcile.
export function markSent(key: string, sig: string): void {
  const prior = read()[key];
  set({ key, status: "sent", sig, ts: prior?.ts ?? Date.now() });
}

// Deterministic key: same logical action → same key, regardless of when/how often it runs.
export function actionKey(parts: (string | number)[]): string {
  return parts.join(":");
}
