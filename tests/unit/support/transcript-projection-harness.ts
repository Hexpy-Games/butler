import { Database } from "bun:sqlite";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateAppStoreSchema } from
  "../../../packages/butler-agent/src/gateways/app/infrastructure/core/schema.ts";
import { AppTransportTranscriptSyncStore } from
  "../../../packages/butler-agent/src/gateways/app/infrastructure/transport/transcript-sync-store.ts";
import { AppProjectedTransportEventStore } from
  "../../../packages/butler-agent/src/gateways/app/infrastructure/transport/projected-transport-event-store.ts";
import { AppTransportProjectionStore } from
  "../../../packages/butler-agent/src/gateways/app/infrastructure/transport/transport-projection-store.ts";
import type { AppTransportProjectionStoreOptions } from
  "../../../packages/butler-agent/src/gateways/app/infrastructure/transport/transport-projection-contract.ts";
import { transcriptPathFromDataHome } from
  "../../../packages/butler-agent/src/gateways/app/domain/sessions/transcript-reader.ts";
import { sessionHintForRow } from
  "../../../packages/butler-agent/src/gateways/app/domain/sessions/session-read-model.ts";
import type { TranscriptEvent } from
  "../../../packages/butler-agent/src/test-support/harness/transcripts.ts";

const roots: string[] = [];

export function cleanupTranscriptProjectionHarnesses(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

export function createTranscriptProjectionHarness(
  diagnostics: Array<{ code: string; byteOffset: number }> = [],
) {
  const root = mkdtempSync(join(tmpdir(), "butler-transcript-checkpoint-"));
  roots.push(root);
  const db = new Database(join(root, "app.sqlite"), { create: true });
  migrateAppStoreSchema(db);
  db.exec("CREATE TABLE projected_actions (action_id TEXT PRIMARY KEY)");
  const projectedTexts = new Map<string, string>();
  const chatId = "checkpoint-chat";
  const now = new Date().toISOString();
  db.query(`
    INSERT INTO chats (id, title, kind, created_at, updated_at)
    VALUES (?, 'Checkpoint', 'chat', ?, ?)
  `).run(chatId, now, now);
  mkdirSync(join(root, "transcripts"), { recursive: true });
  return {
    root,
    db,
    chatId,
    createSync(fail = false) {
      const receipts = new AppProjectedTransportEventStore(db);
      return new AppTransportTranscriptSyncStore({
        db,
        butlerData: root,
        projectDeliveryEvent: () => false,
        projectOutboundEvent: (targetChatId, event) => {
          if (fail) throw new Error("projection failed");
          const actionId = String(event.payload.actionId);
          if (receipts.has(actionId)) return false;
          const applied = db.query(
            "INSERT OR IGNORE INTO projected_actions (action_id) VALUES (?)",
          ).run(actionId).changes === 1;
          if (applied) {
            const message = event.payload.message as Record<string, unknown>;
            projectedTexts.set(actionId, String(message.text));
          }
          receipts.mark(actionId, event.eventId, targetChatId);
          return applied;
        },
        recordDiagnostic: (diagnostic) => diagnostics.push({
          code: diagnostic.code,
          byteOffset: diagnostic.byteOffset,
        }),
      });
    },
    createProjectionStore(
      overrides: Partial<AppTransportProjectionStoreOptions> = {},
    ) {
      return new AppTransportProjectionStore({
        db,
        butlerData: root,
        butlerHome: root,
        messageFiles: { createResponderFiles: () => [] } as never,
        appendEvent: () => ({}) as never,
        getChatRow: () => null,
        getProjectRow: () => null,
        getTurnRow: () => ({ state: "running" }) as never,
        getTurn: () => ({}) as never,
        getMessageRow: () => null,
        getLatestAssistantMessageForTurn: () => null,
        hasTurnEventKind: () => false,
        appendTurnEvent: () => ({}) as never,
        appendProgressSummaryEvent: (_chatId, _turnId, row) => {
          db.query(
            "INSERT OR IGNORE INTO projected_actions (action_id) VALUES (?)",
          ).run(row.id);
          return row as never;
        },
        hasEquivalentProgressSummaryRow: () => false,
        touchChat: () => undefined,
        insertMessage: () => ({}) as never,
        insertOrReplaceAssistantReplies: () => [],
        updateTurnState: () => ({}) as never,
        appendTerminalTurnStateChanged: () => undefined,
        finalizeResponderLimitedDelivery: () => ({}) as never,
        finalizeCancelledTurn: () => ({}) as never,
        upsertAssistantTurnFailure: () => ({}) as never,
        runtimeFaultRecordForTurn: () => null,
        generatedSessionTitleHandler: () => undefined,
        drainQueuedSessionMessages: async () => undefined,
        queuedTurnClaimStatus: () => "unlinked",
        fenceQueuedTurnClaim: () => true,
        acknowledgeQueuedMessageForTurn: () => true,
        ...overrides,
      });
    },
    projected: () => db.query<{ action_id: string }, []>(
      "SELECT action_id FROM projected_actions ORDER BY rowid",
    ).all().map((row) => row.action_id),
    projectedText: (actionId: string) => projectedTexts.get(actionId),
    checkpointCount: () => db.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM app_transcript_projection_checkpoints",
    ).get()?.count ?? 0,
    checkpoint: () => db.query<{
      projected_bytes: number;
      trailing_text: string;
      spool_path: string;
      spool_bytes: number;
      spool_end_offset: number;
    }, [string]>(`
      SELECT projected_bytes, trailing_text, spool_path, spool_bytes,
        spool_end_offset
      FROM app_transcript_projection_checkpoints
      WHERE chat_id = ?
    `).get(chatId),
    deleteCompatibilityReceipts: () =>
      db.query("DELETE FROM projected_transport_events").run(),
    durableReceiptCount: () => db.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM app_transport_projection_receipts",
    ).get()?.count ?? 0,
    legacyReceiptCount: () => db.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM projected_transport_events",
    ).get()?.count ?? 0,
    close: () => db.close(),
  };
}

export type TranscriptProjectionHarness = ReturnType<
  typeof createTranscriptProjectionHarness
>;

export function addTranscriptChat(
  harness: TranscriptProjectionHarness,
  chatId: string,
): void {
  const now = new Date().toISOString();
  harness.db.query(`
    INSERT INTO chats (id, title, kind, created_at, updated_at)
    VALUES (?, 'Batch', 'chat', ?, ?)
  `).run(chatId, now, now);
}

export function writeTranscript(
  harness: TranscriptProjectionHarness,
  events: unknown[],
  chatId = harness.chatId,
): void {
  writeFileSync(
    transcriptPath(harness, chatId),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
}

export function appendTranscript(
  harness: TranscriptProjectionHarness,
  event: unknown,
): void {
  appendFileSync(transcriptPath(harness), `${JSON.stringify(event)}\n`);
}

export function transcriptPath(
  harness: TranscriptProjectionHarness,
  chatId = harness.chatId,
): string {
  return transcriptPathFromDataHome(harness.root, sessionHintForRow(chatId));
}

export function outbound(actionId: string, text = actionId): TranscriptEvent {
  return {
    eventId: `event-${actionId}`,
    sessionId: "runtime-session",
    kind: "outbound",
    timestamp: new Date().toISOString(),
    transport: "app",
    payload: { actionId, message: { text }, metadata: {} },
  };
}
