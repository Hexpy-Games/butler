import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { openOwnedSqliteConnection, type OwnedSqliteConnection } from
  "../../foundation/sqlite/owned-sqlite-connection.ts";
import {
  defaultConversationIdFactory,
  type ConversationIdFactory,
} from "./ids.ts";
import { ConversationStoreInternals } from "./store-internals.ts";
import type {
  AppendMessageInput,
  AppendToolPartInput,
  BeginTurnInput,
  ConversationBinding,
  ConversationMessageWithParts,
  ConversationPart,
  ConversationProjectionEvent,
  ConversationSession,
  ConversationSessionOverview,
  ConversationSummary,
  ConversationSummaryInput,
  ConversationTurn,
  FinalizeTurnInput,
  PromptMaterial,
  PromptMaterialInput,
  ReadAroundInput,
  ReadCognitionMessagesInput,
  ReadMessagesInput,
  TurnOutcomeCapsule,
  TurnOutcomeCapsuleInput,
} from "./types.ts";
import type { ConversationStoreDependencies } from "./store/dependencies.ts";
import { ConversationMessageRecords } from "./store/message-records.ts";
import { conversationMessagesSourceHash } from "./source-hash.ts";
import { ConversationProjectionRecords } from "./store/projection-records.ts";
import { ConversationSessionTurnRecords } from "./store/session-turn-records.ts";
import { ConversationSessionRecords } from "./store/session-records.ts";
import {
  ConversationSummaryPromptRecords,
  type ConversationSummaryStats,
} from "./store/summary-prompt-records.ts";
import {
  ConversationContextStatsRecords,
  type ConversationMessageStats,
} from "./store/context-stats.ts";

export { conversationMessagesSourceHash };

export interface ConversationContextStats {
  messages: ConversationMessageStats;
  summaries: ConversationSummaryStats;
  semanticTail: ConversationMessageWithParts[];
}

export function conversationStorePath(butlerData: string): string {
  return join(butlerData, "runtime", "conversation-store.sqlite");
}

export class AgentConversationStore {
  private readonly connection: OwnedSqliteConnection;
  private readonly messages: ConversationMessageRecords;
  private readonly contextStats: ConversationContextStatsRecords;
  private readonly projections: ConversationProjectionRecords;
  private readonly sessionsAndTurns: ConversationSessionTurnRecords;
  private readonly sessions: ConversationSessionRecords;
  private readonly summariesAndPrompts: ConversationSummaryPromptRecords;

  constructor(input: { butlerData: string; dbPath?: string; idFactory?: ConversationIdFactory }) {
    const dbPath = input.dbPath ?? conversationStorePath(input.butlerData);
    mkdirSync(dirname(dbPath), { recursive: true });
    this.connection = openOwnedSqliteConnection(dbPath);
    const dependencies = createStoreDependencies(
      this.connection.database,
      input.idFactory ?? defaultConversationIdFactory,
    );
    configureConversationDatabase(dependencies);
    this.messages = new ConversationMessageRecords(dependencies);
    this.contextStats = new ConversationContextStatsRecords(dependencies);
    this.sessionsAndTurns = new ConversationSessionTurnRecords(dependencies, this.messages);
    this.sessions = new ConversationSessionRecords(dependencies);
    this.summariesAndPrompts = new ConversationSummaryPromptRecords(
      dependencies,
      this.messages,
      this.contextStats,
      this.sessionsAndTurns,
    );
    this.projections = new ConversationProjectionRecords(dependencies);
  }

  close(): void {
    this.connection.close();
  }

  beginTurn(input: BeginTurnInput): ConversationTurn {
    return this.sessionsAndTurns.beginTurn(input);
  }

  finalizeTurn(input: FinalizeTurnInput): ConversationTurn {
    return this.sessionsAndTurns.finalizeTurn(input);
  }

  readTurn(turnId: string): ConversationTurn | null {
    return this.sessionsAndTurns.readTurn(turnId);
  }

  readTurnOutcome(turnId: string): TurnOutcomeCapsule | null {
    return this.sessionsAndTurns.readTurnOutcome(turnId);
  }

  readTurnOutcomeById(outcomeId: string): TurnOutcomeCapsule | null {
    return this.sessionsAndTurns.readTurnOutcomeById(outcomeId);
  }

  readTurnOutcomes(afterOutcomeId: string | null, limit = 100): TurnOutcomeCapsule[] {
    return this.projections.readTurnOutcomes(afterOutcomeId, limit);
  }

  writeTurnOutcome(input: TurnOutcomeCapsuleInput): TurnOutcomeCapsule {
    return this.sessionsAndTurns.writeTurnOutcome(input);
  }

  getSessionByGatewayBinding(
    gateway: string,
    externalSessionId: string,
  ): ConversationSession | null {
    return this.sessions.getSessionByGatewayBinding(gateway, externalSessionId);
  }

  getSession(sessionId: string): ConversationSession | null {
    return this.sessions.getSession(sessionId);
  }

  listSessions(input: {
    projectId?: string | null;
    includeArchived?: boolean;
    limit?: number;
  } = {}): ConversationSessionOverview[] {
    return this.sessions.listSessions(input);
  }

  getGatewayBindingForConversation(
    sessionId: string,
    gateway: string,
  ): ConversationBinding | null {
    return this.sessions.getGatewayBindingForConversation(sessionId, gateway);
  }

  appendUserMessage(input: Omit<AppendMessageInput, "role">): ConversationMessageWithParts {
    return this.messages.appendUserMessage(input);
  }

  appendAssistantMessage(input: Omit<AppendMessageInput, "role">): ConversationMessageWithParts {
    return this.messages.appendAssistantMessage(input);
  }

  appendToolCall(input: AppendToolPartInput): ConversationPart {
    return this.messages.appendToolCall(input);
  }

  appendToolResult(input: AppendToolPartInput): ConversationPart {
    return this.messages.appendToolResult(input);
  }

  readMessageById(messageId: string): ConversationMessageWithParts | null {
    return this.messages.readMessageById(messageId);
  }

  readMessageBySourceRef(
    sessionId: string,
    sourceRef: string,
  ): ConversationMessageWithParts | null {
    return this.messages.readMessageBySourceRef(sessionId, sourceRef);
  }

  readMessageBySourceRefAnySession(sourceRef: string): ConversationMessageWithParts | null {
    return this.messages.readMessageBySourceRefAnySession(sourceRef);
  }

  readMessages(input: ReadMessagesInput): ConversationMessageWithParts[] {
    return this.messages.readMessages(input);
  }

  readMessagesForTurn(turnId: string): ConversationMessageWithParts[] {
    return this.messages.readMessagesForTurn(turnId);
  }

  readCognitionMessages(
    input: ReadCognitionMessagesInput = {},
  ): ConversationMessageWithParts[] {
    return this.messages.readCognitionMessages(input);
  }

  readProjectionMessages(
    sessionId: string,
    input: { afterSeq?: number; limit?: number } = {},
  ): ConversationMessageWithParts[] {
    return this.messages.readProjectionMessages(sessionId, input);
  }

  readSemanticTail(sessionId: string, limit = 20): ConversationMessageWithParts[] {
    return this.messages.readSemanticTail(sessionId, limit);
  }

  /**
   * Bounded read model for periodic context diagnostics. Counters and latest
   * timestamps come from SQL aggregates; only the configured semantic tail is
   * hydrated for prompt estimation.
   */
  readContextStats(sessionId: string, semanticTailLimit = 200): ConversationContextStats {
    const summaries = this.summariesAndPrompts.readSummaryStats(sessionId);
    return {
      messages: this.contextStats.readMessageStats(sessionId),
      summaries,
      semanticTail: this.messages.readSemanticTail(sessionId, semanticTailLimit),
    };
  }

  readMessagesAround(input: ReadAroundInput): ConversationMessageWithParts[] {
    return this.messages.readMessagesAround(input);
  }

  writeSummary(input: ConversationSummaryInput): ConversationSummary {
    return this.summariesAndPrompts.writeSummary(input);
  }

  readSummaries(sessionId: string): ConversationSummary[] {
    return this.summariesAndPrompts.readSummaries(sessionId);
  }

  readPromptMaterial(input: PromptMaterialInput): PromptMaterial {
    return this.summariesAndPrompts.readPromptMaterial(input);
  }

  readProjectionBatch(afterOutboxId: string | null, limit = 100): ConversationProjectionEvent[] {
    return this.projections.readProjectionBatch(afterOutboxId, limit);
  }
}

function createStoreDependencies(
  db: Database,
  idFactory: ConversationIdFactory,
): ConversationStoreDependencies {
  return {
    db,
    idFactory,
    internals: new ConversationStoreInternals(db, idFactory),
  };
}

function configureConversationDatabase(dependencies: ConversationStoreDependencies): void {
  dependencies.db.exec("PRAGMA journal_mode=WAL");
  dependencies.db.exec("PRAGMA synchronous=NORMAL");
  dependencies.db.exec("PRAGMA foreign_keys=ON");
  dependencies.internals.ensureSchema();
}
