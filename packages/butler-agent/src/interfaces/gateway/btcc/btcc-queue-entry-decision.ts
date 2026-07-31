import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { QueuedInboundEvent } from
  "../../../gateways/core/inbound-queue.ts";

export type BtccQueueEntryDecision =
  | { kind: "fresh" }
  | { kind: "resume" }
  | { kind: "terminal" };

export type BtccQueueEntryDecider = (
  item: QueuedInboundEvent,
) => BtccQueueEntryDecision | undefined;

const APP_TERMINAL_STATES = new Set([
  "cancelling",
  "cancelled",
  "delivered",
  "failed",
  "runtime_fault",
]);
const BTCC_TERMINAL_STATES = new Set(["cancelled", "delivered"]);

export function createBtccQueueEntryDecider(
  dbPath: string,
): BtccQueueEntryDecider {
  return (item) => {
    const turnId = item.envelope.routingHints?.turnId?.trim();
    if (!turnId || !existsSync(dbPath)) return { kind: "fresh" };

    let db: Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true });
      const appState = db.query<{ state: string }, [string]>(
        "SELECT state FROM turns WHERE id = ?",
      ).get(turnId)?.state;
      if (appState && APP_TERMINAL_STATES.has(appState)) {
        return { kind: "terminal" };
      }

      const btccState = db.query<{ semantic_state: string }, [string]>(
        "SELECT semantic_state FROM btcc_turns WHERE turn_id = ?",
      ).get(turnId)?.semantic_state;
      if (btccState && BTCC_TERMINAL_STATES.has(btccState)) {
        return { kind: "terminal" };
      }
      return btccState ? { kind: "resume" } : { kind: "fresh" };
    } catch {
      return undefined;
    } finally {
      db?.close();
    }
  };
}
