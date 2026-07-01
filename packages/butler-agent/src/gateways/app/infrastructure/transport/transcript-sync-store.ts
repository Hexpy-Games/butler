import { statSync } from "node:fs";
import { Database } from "bun:sqlite";
import type { TranscriptEvent } from "../../../../test-support/harness/transcripts.ts";
import { APP_TRANSPORT } from "../../../core/app-transport.ts";
import { sessionHintForRow } from "../../domain/sessions/session-read-model.ts";
import {
  readTranscriptEventsFromText,
  readTranscriptTextRange,
  transcriptPathFromDataHome,
} from "../../domain/sessions/transcript-reader.ts";

interface TranscriptSyncSnapshot {
  path: string;
  size: number;
  mtimeMs: number;
  trailing: string;
}

export class AppTransportTranscriptSyncStore {
  private readonly snapshots = new Map<string, TranscriptSyncSnapshot>();

  constructor(
    private readonly input: {
      db: Database;
      butlerData: string;
      projectDeliveryEvent: (event: TranscriptEvent) => boolean;
      projectOutboundEvent: (chatId: string, event: TranscriptEvent) => boolean;
    },
  ) {}

  syncAll(): number {
    const rows = this.input.db
      .query<{ id: string }, []>(
        `
      SELECT c.id
      FROM chats c
      WHERE c.archived = 0
        OR EXISTS (
          SELECT 1
          FROM turns t
          WHERE t.chat_id = c.id
            AND t.state IN ('accepted', 'thinking', 'running', 'waiting_user')
        )
    `,
      )
      .all();
    return rows.reduce((count, row) => count + this.syncChat(row.id), 0);
  }

  syncChat(chatId: string): number {
    const sessionId = sessionHintForRow(chatId);
    const transcriptPath = transcriptPathFromDataHome(
      this.input.butlerData,
      sessionId,
    );
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(transcriptPath);
    } catch {
      this.snapshots.delete(sessionId);
      return 0;
    }
    if (!stats.isFile()) {
      this.snapshots.delete(sessionId);
      return 0;
    }
    const previous = this.snapshots.get(sessionId);
    if (
      previous?.path === transcriptPath &&
      previous.size === stats.size &&
      previous.mtimeMs === stats.mtimeMs
    ) {
      return 0;
    }
    const incrementalStart =
      previous?.path === transcriptPath &&
      previous.size > 0 &&
      previous.size < stats.size
        ? previous.size
        : 0;
    const transcriptChunk =
      incrementalStart > 0
        ? readTranscriptTextRange(transcriptPath, incrementalStart, stats.size)
        : readTranscriptTextRange(transcriptPath, 0, stats.size);
    const text =
      incrementalStart > 0
        ? `${previous?.trailing ?? ""}${transcriptChunk}`
        : transcriptChunk;
    const parsed = readTranscriptEventsFromText(text);
    let applied = 0;
    for (const event of parsed.events) {
      if (event.transport !== APP_TRANSPORT) continue;
      if (event.kind === "delivery") {
        if (this.input.projectDeliveryEvent(event)) applied += 1;
        continue;
      }
      if (event.kind !== "outbound") continue;
      if (this.input.projectOutboundEvent(chatId, event)) applied += 1;
    }
    this.snapshots.set(sessionId, {
      path: transcriptPath,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      trailing: parsed.trailing,
    });
    return applied;
  }
}
