import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { classifyHistoricalRows } from "./historical-recovery-classifier.ts";
import { historicalRecoverySourceRef } from "./historical-recovery-identity.ts";
import { buildHistoricalRecoveryReport } from "./historical-recovery-report.ts";
import type {
  HistoricalAppProjectionRow,
  HistoricalImportDecision,
  HistoricalRecoveryMapping,
  HistoricalRecoveryReport,
  HistoricalTranscriptRow,
  ImportOutcome,
} from "./historical-recovery-types.ts";
import { conversationSessionIdForDurableSession } from "./session-admission.ts";
import { AgentConversationStore } from "./store.ts";
import type { ConversationProvenance } from "./types.ts";

export function runHistoricalConversationRecovery(input: {
  butlerData: string;
  transcriptRows?: HistoricalTranscriptRow[];
  appRows?: HistoricalAppProjectionRow[];
  dryRun?: boolean;
}): HistoricalRecoveryReport {
  const dryRun = input.dryRun !== false;
  const decisions = classifyHistoricalRows(input);
  const store = new AgentConversationStore({ butlerData: input.butlerData });
  try {
    const outcomes = decisions.map((decision) => importDecision(store, decision, dryRun));
    return buildHistoricalRecoveryReport({ decisions, outcomes, dryRun });
  } finally {
    store.close();
  }
}

export function readHistoricalTranscriptRows(path: string): HistoricalTranscriptRow[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .flatMap((line, index) => {
      const trimmed = line.trim();
      if (!trimmed) return [];
      try {
        const parsed = JSON.parse(trimmed) as HistoricalTranscriptRow;
        return [{
          eventId: String(parsed.eventId ?? ""),
          sessionId: String(parsed.sessionId ?? ""),
          kind: String(parsed.kind ?? ""),
          timestamp: String(parsed.timestamp ?? ""),
          transport: typeof parsed.transport === "string" ? parsed.transport : null,
          payload: recordPayload(parsed.payload),
        }];
      } catch {
        return [{
          eventId: `malformed-line-${index + 1}`,
          sessionId: "unknown",
          kind: "malformed_json",
          timestamp: "",
          transport: null,
          payload: null,
        }];
      }
    });
}

export function readHistoricalAppProjectionRows(dbPath: string): HistoricalAppProjectionRow[] {
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    if (!hasTable(db, "messages")) return [];
    const conversationSession = hasColumn(db, "messages", "conversation_session_id") ? "conversation_session_id" : "NULL";
    const conversationTurn = hasColumn(db, "messages", "conversation_turn_id") ? "conversation_turn_id" : "NULL";
    const conversationMessage = hasColumn(db, "messages", "conversation_message_id") ? "conversation_message_id" : "NULL";
    return db.query<HistoricalAppProjectionRow, []>(`
      SELECT
        id,
        chat_id,
        role,
        text,
        created_at,
        ${conversationSession} AS conversation_session_id,
        ${conversationTurn} AS conversation_turn_id,
        ${conversationMessage} AS conversation_message_id
      FROM messages
      ORDER BY created_at ASC, id ASC
    `).all();
  } finally {
    db.close();
  }
}

function importDecision(
  store: AgentConversationStore,
  decision: HistoricalImportDecision,
  dryRun: boolean,
): ImportOutcome {
  if (!decision.admit || !decision.message) return { mapping: null, imported: false, skippedExisting: false };
  const conversationSessionId = decision.conversation_session_id ??
    conversationSessionIdForDurableSession(decision.session_id);
  const sourceRef = recoverySourceRef(decision);
  const existingBySource = store.readMessageBySourceRef(conversationSessionId, sourceRef) ??
    store.readMessageBySourceRefAnySession(sourceRef);
  const existingByMessageId = decision.conversation_message_id
    ? store.readMessageById(decision.conversation_message_id)
    : null;
  const mappedSessionId = existingBySource?.session_id ?? existingByMessageId?.session_id ?? conversationSessionId;
  const turnId = decision.conversation_turn_id ?? stableRecoveredId("ct", sourceRef);
  const messageId = existingBySource?.id ??
    existingByMessageId?.id ??
    decision.conversation_message_id ??
    stableRecoveredId("cm", sourceRef);
  const mapping = {
    source_kind: decision.source_kind,
    source_id: decision.source_id,
    conversation_session_id: mappedSessionId,
    conversation_message_id: messageId,
    status: (existingBySource || existingByMessageId ? "existing" : dryRun ? "planned" : "imported") as HistoricalRecoveryMapping["status"],
  };
  if (existingBySource || existingByMessageId || dryRun) {
    return { mapping, imported: false, skippedExisting: Boolean(existingBySource || existingByMessageId) };
  }
  const turn = store.beginTurn({
    gateway: "historical-recovery",
    externalSessionId: decision.session_id,
    sessionId: conversationSessionId,
    actor: decision.message.role === "user" ? "user" : "assistant",
    requestId: sourceRef,
    turnId,
    now: decision.message.created_at,
  });
  const append = decision.message.role === "user"
    ? store.appendUserMessage.bind(store)
    : store.appendAssistantMessage.bind(store);
  append({
    sessionId: conversationSessionId,
    turnId: turn.id,
    messageId,
    text: decision.message.text,
    provenance: decision.provenance as ConversationProvenance,
    sourceGateway: decision.source_kind === "transcript" ? "transcript-recovery" : "app-projection-recovery",
    sourceRef,
    now: decision.message.created_at,
  });
  store.finalizeTurn({
    turnId: turn.id,
    status: "complete",
    completedAt: decision.message.created_at,
  });
  return { mapping, imported: true, skippedExisting: false };
}

function recoverySourceRef(decision: HistoricalImportDecision): string {
  return historicalRecoverySourceRef(decision);
}

function stableRecoveredId(prefix: "cm" | "ct", value: string): string {
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${prefix}_recovered_${hash}`;
}

function recordPayload(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function hasTable(db: Database, table: string): boolean {
  return Boolean(db.query<{ name: string }, [string]>(
    "SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name = ?",
  ).get(table));
}

function hasColumn(db: Database, table: string, column: string): boolean {
  return db.query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => row.name === column);
}
