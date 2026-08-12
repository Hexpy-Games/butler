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
import type { ConversationProjectionReader } from "./types.ts";
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

/**
 * Read-only view over the canonical conversation database.
 *
 * The Agent owns schema creation and all writes. The App Gateway never opens a
 * write-capable AgentConversationStore for projection reads: it opens a lazy,
 * query-only connection once the canonical file and schema are available.
 * Missing/in-flight databases are represented by empty reads and retried on the
 * next projection pass, so App startup does not become the schema authority.
 */
export class ConversationProjectionReaderStore implements ConversationProjectionReader {
  private connection: OwnedSqliteConnection | null = null;
  private records: ProjectionReaderRecords | null = null;
  private closed = false;

  constructor(private readonly dbPath: string) {}

  isAvailable(): boolean {
    return this.open() !== null;
  }

  readProjectionBatch(afterOutboxId: string | null, limit = 100) {
    return this.open()?.projections.readProjectionBatch(afterOutboxId, limit) ?? [];
  }

  getSession(sessionId: string) {
    return this.open()?.sessions.getSession(sessionId) ?? null;
  }

  getGatewayBindingForConversation(sessionId: string, gateway: string) {
    return this.open()?.sessions.getGatewayBindingForConversation(sessionId, gateway) ?? null;
  }

  readTurnOutcomeById(outcomeId: string) {
    return this.open()?.sessionsAndTurns.readTurnOutcomeById(outcomeId) ?? null;
  }

  readTurnOutcome(turnId: string) {
    return this.open()?.sessionsAndTurns.readTurnOutcome(turnId) ?? null;
  }

  readTurnOutcomes(afterOutcomeId: string | null, limit = 100) {
    return this.open()?.projections.readTurnOutcomes(afterOutcomeId, limit) ?? [];
  }

  readMessageById(messageId: string) {
    return this.open()?.messages.readMessageById(messageId) ?? null;
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
        sessionsAndTurns: new ConversationSessionTurnRecords(dependencies, messages),
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
}): ConversationProjectionReaderStore {
  return new ConversationProjectionReaderStore(conversationStorePath(input.butlerData));
}
