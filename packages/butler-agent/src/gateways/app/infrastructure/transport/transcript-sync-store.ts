import { statSync } from "node:fs";
import type { Stats } from "node:fs";
import type { Database } from "bun:sqlite";
import type { TranscriptEvent } from "../../../../test-support/harness/transcripts.ts";
import { APP_TRANSPORT } from "../../../core/app-transport.ts";
import { sessionHintForRow } from "../../domain/sessions/session-read-model.ts";
import { transcriptPathFromDataHome } from "../../domain/sessions/transcript-reader.ts";
import {
  advanceTranscriptBoundaryAnchor,
  parseTranscriptRecord,
  readTranscriptBoundaryAnchor,
  readTranscriptByteWindow,
} from "./transcript-byte-window.ts";
import {
  TranscriptProjectionCheckpointStore,
  type TranscriptProjectionCheckpoint,
} from "./transcript-projection-checkpoint-store.ts";
import { TranscriptLargeRecordSpool } from "./transcript-large-record-spool.ts";

export type TranscriptProjectionDiagnostic = {
  chatId: string;
  path: string;
  byteOffset: number;
  code: "invalid_utf8" | "invalid_json" | "invalid_record";
};

export type SyncWindowResult = { applied: number; pending: boolean };
const CHAT_DISCOVERY_PAGE_SIZE = 32;

export class AppTransportTranscriptSyncStore {
  private readonly checkpoints: TranscriptProjectionCheckpointStore;
  private readonly largeRecords: TranscriptLargeRecordSpool;
  private scanActive = false;
  private scanCursor = 0;
  private scanDiscoveryComplete = false;
  private preferPendingChat = false;
  private readonly pendingChatIds: string[] = [];
  private readonly discoveredChatIds: string[] = [];

  constructor(
    private readonly input: {
      db: Database;
      butlerData: string;
      projectDeliveryEvent: (event: TranscriptEvent) => boolean;
      projectOutboundEvent: (chatId: string, event: TranscriptEvent) => boolean;
      recordDiagnostic?: (diagnostic: TranscriptProjectionDiagnostic) => void;
    },
  ) {
    this.checkpoints = new TranscriptProjectionCheckpointStore(input.db);
    this.largeRecords = new TranscriptLargeRecordSpool(input.butlerData);
  }

  syncNextBatch(limit = 2): { applied: number; pending: boolean } {
    if (!this.scanActive) {
      this.scanActive = true;
      this.scanCursor = 0;
      this.scanDiscoveryComplete = false;
      this.preferPendingChat = false;
      this.pendingChatIds.length = 0;
      this.discoveredChatIds.length = 0;
    }
    let applied = 0;
    for (let operation = 0; operation < limit; operation += 1) {
      const chatId = this.nextChatId();
      if (!chatId) break;
      const result = this.syncChatWindow(chatId);
      applied += result.applied;
      if (result.pending) this.pendingChatIds.push(chatId);
    }
    const pending = !this.scanDiscoveryComplete ||
      this.discoveredChatIds.length > 0 || this.pendingChatIds.length > 0;
    if (!pending) this.resetScan();
    return { applied, pending };
  }

  syncChatWindow(chatId: string): SyncWindowResult {
    return this.projectChatWindow(chatId);
  }

  private projectChatWindow(chatId: string): SyncWindowResult {
    const sessionId = sessionHintForRow(chatId);
    const path = transcriptPathFromDataHome(this.input.butlerData, sessionId);
    let stats: Stats;
    try {
      stats = statSync(path);
    } catch {
      return { applied: 0, pending: false };
    }
    if (!stats.isFile()) return { applied: 0, pending: false };

    const prior = this.checkpoints.load(chatId);
    if (!prior?.spoolPath) this.largeRecords.discardOrphan(chatId, path);
    const reusePrior = reusableCheckpoint(prior, path, stats, this.largeRecords);
    if (!reusePrior && prior?.spoolPath) {
      this.largeRecords.discard(chatId, prior.spoolPath);
    }
    const checkpoint = reusePrior
      ? prior!
      : freshCheckpoint(chatId, sessionId, path, stats);
    if (checkpoint.spoolEndOffset > 0) {
      return this.parseSpooledRecord(chatId, checkpoint, stats);
    }
    const readPosition = checkpoint.projectedBytes +
      (checkpoint.spoolBytes || checkpoint.trailing.byteLength);
    if (
      readPosition === stats.size &&
      checkpoint.trailing.indexOf(0x0a) < 0 &&
      checkpoint.modifiedAtMs === stats.mtimeMs
    ) {
      return { applied: 0, pending: false };
    }

    if (checkpoint.spoolBytes > 0) {
      const extended = this.largeRecords.extend(checkpoint, stats);
      this.checkpoints.save(extended.checkpoint);
      return { applied: 0, pending: extended.pending };
    }

    const window = readTranscriptByteWindow({
      path,
      committedOffset: checkpoint.projectedBytes,
      trailing: checkpoint.trailing,
      fileSize: stats.size,
    });
    let applied = 0;
    let current = checkpoint;
    if (window.lines.length === 0) {
      if (window.remainder.byteLength > 0) {
        this.checkpoints.save(this.largeRecords.start(
          chatId,
          current,
          window.remainder,
          stats.mtimeMs,
        ));
        return { applied, pending: window.readEnd < window.fileSize };
      }
      this.checkpoints.save({
        ...current,
        modifiedAtMs: stats.mtimeMs,
        trailing: window.remainder,
      });
      return {
        applied,
        pending: window.readEnd < window.fileSize,
      };
    }

    for (const line of window.lines) {
      const parsed = parseTranscriptRecord(line.bytes);
      if (parsed.kind === "invalid") {
        this.input.recordDiagnostic?.({
          chatId,
          path,
          byteOffset: current.projectedBytes,
          code: parsed.code,
        });
        return { applied, pending: false };
      }
      const next = {
        ...current,
        device: stats.dev,
        inode: stats.ino,
        projectedBytes: line.endOffset,
        modifiedAtMs: stats.mtimeMs,
        trailing: line.remaining,
        boundaryAnchor: advanceTranscriptBoundaryAnchor(
          current.boundaryAnchor,
          line.bytes,
        ),
      };
      this.input.db.transaction(() => {
        if (parsed.kind === "event" && this.projectEvent(chatId, parsed.event)) {
          applied += 1;
        }
        this.checkpoints.save(next);
      })();
      current = next;
    }
    return {
      applied,
      pending:
        current.trailing.indexOf(0x0a) >= 0 ||
        current.projectedBytes + current.trailing.byteLength < stats.size,
    };
  }

  private parseSpooledRecord(
    chatId: string,
    checkpoint: TranscriptProjectionCheckpoint,
    stats: Stats,
  ): SyncWindowResult {
    const result = this.largeRecords.parseNext(chatId, checkpoint, stats);
    if (result.kind === "pending") return { applied: 0, pending: true };
    if (result.kind === "invalid") {
      this.input.recordDiagnostic?.({
        chatId,
        path: checkpoint.path,
        byteOffset: checkpoint.projectedBytes,
        code: result.code,
      });
      return { applied: 0, pending: false };
    }
    let applied = 0;
    this.input.db.transaction(() => {
      if (this.projectEvent(chatId, result.event)) applied += 1;
      this.checkpoints.save(result.checkpoint);
    })();
    this.largeRecords.complete(chatId, checkpoint.spoolPath);
    return {
      applied,
      pending:
        result.checkpoint.trailing.indexOf(0x0a) >= 0 ||
        result.checkpoint.projectedBytes +
          result.checkpoint.trailing.byteLength < stats.size,
    };
  }

  private projectEvent(chatId: string, event: TranscriptEvent): boolean {
    if (event.transport !== APP_TRANSPORT) return false;
    if (event.kind === "delivery") return this.input.projectDeliveryEvent(event);
    if (event.kind !== "outbound") return false;
    return this.input.projectOutboundEvent(chatId, event);
  }

  private nextChatId(): string | null {
    const canDiscover = (!this.scanDiscoveryComplete ||
      this.discoveredChatIds.length > 0) &&
      this.pendingChatIds.length < 64;
    const usePending = this.pendingChatIds.length > 0 &&
      (this.preferPendingChat || !canDiscover);
    this.preferPendingChat = !usePending;
    if (usePending) return this.pendingChatIds.shift() ?? null;
    if (!canDiscover) return this.pendingChatIds.shift() ?? null;
    const discovered = this.discoveredChatIds.shift();
    if (discovered) return discovered;
    this.loadChatDiscoveryPage();
    return this.discoveredChatIds.shift() ?? null;
  }

  private loadChatDiscoveryPage(): void {
    const rows = this.input.db.query<
      { id: string; row_id: number; archived: number },
      [number, number]
    >(`
      SELECT id, rowid AS row_id, archived FROM chats
      WHERE rowid > ?
      ORDER BY rowid
      LIMIT ?
    `).all(this.scanCursor, CHAT_DISCOVERY_PAGE_SIZE + 1);
    const page = rows.slice(0, CHAT_DISCOVERY_PAGE_SIZE);
    this.scanCursor = page.at(-1)?.row_id ?? this.scanCursor;
    this.scanDiscoveryComplete = rows.length <= CHAT_DISCOVERY_PAGE_SIZE;
    const archivedIds = page.filter((row) => row.archived !== 0)
      .map((row) => row.id);
    const activeArchived = this.activeTurnChatIds(archivedIds);
    for (const row of page) {
      if (row.archived === 0 || activeArchived.has(row.id)) {
        this.discoveredChatIds.push(row.id);
      }
    }
  }

  private activeTurnChatIds(chatIds: string[]): Set<string> {
    if (chatIds.length === 0) return new Set();
    const placeholders = chatIds.map(() => "?").join(", ");
    const rows = this.input.db.query<{ chat_id: string }, string[]>(`
      SELECT DISTINCT chat_id FROM turns
      WHERE chat_id IN (${placeholders})
        AND state IN ('accepted', 'thinking', 'running', 'waiting_user')
    `).all(...chatIds);
    return new Set(rows.map((row) => row.chat_id));
  }

  private resetScan(): void {
    this.scanActive = false;
    this.scanCursor = 0;
    this.scanDiscoveryComplete = false;
    this.preferPendingChat = false;
    this.pendingChatIds.length = 0;
    this.discoveredChatIds.length = 0;
  }
}

function reusableCheckpoint(
  checkpoint: TranscriptProjectionCheckpoint | null,
  path: string,
  stats: Stats,
  largeRecords: TranscriptLargeRecordSpool,
): boolean {
  return Boolean(
    checkpoint && checkpoint.path === path &&
    checkpoint.device === stats.dev && checkpoint.inode === stats.ino &&
    checkpointReadEnd(checkpoint) <= stats.size &&
    (checkpoint.spoolBytes > 0
      ? checkpoint.boundaryAnchor.equals(
          readTranscriptBoundaryAnchor(path, checkpoint.projectedBytes),
        ) && largeRecords.matchesSource(checkpoint)
      : checkpoint.boundaryAnchor.equals(
          readTranscriptBoundaryAnchor(path, checkpoint.projectedBytes),
        )),
  );
}

function checkpointReadEnd(checkpoint: TranscriptProjectionCheckpoint): number {
  if (checkpoint.spoolEndOffset > 0) {
    return checkpoint.spoolEndOffset + checkpoint.trailing.byteLength;
  }
  return checkpoint.projectedBytes + checkpoint.spoolBytes +
    checkpoint.trailing.byteLength;
}

function freshCheckpoint(
  chatId: string,
  sessionId: string,
  path: string,
  stats: Stats,
): TranscriptProjectionCheckpoint {
  return {
    chatId,
    sessionId,
    path,
    device: stats.dev,
    inode: stats.ino,
    projectedBytes: 0,
    modifiedAtMs: stats.mtimeMs,
    trailing: Buffer.alloc(0),
    boundaryAnchor: Buffer.alloc(0),
    spoolPath: "",
    spoolBytes: 0,
    spoolEndOffset: 0,
  };
}
