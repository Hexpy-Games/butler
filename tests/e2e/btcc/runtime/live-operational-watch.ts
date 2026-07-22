import { Database } from "bun:sqlite";
import type { BtccTurnProgressObserver } from "../../../../packages/butler-agent/src/agent/btcc/index.ts";

const DEFAULT_STALL_OBSERVATION_MS = 300_000;
const POLL_INTERVAL_MS = 1_000;

export class LiveOperationalStallError extends Error {
  override readonly name = "LiveOperationalStallError";
}

export function observeLiveOperationalStall(input: {
  dbPath: string;
  turnId: string;
  onStalled(error: LiveOperationalStallError): void;
  observationMs?: number;
}): {
  observer: BtccTurnProgressObserver;
  close(): void;
} {
  const db = new Database(input.dbPath, { readonly: true });
  const observationMs = input.observationMs ?? liveObservationMs();
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastProgressAt = 0;
  let lastCheckpoint = "";
  let closed = false;

  function start() {
    if (timer || closed) return;
    lastCheckpoint = checkpointSignature(db, input.turnId);
    lastProgressAt = Date.now();
    timer = setInterval(observe, Math.min(POLL_INTERVAL_MS, observationMs));
  }

  function observe() {
    const current = checkpointSignature(db, input.turnId);
    if (current !== lastCheckpoint) {
      lastCheckpoint = current;
      lastProgressAt = Date.now();
      return;
    }
    if (Date.now() - lastProgressAt < observationMs) return;
    stopTimer();
    input.onStalled(
      new LiveOperationalStallError(
        "Live E2E stopped its Turn after a sustained provider interruption without checkpoint progress.",
      ),
    );
  }

  function stopTimer() {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
  }

  return {
    observer: {
      stateChanged() {
        if (!timer) return;
        lastCheckpoint = checkpointSignature(db, input.turnId);
        lastProgressAt = Date.now();
      },
      operationalNoticeChanged(update) {
        if (update.status === "recovering") start();
        else stopTimer();
      },
    },
    close() {
      closed = true;
      stopTimer();
      db.close();
    },
  };
}

function checkpointSignature(db: Database, turnId: string): string {
  const row = db
    .query<
      {
        checkpoint_id: string;
        checkpoint_revision: number;
        turn_revision: number;
      },
      [string]
    >(
      `
    SELECT checkpoint_id, checkpoint_revision, turn_revision
    FROM btcc_checkpoints WHERE turn_id = ? AND is_active = 1
  `,
    )
    .get(turnId);
  return row
    ? `${row.turn_revision}:${row.checkpoint_id}:${row.checkpoint_revision}`
    : "no-active-checkpoint";
}

function liveObservationMs(): number {
  const configured = Number(process.env.BTCC_LIVE_OPERATIONAL_STALL_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_STALL_OBSERVATION_MS;
}
