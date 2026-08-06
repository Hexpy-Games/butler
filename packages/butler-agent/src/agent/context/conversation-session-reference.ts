import { AgentConversationStore } from "../conversation/store.ts";
import type {
  ConversationBinding,
  ConversationSession,
  ConversationSessionOverview,
} from "../conversation/types.ts";
import {
  canonicalConversationSessionId,
  readConversationContext,
  type ConversationContextDirection,
  type ConversationContextResult,
} from "./conversation-context.ts";
import {
  toContextMessage,
  type ConversationContextMessage,
} from "./conversation-context-format.ts";
import { readAppConversationSessionCatalog } from
  "./conversation-session-catalog-compat.ts";

export type ConversationSessionReferenceScope = "current_project" | "all_sessions";

export interface ConversationSessionReferenceReader {
  close?(): void;
  getSession(sessionId: string): ConversationSession | null;
  getSessionByGatewayBinding(gateway: string, externalSessionId: string): ConversationSession | null;
  getGatewayBindingForConversation(sessionId: string, gateway: string): ConversationBinding | null;
  listSessions(input?: {
    projectId?: string | null;
    includeArchived?: boolean;
    limit?: number;
  }): ConversationSessionOverview[];
  readMessageById: AgentConversationStore["readMessageById"];
  readMessageBySourceRef: AgentConversationStore["readMessageBySourceRef"];
  readMessages: AgentConversationStore["readMessages"];
  readMessagesAround: AgentConversationStore["readMessagesAround"];
  readSummaries: AgentConversationStore["readSummaries"];
  readTurnOutcome: AgentConversationStore["readTurnOutcome"];
  readPromptMaterial: AgentConversationStore["readPromptMaterial"];
}

export interface ListConversationSessionsInput {
  butlerData: string;
  appMessageDbPath?: string;
  currentSessionId: string;
  projectId?: string | null;
  scope?: ConversationSessionReferenceScope;
  limit?: number;
  includeArchived?: boolean;
  previewMessages?: number;
  reader?: ConversationSessionReferenceReader;
}

export interface ConversationSessionReferenceSummary {
  conversation_session_id: string;
  external_session_id: string | null;
  title: string | null;
  catalog_source: "app-catalog-compat" | null;
  workspace_id: string | null;
  project_id: string | null;
  gateway_origin: string;
  status: ConversationSession["status"];
  archived: boolean;
  created_at: string;
  updated_at: string;
  message_count: number;
  recent_messages: ConversationContextMessage[];
}

export interface ListConversationSessionsResult {
  ok: true;
  scope: ConversationSessionReferenceScopeResult;
  current_conversation_session_id: string;
  returned: number;
  truncated: boolean;
  sessions: ConversationSessionReferenceSummary[];
  diagnostics: string[];
}

export interface ReadConversationSessionInput {
  butlerData: string;
  currentSessionId: string;
  conversationSessionId: string;
  projectId?: string | null;
  scope?: ConversationSessionReferenceScope;
  anchorMessageId?: string;
  direction?: ConversationContextDirection;
  limit?: number;
  maxChars?: number;
  includeTools?: boolean;
  reader?: ConversationSessionReferenceReader;
}

export interface ConversationSessionReadFailure {
  ok: false;
  code: "conversation_session_not_found" | "conversation_session_scope_mismatch";
  conversation_session_id: string;
  scope: ConversationSessionReferenceScopeResult;
}

export type ReadConversationSessionResult =
  | ConversationContextResult
  | ConversationSessionReadFailure;

interface ConversationSessionReferenceScopeResult {
  kind: ConversationSessionReferenceScope;
  project_id: string | null;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_PREVIEW_MESSAGES = 2;
const MAX_PREVIEW_MESSAGES = 6;

export function listConversationSessions(
  input: ListConversationSessionsInput,
): ListConversationSessionsResult {
  return withReferenceReader(input, (reader) => {
    const limit = clampInteger(input.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const previewMessages = clampInteger(
      input.previewMessages,
      DEFAULT_PREVIEW_MESSAGES,
      1,
      MAX_PREVIEW_MESSAGES,
    );
    const currentConversationSessionId = canonicalConversationSessionId({
      reader,
      runtimeSessionId: input.currentSessionId,
    });
    const scope = referenceScope(
      input.scope,
      input.projectId,
      reader.getSession(currentConversationSessionId)?.project_id,
    );
    const candidates = reader.listSessions({
      projectId: scope.kind === "current_project" ? scope.project_id : undefined,
      includeArchived: input.includeArchived,
      limit: limit + 1,
    });
    const catalog = readAppConversationSessionCatalog(
      input.appMessageDbPath,
      candidates.map((item) => item.id),
    );
    const sessions = candidates.slice(0, limit).map((session) => {
      const binding = reader.getGatewayBindingForConversation(
        session.id,
        session.gateway_origin,
      );
      const app = catalog.sessions.get(session.id);
      const recentMessages = reader.readMessagesAround({
        sessionId: session.id,
        direction: "before",
        limit: Math.min(80, previewMessages * 4),
      })
        .filter((message) =>
          message.visibility === "model" &&
          (message.role === "user" || message.role === "assistant"),
        )
        .slice(-previewMessages)
        .map((message) => toContextMessage(message, false));
      return {
        conversation_session_id: session.id,
        external_session_id: binding?.external_session_id ?? null,
        title: app?.title ?? null,
        catalog_source: app ? "app-catalog-compat" as const : null,
        workspace_id: session.workspace_id,
        project_id: session.project_id,
        gateway_origin: session.gateway_origin,
        status: session.status,
        archived: session.status === "archived",
        created_at: session.created_at,
        updated_at: session.updated_at,
        message_count: session.message_count,
        recent_messages: recentMessages,
      };
    });
    return {
      ok: true,
      scope,
      current_conversation_session_id: currentConversationSessionId,
      returned: sessions.length,
      truncated: candidates.length > limit,
      sessions,
      diagnostics: catalog.diagnostic ? [catalog.diagnostic] : [],
    };
  });
}

export function readConversationSession(
  input: ReadConversationSessionInput,
): ReadConversationSessionResult {
  return withReferenceReader(input, (reader) => {
    const currentConversationSessionId = canonicalConversationSessionId({
      reader,
      runtimeSessionId: input.currentSessionId,
    });
    const scope = referenceScope(
      input.scope,
      input.projectId,
      reader.getSession(currentConversationSessionId)?.project_id,
    );
    const conversationSessionId = input.conversationSessionId.trim();
    const session = conversationSessionId
      ? reader.getSession(conversationSessionId)
      : null;
    if (!session) {
      return {
        ok: false,
        code: "conversation_session_not_found",
        conversation_session_id: conversationSessionId,
        scope,
      };
    }
    if (
      scope.kind === "current_project" &&
      session.project_id !== scope.project_id
    ) {
      return {
        ok: false,
        code: "conversation_session_scope_mismatch",
        conversation_session_id: conversationSessionId,
        scope,
      };
    }
    return readConversationContext({
      sessionId: conversationSessionId,
      reader,
      anchorMessageId: input.anchorMessageId,
      direction: input.direction,
      limit: input.limit,
      maxChars: input.maxChars,
      includeTools: input.includeTools,
    });
  });
}

function referenceScope(
  requested: ConversationSessionReferenceScope | undefined,
  projectId: string | null | undefined,
  currentSessionProjectId: string | null | undefined,
): ConversationSessionReferenceScopeResult {
  const normalizedProjectId = projectId?.trim() || currentSessionProjectId?.trim() || null;
  if (requested === "all_sessions" || !normalizedProjectId) {
    return { kind: "all_sessions", project_id: null };
  }
  return { kind: "current_project", project_id: normalizedProjectId };
}

function withReferenceReader<T>(
  input: { butlerData: string; reader?: ConversationSessionReferenceReader },
  run: (reader: ConversationSessionReferenceReader) => T,
): T {
  if (input.reader) return run(input.reader);
  const store = new AgentConversationStore({ butlerData: input.butlerData });
  try {
    return run(store);
  } finally {
    store.close();
  }
}

function clampInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
