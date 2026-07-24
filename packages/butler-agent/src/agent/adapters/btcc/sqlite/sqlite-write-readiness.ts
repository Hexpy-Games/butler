import { Database } from "bun:sqlite";
import type {
  CommittedSuccessorReadiness,
  OperationalRecoveryReadiness,
} from "../../../btcc/gateway-api.ts";
import { isSqliteContention } from "../../../../foundation/sqlite-contention.ts";

const WRITE_PROBE_BUSY_WINDOW_MS = 250;

export function createSqliteWriteReadiness(
  dbPath: string,
  fallback: OperationalRecoveryReadiness,
): OperationalRecoveryReadiness & CommittedSuccessorReadiness {
  return {
    async wait(input) {
      if (input.interruption.activation.kind !== "automatic_storage_recovery") {
        await fallback.wait(input);
        return;
      }
      await waitUntilWritable(dbPath, input.signal);
    },
    waitForStorageReadiness(signal) {
      return waitUntilWritable(dbPath, signal);
    },
  };
}

async function waitUntilWritable(
  dbPath: string,
  signal: AbortSignal,
): Promise<void> {
  while (true) {
    assertActive(signal);
    if (probeWriteAccess(dbPath)) return;
    await yieldToCancellation(signal);
  }
}

function probeWriteAccess(dbPath: string): boolean {
  const db = new Database(dbPath);
  let transactionOpen = false;
  try {
    db.exec(`PRAGMA busy_timeout=${WRITE_PROBE_BUSY_WINDOW_MS}`);
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    db.exec("ROLLBACK");
    transactionOpen = false;
    return true;
  } catch (error) {
    if (!isSqliteContention(error)) throw error;
    return false;
  } finally {
    if (transactionOpen) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Closing the probe connection also releases an unfinished probe.
      }
    }
    db.close();
  }
}

function yieldToCancellation(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, 0);
    signal.addEventListener("abort", stopped, { once: true });
    function done() {
      signal.removeEventListener("abort", stopped);
      resolve();
    }
    function stopped() {
      clearTimeout(timer);
      reject(aborted());
    }
  });
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw aborted();
}

function aborted(): Error {
  const error = new Error("BTCC SQLite readiness wait was stopped");
  error.name = "AbortError";
  return error;
}
