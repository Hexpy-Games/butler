import { existsSync } from "node:fs";
import type { Database } from "bun:sqlite";
import {
  coordinateSharedSqliteReader,
} from "../../foundation/sqlite-writer-coordination.ts";
import {
  openOwnedSqliteConnection,
  type OwnedSqliteConnection,
} from "../../foundation/sqlite/owned-sqlite-connection.ts";
import { defaultConversationIdFactory } from "./ids.ts";
import { ConversationStoreInternals } from "./store-internals.ts";
import type {
  ConversationMessageWithParts,
  ConversationProjectionReader,
} from "./types.ts";
import type { ConversationStoreDependencies } from "./store/dependencies.ts";
import { ConversationMessageRecords } from "./store/message-records.ts";
import { ConversationProjectionRecords } from "./store/projection-records.ts";
import { ConversationSessionTurnRecords } from "./store/session-turn-records.ts";
import { ConversationSessionRecords } from "./store/session-records.ts";
import { conversationStorePath } from "./store.ts";

const REQUIRED_TABLES = [
  "conversation_sessions",
  "conversation_bindings",
  "conversation_turns",
  "conversation_messages",
  "conversation_parts",
  "conversation_turn_outcomes",
  "conversation_projection_outbox",
  "conversation_schema_migrations",
] as const;

interface ProjectionReaderRecords {
  messages: ConversationMessageRecords;
  projections: ConversationProjectionRecords;
  sessionsAndTurns: ConversationSessionTurnRecords;
  sessions: ConversationSessionRecords;
}

export interface PublicSourceScopeInput {
  currentSessionId: string;
  currentProjectId: string | null;
  scope: "current_session" | "current_project" | "all_user_sessions";
  sessionIds: string[];
  projectIds: string[];
}

export interface PublicSourceMessagePageInput extends PublicSourceScopeInput {
  projectFilter: "any" | "unassigned" | "selected";
  includeInternal: boolean;
  speaker: "any" | "user" | "butler";
  eventKind: "any" | "inbound" | "outbound";
  order: "earliest" | "latest";
  time?: { from: string; to: string };
}

export interface PublicSourceSessionPageInput extends PublicSourceScopeInput {
  projectFilter: "any" | "unassigned" | "selected";
  includeInternal: boolean;
  includeArchived: boolean;
  time?: { from: string; to: string };
}

export type PublicSourceSessionRow = {
  id: string;
  workspace_id: string | null;
  project_id: string | null;
  gateway_origin: string;
  status: "active" | "archived" | "deleted";
  created_at: string;
  updated_at: string;
  message_count: number;
  last_eligible_message_at: string;
};

/** Canonical, transaction-bound operations used by public memory readers. */
export class ConversationPublicSourceSnapshot {
  constructor(
    private readonly db: Database,
    private readonly messages: ConversationMessageRecords,
  ) {}

  revision(): number {
    return Number(
      this.db.query<{ revision: number }, []>(
        "SELECT revision FROM conversation_public_source_state WHERE singleton=1",
      ).get()?.revision ?? 0,
    );
  }

  validateScope(input: PublicSourceScopeInput): boolean {
    const current = this.db.query<
      { id: string; project_id: string | null; status: string },
      [string]
    >("SELECT id,project_id,status FROM conversation_sessions WHERE id=?").get(
      input.currentSessionId,
    );
    if (
      !current || current.status === "deleted" ||
      current.project_id !== input.currentProjectId ||
      (input.scope === "current_project" && !input.currentProjectId)
    ) return false;
    for (const sessionId of input.sessionIds) {
      const row = this.db.query<
        { id: string; project_id: string | null; status: string },
        [string]
      >("SELECT id,project_id,status FROM conversation_sessions WHERE id=?")
        .get(
          sessionId,
        );
      if (
        !row || row.status === "deleted" ||
        (input.scope === "current_session" && row.id !== current.id) ||
        (input.scope === "current_project" &&
          row.project_id !== input.currentProjectId)
      ) return false;
    }
    if (
      input.projectIds.some((projectId) =>
        input.scope !== "all_user_sessions" &&
        projectId !== input.currentProjectId,
      )
    ) return false;
    return !input.projectIds.some((projectId) =>
      !this.db.query<{ found: number }, [string]>(
        "SELECT 1 found FROM conversation_sessions WHERE project_id=? AND status!='deleted' LIMIT 1",
      ).get(projectId),
    );
  }

  readMessagePage(
    input: PublicSourceMessagePageInput,
    after: { created_at: string; id: string } | null,
    limit: number,
  ): ConversationMessageWithParts[] {
    const clauses = publicMessageClauses(input);
    const params: Record<string, string | number> = { $limit: limit };
    bindPublicScope(clauses, params, input);
    if (input.speaker === "user" || input.eventKind === "inbound") {
      clauses.push("m.role='user'");
    }
    if (input.speaker === "butler" || input.eventKind === "outbound") {
      clauses.push("m.role='assistant'");
    }
    if (input.time) {
      clauses.push("m.created_at >= $from AND m.created_at < $to");
      params.$from = input.time.from;
      params.$to = input.time.to;
    }
    const direction = input.order === "latest" ? "DESC" : "ASC";
    if (after) {
      clauses.push(
        input.order === "latest"
          ? "(m.created_at < $after_at OR (m.created_at=$after_at AND m.id < $after_id))"
          : "(m.created_at > $after_at OR (m.created_at=$after_at AND m.id > $after_id))",
      );
      params.$after_at = after.created_at;
      params.$after_id = after.id;
    }
    const rows = this.db.query<{ id: string }, Record<string, string | number>>(
      `SELECT m.id FROM conversation_messages m JOIN conversation_sessions s ON s.id=m.session_id WHERE ${
        clauses.join(" AND ")
      } ORDER BY m.created_at ${direction},m.id ${direction} LIMIT $limit`,
    ).all(params);
    return rows.map((row) => this.messages.readMessageById(row.id)).filter(
      (message): message is ConversationMessageWithParts => message !== null,
    );
  }

  readSessionPage(
    input: PublicSourceSessionPageInput,
    after: { last_at: string; session_id: string } | null,
    limit: number,
  ): PublicSourceSessionRow[] {
    const clauses = publicMessageClauses(input);
    const params: Record<string, string | number> = { $limit: limit };
    bindPublicScope(clauses, params, input);
    if (!input.includeArchived) clauses.push("s.status!='archived'");
    if (input.time) {
      clauses.push("m.created_at >= $from AND m.created_at < $to");
      params.$from = input.time.from;
      params.$to = input.time.to;
    }
    if (after) {
      params.$cursor_at = after.last_at;
      params.$cursor_session = after.session_id;
    }
    return this.db.query<
      PublicSourceSessionRow,
      Record<string, string | number>
    >(
      `SELECT s.*,COUNT(DISTINCT m.id) message_count,MAX(m.created_at) last_eligible_message_at FROM conversation_sessions s JOIN conversation_messages m ON m.session_id=s.id WHERE ${
        clauses.join(" AND ")
      } GROUP BY s.id ${
        after
          ? "HAVING last_eligible_message_at < $cursor_at OR (last_eligible_message_at=$cursor_at AND s.id>$cursor_session)"
          : ""
      } ORDER BY last_eligible_message_at DESC,s.id ASC LIMIT $limit`,
    ).all(params);
  }

  readPreviewMessages(input: {
    sessionId: string;
    includeInternal: boolean;
    time?: { from: string; to: string };
    limit: number;
  }): ConversationMessageWithParts[] {
    const rows = this.db.query<{ id: string }, Record<string, string | number>>(
      `SELECT m.id FROM conversation_messages m WHERE m.session_id=$id AND m.visibility='model' AND m.status IN ('complete','compacted') AND m.role IN ('user','assistant') ${
        input.includeInternal
          ? ""
          : "AND m.origin_kind IN ('user_input','assistant_public')"
      } ${
        input.time ? "AND m.created_at >= $from AND m.created_at < $to" : ""
      } ORDER BY m.created_at DESC,m.id DESC LIMIT $limit`,
    ).all({
      $id: input.sessionId,
      $limit: input.limit,
      ...(input.time ? { $from: input.time.from, $to: input.time.to } : {}),
    });
    return rows.map((row) => this.messages.readMessageById(row.id)).filter(
      (message): message is ConversationMessageWithParts => message !== null,
    ).reverse();
  }

  getGatewayBindingForConversation(sessionId: string, gateway: string) {
    return this.db.query<{ external_session_id: string }, [string, string]>(
      "SELECT external_session_id FROM conversation_bindings WHERE conversation_session_id=? AND gateway=? ORDER BY created_at LIMIT 1",
    ).get(sessionId, gateway) ?? null;
  }
}

/**
 * Read-only view over the canonical conversation database.
 *
 * The Agent owns schema creation and all writes. The App Gateway never opens a
 * write-capable AgentConversationStore for projection reads: it opens a lazy,
 * query-only connection once the canonical file and schema are available.
 * Missing/in-flight databases are represented by empty reads and retried on the
 * next projection pass, so App startup does not become the schema authority.
 */
export class ConversationProjectionReaderStore
  implements ConversationProjectionReader {
  private connection: OwnedSqliteConnection | null = null;
  private records: ProjectionReaderRecords | null = null;
  private closed = false;

  constructor(private readonly dbPath: string) {}

  isAvailable(): boolean {
    return this.open() !== null;
  }

  readProjectionBatch(afterOutboxId: string | null, limit = 100) {
    return this.open()?.projections.readProjectionBatch(afterOutboxId, limit) ??
      [];
  }

  getSession(sessionId: string) {
    return this.open()?.sessions.getSession(sessionId) ?? null;
  }

  listSessions(input: {
    projectId?: string | null;
    includeArchived?: boolean;
    limit?: number;
  } = {}) {
    return this.open()?.sessions.listSessions(input) ?? [];
  }

  readTurn(turnId: string) {
    return this.open()?.sessionsAndTurns.readTurn(turnId) ?? null;
  }

  getGatewayBindingForConversation(sessionId: string, gateway: string) {
    return this.open()?.sessions.getGatewayBindingForConversation(
      sessionId,
      gateway,
    ) ?? null;
  }

  readTurnOutcomeById(outcomeId: string) {
    return this.open()?.sessionsAndTurns.readTurnOutcomeById(outcomeId) ?? null;
  }

  readTurnOutcome(turnId: string) {
    return this.open()?.sessionsAndTurns.readTurnOutcome(turnId) ?? null;
  }

  readTurnOutcomes(afterOutcomeId: string | null, limit = 100) {
    return this.open()?.projections.readTurnOutcomes(afterOutcomeId, limit) ??
      [];
  }

  readRecoveredSourceMessages(afterMessageId: string | null, limit = 100) {
    return this.open()?.projections.readRecoveredSourceMessages(
      afterMessageId,
      limit,
    ) ?? [];
  }

  readMessageById(messageId: string) {
    return this.open()?.messages.readMessageById(messageId) ?? null;
  }

  readCurrentUserRequestForTurn(turnId: string) {
    const records = this.open();
    if (!records) return null;
    const matches = records.messages.readMessagesForTurn(turnId).filter(
      (message) =>
        message.role === "user" && message.origin_kind === "user_input" &&
        message.turn_id === turnId,
    );
    return matches.length === 1 ? matches[0]! : null;
  }

  readPublicSourceRevision(): number {
    const records = this.open();
    if (!records || !this.connection) return 0;
    return Number(
      this.connection.database.query<{ revision: number }, []>(
        "SELECT revision FROM conversation_public_source_state WHERE singleton=1",
      ).get()?.revision ?? 0,
    );
  }

  withPublicSourceSnapshot<T>(
    read: (snapshot: ConversationPublicSourceSnapshot) => T,
  ): T | undefined {
    const records = this.open();
    if (!records || !this.connection) return undefined;
    return this.connection.database.transaction(() =>
      read(
        new ConversationPublicSourceSnapshot(
          this.connection!.database,
          records.messages,
        ),
      ),
    )();
  }

  readProjectionMessages(
    sessionId: string,
    input: { afterSeq?: number; limit?: number } = {},
  ) {
    return this.open()?.messages.readProjectionMessages(sessionId, input) ?? [];
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.records = null;
    this.connection?.close();
    this.connection = null;
  }

  private open(): ProjectionReaderRecords | null {
    if (this.closed) return null;
    if (this.records) return this.records;
    if (!existsSync(this.dbPath)) return null;

    let connection: OwnedSqliteConnection | null = null;
    try {
      connection = openOwnedSqliteConnection(this.dbPath, { readonly: true });
      coordinateSharedSqliteReader(connection.database);
      if (!hasCanonicalSchema(connection.database)) {
        connection.close();
        return null;
      }
      const dependencies: ConversationStoreDependencies = {
        db: connection.database,
        idFactory: defaultConversationIdFactory,
        internals: new ConversationStoreInternals(
          connection.database,
          defaultConversationIdFactory,
        ),
      };
      const messages = new ConversationMessageRecords(dependencies);
      this.connection = connection;
      this.records = {
        messages,
        projections: new ConversationProjectionRecords(dependencies),
        sessionsAndTurns: new ConversationSessionTurnRecords(
          dependencies,
          messages,
        ),
        sessions: new ConversationSessionRecords(dependencies),
      };
      return this.records;
    } catch (error) {
      connection?.close();
      // A writer may have created or replaced the file between existsSync and
      // the read-only open. Retry on the next projection pass only when the
      // canonical file is still unavailable; surface real schema/I/O errors.
      if (!existsSync(this.dbPath)) return null;
      throw error;
    }
  }
}

function publicMessageClauses(input: { includeInternal: boolean }): string[] {
  const clauses = [
    "m.visibility='model'",
    "m.status IN ('complete','compacted')",
    "m.role IN ('user','assistant')",
    "s.status!='deleted'",
  ];
  if (!input.includeInternal) {
    clauses.push("m.origin_kind IN ('user_input','assistant_public')");
  }
  return clauses;
}

function bindPublicScope(
  clauses: string[],
  params: Record<string, string | number>,
  input: PublicSourceScopeInput & {
    projectFilter: "any" | "unassigned" | "selected";
  },
): void {
  if (input.scope === "current_session") {
    clauses.push("m.session_id=$current_session");
    params.$current_session = input.currentSessionId;
  }
  if (input.scope === "current_project") {
    clauses.push("s.project_id=$current_project");
    params.$current_project = input.currentProjectId!;
  }
  if (input.sessionIds.length) {
    clauses.push(
      `m.session_id IN (${
        input.sessionIds.map((_, i) => `$session${i}`).join(",")
      })`,
    );
    input.sessionIds.forEach((value, index) => {
      params[`$session${index}`] = value;
    });
  }
  if (input.projectFilter === "unassigned") {
    clauses.push("s.project_id IS NULL");
  }
  if (input.projectFilter === "selected") {
    clauses.push(
      `s.project_id IN (${
        input.projectIds.map((_, i) => `$project${i}`).join(",")
      })`,
    );
    input.projectIds.forEach((value, index) => {
      params[`$project${index}`] = value;
    });
  }
}

function hasCanonicalSchema(db: Database): boolean {
  for (const table of REQUIRED_TABLES) {
    const row = db.query<{ name: string }, [string]>(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = ?
      LIMIT 1
    `).get(table);
    if (!row) return false;
  }
  return true;
}

export function createLazyConversationProjectionReader(input: {
  butlerData: string;
  dbPath?: string;
}): ConversationProjectionReaderStore {
  return new ConversationProjectionReaderStore(
    input.dbPath ?? conversationStorePath(input.butlerData),
  );
}
