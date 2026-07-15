import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import type { AppInboundInput } from "../../../core/app-transport.ts";
import {
  FileQueueButlerServiceClient,
  type ButlerServiceClient,
} from "../../../core/client.ts";
import {
  getNativeMainStatePath,
  readNativeMainState,
} from "../../../../integrations/providers/native-main-state.ts";
import {
  isPidRunning,
  readServiceState,
} from "../../../../operations/service/native-service-supervisor.ts";

export interface AppTurnDispatchIntent {
  turnId: string;
  chatId: string;
  input: AppInboundInput;
  metadata: Record<string, unknown>;
  observedWakeRevisionRef: string;
  createdAt: string;
}

export interface AppTurnDispatchReconciliationSummary {
  inspected: number;
  committed: number;
  preserved: number;
}

interface AppTurnDispatchOutboxRow {
  turn_id: string;
  chat_id: string;
  input_json: string;
  metadata_json: string;
  state: "pending" | "committed" | "cancelled";
  observed_wake_revision_ref: string;
  queue_id: string | null;
  created_at: string;
  updated_at: string;
  committed_at: string | null;
}

export function appTransportExecutorWakeRevision(butlerData: string): string {
  const native = readNativeMainState(getNativeMainStatePath(butlerData));
  if (native && isPidRunning(native.pid)) {
    return `native-main:${native.pid}:${native.startedAt}`;
  }
  const service = readServiceState(butlerData, "butler-main");
  if (service && isPidRunning(service.pid)) {
    return `native-service:${service.pid}:${service.startedAt}`;
  }
  return [
    "executor-offline",
    native ? `${native.pid}:${native.startedAt}` : "native-missing",
    service ? `${service.pid}:${service.startedAt}` : "service-missing",
  ].join(":");
}

export function appTurnDispatchOutboxStorageRevision(dbPath: string): string {
  return [dbPath, `${dbPath}-wal`].map((path) => {
    const stat = statSync(path, { throwIfNoEntry: false });
    return stat ? `${stat.mtimeMs}:${stat.size}` : "missing";
  }).join("|");
}

export function recordAppTurnDispatchIntent(
  db: Database,
  intent: AppTurnDispatchIntent,
): void {
  const inputJson = JSON.stringify(intent.input);
  const metadataJson = JSON.stringify({
    ...intent.metadata,
    idempotencyKey: appTurnDispatchIdempotencyKey(intent.turnId),
  });
  db.query(`
    INSERT OR IGNORE INTO app_turn_dispatch_outbox (
      turn_id, chat_id, input_json, metadata_json, state,
      observed_wake_revision_ref, queue_id, created_at, updated_at, committed_at
    ) VALUES (?, ?, ?, ?, 'pending', ?, NULL, ?, ?, NULL)
  `).run(
    intent.turnId,
    intent.chatId,
    inputJson,
    metadataJson,
    intent.observedWakeRevisionRef,
    intent.createdAt,
    intent.createdAt,
  );
  const existing = requireDispatchRow(db, intent.turnId);
  if (
    existing.chat_id !== intent.chatId ||
    existing.input_json !== inputJson ||
    existing.metadata_json !== metadataJson
  ) {
    throw new Error("app_turn_dispatch_outbox_identity_conflict");
  }
}

export function markAppTurnDispatchCommitted(input: {
  db: Database;
  turnId: string;
  queueId: string;
  committedAt: string;
}): void {
  const result = input.db.query(`
    UPDATE app_turn_dispatch_outbox
    SET state = 'committed', queue_id = ?, committed_at = ?, updated_at = ?
    WHERE turn_id = ? AND state IN ('pending', 'committed')
      AND (queue_id IS NULL OR queue_id = ?)
  `).run(
    input.queueId,
    input.committedAt,
    input.committedAt,
    input.turnId,
    input.queueId,
  );
  if (result.changes !== 1) {
    const existing = requireDispatchRow(input.db, input.turnId);
    if (existing.state !== "committed" || existing.queue_id !== input.queueId) {
      throw new Error("app_turn_dispatch_outbox_commit_conflict");
    }
  }
}

export function markAppTurnDispatchWaiting(input: {
  db: Database;
  turnId: string;
  observedWakeRevisionRef: string;
  updatedAt: string;
}): void {
  input.db.query(`
    UPDATE app_turn_dispatch_outbox
    SET observed_wake_revision_ref = ?, updated_at = ?
    WHERE turn_id = ? AND state = 'pending'
  `).run(
    input.observedWakeRevisionRef,
    input.updatedAt,
    input.turnId,
  );
}

export function readAppTurnDispatchIntent(
  db: Database,
  turnId: string,
): AppTurnDispatchOutboxRow | null {
  return db.query<AppTurnDispatchOutboxRow, [string]>(`
    SELECT * FROM app_turn_dispatch_outbox WHERE turn_id = ?
  `).get(turnId);
}

export function reconcileAppTurnDispatchOutbox(input: {
  dbPath: string;
  butlerData: string;
  wakeRevisionRef: string;
  serviceClient?: ButlerServiceClient;
  limit?: number;
  now?: Date;
}): AppTurnDispatchReconciliationSummary {
  const summary: AppTurnDispatchReconciliationSummary = {
    inspected: 0,
    committed: 0,
    preserved: 0,
  };
  if (!existsSync(input.dbPath)) return summary;
  const db = new Database(input.dbPath);
  try {
    const rows = db.query<AppTurnDispatchOutboxRow, [string, number]>(`
      SELECT * FROM app_turn_dispatch_outbox
      WHERE state = 'pending' AND observed_wake_revision_ref != ?
      ORDER BY created_at ASC, turn_id ASC
      LIMIT ?
    `).all(input.wakeRevisionRef, Math.max(1, input.limit ?? 20));
    const serviceClient = input.serviceClient ??
      new FileQueueButlerServiceClient({ butlerData: input.butlerData });
    for (const row of rows) {
      summary.inspected += 1;
      const now = input.now ?? new Date();
      try {
        const appInput = parseAppInboundInput(row);
        const metadata = parseMetadata(row.metadata_json);
        const queued = serviceClient.enqueueAppTurn(appInput, metadata);
        markAppTurnDispatchCommitted({
          db,
          turnId: row.turn_id,
          queueId: queued.queueId,
          committedAt: now.toISOString(),
        });
        summary.committed += 1;
      } catch {
        markAppTurnDispatchWaiting({
          db,
          turnId: row.turn_id,
          observedWakeRevisionRef: input.wakeRevisionRef,
          updatedAt: now.toISOString(),
        });
        summary.preserved += 1;
      }
    }
    return summary;
  } finally {
    db.close();
  }
}

function parseAppInboundInput(row: AppTurnDispatchOutboxRow): AppInboundInput {
  const parsed: unknown = JSON.parse(row.input_json);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("app_turn_dispatch_input_invalid");
  }
  const candidate = parsed as Partial<AppInboundInput>;
  if (
    candidate.turnId !== row.turn_id ||
    candidate.chatId !== row.chat_id ||
    typeof candidate.messageId !== "string" ||
    typeof candidate.sessionId !== "string" ||
    typeof candidate.timestamp !== "string" ||
    typeof candidate.text !== "string"
  ) {
    throw new Error("app_turn_dispatch_input_identity_invalid");
  }
  return candidate as AppInboundInput;
}

function parseMetadata(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("app_turn_dispatch_metadata_invalid");
  }
  return parsed as Record<string, unknown>;
}

function requireDispatchRow(db: Database, turnId: string): AppTurnDispatchOutboxRow {
  const row = readAppTurnDispatchIntent(db, turnId);
  if (!row) throw new Error("app_turn_dispatch_outbox_missing");
  return row;
}

function appTurnDispatchIdempotencyKey(turnId: string): string {
  return `app-turn-dispatch:${turnId}`;
}
