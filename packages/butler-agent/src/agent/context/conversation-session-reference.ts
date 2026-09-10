import { AgentConversationStore } from "../conversation/store.ts";
import { createLazyConversationProjectionReader } from "../conversation/projection-reader-store.ts";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  ConversationBinding,
  ConversationSession,
  ConversationSessionOverview,
} from "../conversation/types.ts";
import {
  canonicalConversationSessionId,
  type ConversationContextDirection,
  type ConversationContextResult,
  readConversationContext,
} from "./conversation-context.ts";
import {
  type ConversationContextMessage,
  toContextMessage,
} from "./conversation-context-format.ts";
import {
  readActiveDescriptor,
  resolveMemorySource,
} from "../cognition/memory/index.ts";
import { decodeMessageScalars } from "../cognition/memory/projection/source.ts";

export type ConversationSessionReferenceScope =
  | "current_session"
  | "current_project"
  | "all_user_sessions"
  | "all_sessions";

export interface ConversationSessionReferenceReader {
  close?(): void;
  getSession(sessionId: string): ConversationSession | null;
  getSessionByGatewayBinding(
    gateway: string,
    externalSessionId: string,
  ): ConversationSession | null;
  getGatewayBindingForConversation(
    sessionId: string,
    gateway: string,
  ): ConversationBinding | null;
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
  currentSessionId: string;
  projectId?: string | null;
  scope?: ConversationSessionReferenceScope;
  sessionIds?: string[];
  projectFilter?: "any" | "unassigned" | "selected";
  projectIds?: string[];
  includeInternal?: boolean;
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
  sourceRef?: string;
  projectId?: string | null;
  scope?: ConversationSessionReferenceScope;
  sessionIds?: string[];
  projectFilter?: "any" | "unassigned" | "selected";
  projectIds?: string[];
  includeInternal?: boolean;
  anchorMessageId?: string;
  direction?: ConversationContextDirection;
  limit?: number;
  maxChars?: number;
  includeTools?: boolean;
  cursor?: string;
  contractVersion?: 1 | 2;
  reader?: ConversationSessionReferenceReader;
}

export interface ConversationSessionReadFailure {
  ok: false;
  code:
    | "conversation_session_not_found"
    | "conversation_session_scope_mismatch";
  conversation_session_id: string;
  scope: ConversationSessionReferenceScopeResult;
}

export type ReadConversationSessionResult =
  | ConversationContextResult
  | ConversationSessionReadFailure
  | {
    ok: true;
    status?: "complete" | "partial";
    mode: "source";
    source_ref: string;
    conversation_session_id: string | null;
    conversation_message_id: string | null;
    text: string;
    source_hash: string;
    byte_start: number;
    byte_end: number;
    next_cursor: string | null;
    basis?: string;
    source_kind?: string;
    split_grapheme?: boolean;
    diagnostics: string[];
  };

interface ConversationSessionReferenceScopeResult {
  kind: ConversationSessionReferenceScope;
  project_id: string | null;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_PREVIEW_MESSAGES = 2;
const MAX_PREVIEW_MESSAGES = 6;

export function listConversationSessionsV2(input: {
  butlerData: string;
  currentSessionId: string;
  currentProjectId: string | null;
  scope?: "current_session" | "current_project" | "all_user_sessions";
  sessionIds?: string[];
  projectFilter?: "any" | "unassigned" | "selected";
  projectIds?: string[];
  includeInternal?: boolean;
  sessionKind?: "any" | "chat" | "project" | "unknown";
  includeArchived?: boolean;
  previewMessages?: number;
  limit?: number;
  time?: { from: string; to: string; basis: "conversation" };
  cursor?: string;
}): Record<string, unknown> {
  try {
    const limit = strictInteger(input.limit, 20, 1, 100);
    const previewMessages = strictInteger(input.previewMessages, 2, 1, 6);
    const sessionIds = strictStrings(input.sessionIds ?? [], 32);
    const projectIds = strictStrings(input.projectIds ?? [], 16);
    const projectFilter = input.projectFilter ?? "any";
    if (
      !(["any", "unassigned", "selected"] as unknown[]).includes(projectFilter)
    ) throw new Error("invalid_project_filter");
    if ((projectFilter === "selected") !== (projectIds.length > 0)) {
      throw new Error("invalid_project_filter");
    }
    const scope = input.scope ??
      (input.currentProjectId ? "current_project" : "all_user_sessions");
    if (
      !([
        "current_session",
        "current_project",
        "all_user_sessions",
      ] as unknown[]).includes(scope)
    ) throw new Error("invalid_scope_value");
    const sessionKind = input.sessionKind ?? "any";
    if (
      !(["any", "chat", "project", "unknown"] as unknown[]).includes(
        sessionKind,
      )
    ) throw new Error("invalid_session_kind");
    const time = normalizeV2ConversationTime(input.time);
    const filter = {
      scope,
      sessionIds,
      projectFilter,
      projectIds,
      includeInternal: input.includeInternal === true,
      sessionKind,
      includeArchived: input.includeArchived === true,
      time,
    };
    const filterHash = createHash("sha256").update(JSON.stringify(filter))
      .digest("hex");
    const reader = createLazyConversationProjectionReader({
      butlerData: input.butlerData,
    });
    try {
      const snapshot = reader.withPublicSourceSnapshot((source) => {
        const sourceScope = {
          currentSessionId: input.currentSessionId,
          currentProjectId: input.currentProjectId,
          scope,
          sessionIds,
          projectIds,
        };
        if (!source.validateScope(sourceScope)) {
          return { ok: false, code: "invalid_scope", diagnostics: [] };
        }
        const revision = source.revision();
        const cursor = input.cursor ? decodeListCursor(input.cursor) : null;
        if (
          cursor &&
          (cursor.revision !== revision || cursor.filter_hash !== filterHash)
        ) return { ok: false, code: "stale_cursor", diagnostics: [] };
        const rows = source.readSessionPage(
          {
            ...sourceScope,
            projectFilter,
            includeInternal: input.includeInternal === true,
            includeArchived: input.includeArchived === true,
            ...(time ? { time } : {}),
          },
          cursor
            ? { last_at: cursor.last_at, session_id: cursor.session_id }
            : null,
          1_001,
        );
        const catalog = readCatalogLabels(
          input.butlerData,
          rows.map((row) => row.id),
        );
        const selected = rows.filter((row) => {
          const kind = catalog.labels.get(row.id)?.kind ?? "unknown";
          return filter.sessionKind === "any" || kind === filter.sessionKind;
        }).slice(0, limit + 1);
        const scanContinues = rows.length === 1_001;
        let hasMore = selected.length > limit || scanContinues;
        const sessions = selected.slice(0, limit).map((row) => {
          const label = catalog.labels.get(row.id);
          const previewRows = source.readPreviewMessages({
            sessionId: row.id,
            includeInternal: input.includeInternal === true,
            ...(time ? { time } : {}),
            limit: previewMessages,
          });
          const binding = source.getGatewayBindingForConversation(
            row.id,
            row.gateway_origin,
          );
          return {
            conversation_session_id: row.id,
            external_session_id: binding?.external_session_id ?? null,
            title: label?.title ? truncateListText(label.title, 512) : null,
            catalog_source: label ? "app-catalog-compat" : null,
            session_kind: label?.kind ?? "unknown",
            workspace_id: row.workspace_id,
            project_id: row.project_id,
            gateway_origin: row.gateway_origin,
            status: row.status,
            archived: row.status === "archived",
            created_at: row.created_at,
            updated_at: row.updated_at,
            last_eligible_message_at: row.last_eligible_message_at,
            message_count: Number(row.message_count),
            recent_messages: previewRows.map((message) => ({
              conversation_message_id: message.id,
              role: message.role,
              created_at: message.created_at,
              text: truncateListText(messageScalarPreview(message), 900),
            })),
          };
        });
        const responseBase = {
          ok: true as const,
          status: hasMore ? "partial" : "complete",
          scope: {
            kind: scope,
            project_id: scope === "current_project"
              ? input.currentProjectId
              : null,
          },
          current_conversation_session_id: input.currentSessionId,
          returned: sessions.length,
          sessions,
          next_cursor: null as string | null,
          diagnostics: catalog.diagnostics,
        };
        const inspectedTail = rows.at(-1) as any;
        const setNextCursor = () => {
          const returnedTail = sessions.at(-1) as any;
          const tail = selected.length > limit ||
              responseBase.diagnostics.includes("serialization_budget")
            ? returnedTail
            : inspectedTail;
          responseBase.next_cursor = hasMore && tail
            ? encodeListCursor({
              schema: "butler.list-conversation-sessions-cursor.v2",
              filter_hash: filterHash,
              revision,
              last_at: tail.last_eligible_message_at,
              session_id: tail.conversation_session_id ?? tail.id,
            })
            : null;
        };
        setNextCursor();
        while (
          sessions.length > 1 &&
          memoryListEnvelopeBytes(responseBase) > 24 * 1024
        ) {
          sessions.pop();
          hasMore = true;
          responseBase.returned = sessions.length;
          responseBase.status = "partial";
          responseBase.diagnostics = [
            ...new Set([...responseBase.diagnostics, "serialization_budget"]),
          ];
          setNextCursor();
        }
        if (
          sessions.length === 1 &&
          memoryListEnvelopeBytes(responseBase) > 24 * 1024
        ) {
          responseBase.status = "partial";
          responseBase.diagnostics = [
            ...new Set([
              ...responseBase.diagnostics,
              "serialization_budget",
              "preview_truncated",
            ]),
          ];
          const preview = sessions[0]!.recent_messages;
          while (
            preview.length > 1 &&
            memoryListEnvelopeBytes(responseBase) > 24 * 1024
          ) preview.shift();
          while (
            preview.length === 1 &&
            memoryListEnvelopeBytes(responseBase) > 24 * 1024
          ) {
            const message = preview[0]!;
            const length = [...new Intl.Segmenter("und", {
              granularity: "grapheme",
            }).segment(message.text)].length;
            if (length <= 1) break;
            message.text = truncateListText(
              message.text,
              Math.max(1, Math.floor(length * 0.75)),
            );
          }
          if (
            preview.length === 1 &&
            memoryListEnvelopeBytes(responseBase) > 24 * 1024
          ) preview.pop();
          setNextCursor();
        }
        if (scanContinues) {
          responseBase.diagnostics = [
            ...new Set([...responseBase.diagnostics, "scan_continues"]),
          ];
        }
        return responseBase;
      });
      return snapshot ??
        {
          ok: false,
          code: "backend_unavailable",
          diagnostics: ["conversation_store_unavailable"],
        };
    } finally {
      reader.close();
    }
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    return LIST_ARGUMENT_ERRORS.has(code)
      ? { ok: false, code: "invalid_arguments", diagnostics: [code] }
      : {
        ok: false,
        code: "backend_unavailable",
        diagnostics: ["conversation_store_unavailable"],
      };
  }
}

const LIST_ARGUMENT_ERRORS = new Set([
  "invalid_integer",
  "invalid_array",
  "invalid_project_filter",
  "invalid_scope_value",
  "invalid_session_kind",
  "invalid_time",
  "invalid_cursor",
]);
function truncateListText(value: string, max: number): string {
  return [
    ...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(value),
  ].slice(0, max).map((item) => item.segment).join("");
}
function memoryListEnvelopeBytes(output: unknown): number {
  return Buffer.byteLength(
    JSON.stringify({
      ok: true,
      output: { tool_name: "list_conversation_sessions", ...output as object },
    }),
    "utf8",
  );
}

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
      projectId: scope.kind === "current_project"
        ? scope.project_id
        : undefined,
      includeArchived: input.includeArchived,
      limit: limit + 1,
    });
    const sessions = candidates.slice(0, limit).map((session) => {
      const binding = reader.getGatewayBindingForConversation(
        session.id,
        session.gateway_origin,
      );
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
        title: null,
        catalog_source: null,
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
      diagnostics: [],
    };
  });
}

export function readConversationSession(
  input: ReadConversationSessionInput & { sourceRef: string },
): ReadConversationSessionResult;
export function readConversationSession(
  input: ReadConversationSessionInput & { sourceRef?: undefined },
): ConversationContextResult | ConversationSessionReadFailure;
export function readConversationSession(
  input: ReadConversationSessionInput,
): ReadConversationSessionResult {
  return withReferenceReader(input, (reader) => {
    if (input.contractVersion === 2) {
      return readConversationSessionV2(input, reader);
    }
    const currentConversationSessionId = canonicalConversationSessionId({
      reader,
      runtimeSessionId: input.currentSessionId,
    });
    const scope = referenceScope(
      input.scope,
      input.projectId,
      reader.getSession(currentConversationSessionId)?.project_id,
    );
    if (input.sourceRef) {
      if (input.sourceRef.startsWith("conversation-source:v2:")) {
        const page = resolveConversationSourcePage(
          reader,
          input.sourceRef,
          input.cursor,
          input.maxChars,
        );
        const sourceSession = reader.getSession(page.conversation_session_id);
        const permitted = (scope.kind === "all_user_sessions" ||
          scope.kind === "all_sessions" ||
          (scope.kind === "current_session" &&
            page.conversation_session_id === currentConversationSessionId) ||
          (scope.kind === "current_project" &&
            sourceSession?.project_id === scope.project_id)) &&
          readFiltersPermit(
            input,
            page.conversation_session_id,
            sourceSession?.project_id ?? null,
          );
        if (!permitted) {
          return {
            ok: false,
            code: "conversation_session_scope_mismatch",
            conversation_session_id: "",
            scope,
          };
        }
        return page as ReadConversationSessionResult;
      }
      const descriptor = readActiveDescriptor(input.butlerData);
      const memoryHandle = parseMemorySourceHandle(input.sourceRef);
      if (
        !memoryHandle || memoryHandle.generationId !== descriptor.generation_id
      ) throw new Error("source_not_found");
      const source = resolveMemorySource({
        context: {
          butlerData: input.butlerData,
          target: {
            kind: "active",
            expected_generation: descriptor.generation_id,
          },
          signal: new AbortController().signal,
        },
        sourceRef: memoryHandle.sourceId,
      });
      const sourceSession = source.conversation_session_id
        ? reader.getSession(source.conversation_session_id)
        : null;
      const sourceProjectId = source.project_id ?? sourceSession?.project_id ?? null;
      const permitted = (scope.kind === "all_user_sessions" ||
        scope.kind === "all_sessions" ||
        (scope.kind === "current_session" &&
          source.conversation_session_id === currentConversationSessionId) ||
        (scope.kind === "current_project" &&
          sourceProjectId === scope.project_id)) &&
        readFiltersPermit(
          input,
          source.conversation_session_id,
          sourceProjectId,
        );
      if (!permitted) {
        return {
          ok: false,
          code: "conversation_session_scope_mismatch",
          conversation_session_id: "",
          scope,
        };
      }
      return paginateMemorySource(
        input.sourceRef,
        source,
        input.cursor,
        input.maxChars,
      );
    }
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
      !readFiltersPermit(input, session.id, session.project_id) ||
      (scope.kind === "current_session" &&
        session.id !== currentConversationSessionId) ||
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

function readConversationSessionV2(
  input: ReadConversationSessionInput,
  reader: ConversationSessionReferenceReader,
): ReadConversationSessionResult {
  const scope = validateV2ReadScope(input, reader);
  const scopeHash = createHash("sha256").update(JSON.stringify({
    scope: scope.kind,
    project_id: scope.project_id,
    session_ids: strictStrings(input.sessionIds ?? [], 32),
    project_filter: input.projectFilter ?? "any",
    project_ids: strictStrings(input.projectIds ?? [], 16),
    include_internal: input.includeInternal === true,
  })).digest("hex");
  if (input.sourceRef) {
    const expectedGeneration =
      input.sourceRef.startsWith("conversation-source:v2:")
        ? "canonical-conversation"
        : readActiveDescriptor(input.butlerData).generation_id;
    const source = resolveMemorySource({
      context: {
        butlerData: input.butlerData,
        target: { kind: "active", expected_generation: expectedGeneration },
        signal: new AbortController().signal,
      },
      sourceRef: input.sourceRef,
      authorize: (candidate) => {
        const projectId = candidate.project_id ??
          (candidate.conversation_session_id
            ? reader.getSession(candidate.conversation_session_id)?.project_id
            : null) ?? null;
        return v2ReadPermits(
          input,
          scope,
          candidate.conversation_session_id,
          projectId,
        ) &&
          (input.includeInternal === true ||
            candidate.source_kind === "task_report" ||
            candidate.source_kind === "explicit_record" ||
            ["user_input", "assistant_public"].includes(candidate.origin_kind));
      },
    });
    return paginateMemorySource(
      input.sourceRef,
      source,
      input.cursor,
      input.maxChars,
      scopeHash,
    );
  }
  const sessionId = input.conversationSessionId.trim();
  const session = reader.getSession(sessionId);
  if (!session) {
    return {
      ok: false,
      code: "conversation_session_not_found",
      conversation_session_id: sessionId,
      scope,
    };
  }
  if (!v2ReadPermits(input, scope, session.id, session.project_id)) {
    return {
      ok: false,
      code: "conversation_session_scope_mismatch",
      conversation_session_id: "",
      scope,
    };
  }
  const limit = strictInteger(input.limit, 20, 1, 100);
  const maxChars = strictInteger(input.maxChars, 8_000, 256, 24_000);
  const direction = input.direction ?? "before";
  if (!(["before", "after", "around"] as unknown[]).includes(direction)) {
    throw new Error("invalid_arguments");
  }
  if (input.anchorMessageId) {
    const anchor = reader.readMessageById(input.anchorMessageId);
    if (!anchor || anchor.session_id !== session.id) {
      throw new Error("invalid_scope");
    }
  }
  const result = readConversationContext({
    sessionId,
    reader,
    anchorMessageId: input.anchorMessageId,
    direction,
    limit,
    maxChars,
    includeTools: input.includeTools === true,
    includeInternal: input.includeInternal === true,
    validatedLimits: { limit, maxChars },
  });
  while (
    result.messages.length > 1 && memoryListEnvelopeBytes(result) > 24 * 1024
  ) {
    result.messages.pop();
    result.returned = result.messages.length;
    result.truncated = true;
  }
  if (
    result.messages.length === 1 && memoryListEnvelopeBytes(result) > 24 * 1024
  ) {
    result.messages[0]!.text = truncateListText(
      result.messages[0]!.text,
      4_000,
    );
    result.truncated = true;
  }
  return result;
}

function validateV2ReadScope(
  input: ReadConversationSessionInput,
  reader: ConversationSessionReferenceReader,
): ConversationSessionReferenceScopeResult {
  const current = reader.getSession(input.currentSessionId);
  if (
    !current || current.status === "deleted" ||
    current.project_id !== (input.projectId ?? null)
  ) throw new Error("invalid_scope");
  const kind = input.scope ??
    (input.projectId ? "current_project" : "all_user_sessions");
  if (
    !(["current_session", "current_project", "all_user_sessions"] as unknown[])
      .includes(kind) || kind === "current_project" && !input.projectId
  ) throw new Error("invalid_scope");
  const scope = {
    kind,
    project_id: kind === "current_project" ? input.projectId ?? null : null,
  } as ConversationSessionReferenceScopeResult;
  const sessionIds = strictStrings(input.sessionIds ?? [], 32),
    projectIds = strictStrings(input.projectIds ?? [], 16);
  const filter = input.projectFilter ?? "any";
  if (
    !(["any", "unassigned", "selected"] as unknown[]).includes(filter) ||
    (filter === "selected") !== (projectIds.length > 0)
  ) throw new Error("invalid_arguments");
  for (const id of sessionIds) {
    const session = reader.getSession(id);
    if (
      !session || session.status === "deleted" ||
      !baseScopePermits(
        scope,
        input.currentSessionId,
        session.id,
        session.project_id,
      )
    ) throw new Error("invalid_scope");
  }
  for (const projectId of projectIds) {
    if (
      kind !== "all_user_sessions" && projectId !== input.projectId ||
      reader.listSessions({ projectId, includeArchived: true, limit: 1 })
          .length === 0
    ) throw new Error("invalid_scope");
  }
  return scope;
}

function baseScopePermits(
  scope: ConversationSessionReferenceScopeResult,
  currentSessionId: string,
  sessionId: string | null,
  projectId: string | null,
): boolean {
  return scope.kind === "all_user_sessions" || scope.kind === "all_sessions" ||
    scope.kind === "current_session" && sessionId === currentSessionId ||
    scope.kind === "current_project" && projectId === scope.project_id;
}

function v2ReadPermits(
  input: ReadConversationSessionInput,
  scope: ConversationSessionReferenceScopeResult,
  sessionId: string | null,
  projectId: string | null,
): boolean {
  return baseScopePermits(
    scope,
    input.currentSessionId,
    sessionId,
    projectId,
  ) && readFiltersPermit(input, sessionId, projectId);
}

function referenceScope(
  requested: ConversationSessionReferenceScope | undefined,
  projectId: string | null | undefined,
  currentSessionProjectId: string | null | undefined,
): ConversationSessionReferenceScopeResult {
  const normalizedProjectId = projectId?.trim() ||
    currentSessionProjectId?.trim() || null;
  if (requested === "current_session") {
    return { kind: "current_session", project_id: normalizedProjectId };
  }
  if (
    requested === "all_sessions" ||
    requested === "all_user_sessions" ||
    !normalizedProjectId
  ) {
    return {
      kind: requested === "all_sessions" ? "all_sessions" : "all_user_sessions",
      project_id: null,
    };
  }
  return { kind: "current_project", project_id: normalizedProjectId };
}

function readFiltersPermit(
  input: Pick<
    ReadConversationSessionInput,
    "sessionIds" | "projectFilter" | "projectIds"
  >,
  sessionId: string | null,
  projectId: string | null,
): boolean {
  const sessionIds = strictStrings(input.sessionIds ?? [], 32);
  const projectIds = strictStrings(input.projectIds ?? [], 16);
  const projectFilter = input.projectFilter ?? "any";
  if (
    !(["any", "unassigned", "selected"] as unknown[]).includes(projectFilter) ||
    (projectFilter === "selected") !== (projectIds.length > 0)
  ) throw new Error("invalid_arguments");
  if (sessionIds.length && (!sessionId || !sessionIds.includes(sessionId))) return false;
  if (projectFilter === "unassigned" && projectId !== null) return false;
  if (projectFilter === "selected" && !projectIds.includes(projectId ?? "")) {
    return false;
  }
  return true;
}

function resolveConversationSourcePage(
  reader: ConversationSessionReferenceReader,
  sourceRef: string,
  cursorValue: string | undefined,
  requestedMaxChars: number | undefined,
  scopeHash?: string,
) {
  const parts = sourceRef.split(":");
  if (
    parts.length !== 6 || parts[0] !== "conversation-source" ||
    parts[1] !== "v2" || !/^[a-f0-9]{64}$/u.test(parts[5]!)
  ) throw new Error("source_not_found");
  const decode = (value: string) =>
    Buffer.from(value, "base64url").toString("utf8");
  const messageId = decode(parts[2]!);
  const partId = decode(parts[3]!);
  const pointer = decode(parts[4]!);
  const expectedHash = parts[5]!;
  const message = reader.readMessageById(messageId);
  const scalar = message &&
    decodeMessageScalars(message).find((item) =>
      item.part.id === partId && item.pointer === pointer,
    );
  if (!message || !scalar) throw new Error("source_not_found");
  if (scalar.hash !== expectedHash) throw new Error("source_changed");
  const maxChars = strictInteger(requestedMaxChars, 4_000, 256, 16_000);
  const cursor = cursorValue ? decodeSourceCursor(cursorValue) : null;
  if (
    cursor &&
    (cursor.source_ref !== sourceRef || cursor.source_hash !== expectedHash)
  ) throw new Error("source_changed");
  if (cursor && cursor.scope_hash !== scopeHash) {
    throw new Error("stale_cursor");
  }
  const start = cursor?.next_byte ?? 0;
  const bytes = Buffer.from(scalar.text, "utf8");
  if (start < 0 || start > bytes.length) throw new Error("source_changed");
  let text = "";
  let end = start;
  let splitGrapheme = false;
  const remainder = bytes.subarray(start).toString("utf8");
  const graphemes = [
    ...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(
      remainder,
    ),
  ].map((entry) => entry.segment);
  for (const grapheme of graphemes) {
    if (
      [...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(text)]
        .length >= maxChars
    ) break;
    const candidate = text + grapheme;
    if (
      Buffer.byteLength(JSON.stringify({ text: candidate }), "utf8") > 20 * 1024
    ) {
      if (!text) {
        for (const codepoint of grapheme) {
          const next = text + codepoint;
          if (
            Buffer.byteLength(JSON.stringify({ text: next }), "utf8") >
              20 * 1024
          ) break;
          text = next;
          end = start + Buffer.byteLength(text, "utf8");
        }
        splitGrapheme = true;
      }
      break;
    }
    text = candidate;
    end = start + Buffer.byteLength(text, "utf8");
  }
  const next = end < bytes.length
    ? encodeSourceCursor({
      schema: "butler.source-read-cursor.v2",
      source_ref: sourceRef,
      source_hash: expectedHash,
      scope_hash: scopeHash,
      next_byte: end,
    })
    : null;
  return {
    ok: true as const,
    status: next ? "partial" as const : "complete" as const,
    mode: "source" as const,
    source_ref: sourceRef,
    basis: message.role === "user" ? "user_statement" : "assistant_statement",
    source_kind: "conversation",
    conversation_session_id: message.session_id,
    conversation_message_id: message.id,
    text,
    byte_start: start,
    byte_end: end,
    source_hash: expectedHash,
    next_cursor: next,
    ...(splitGrapheme ? { split_grapheme: true } : {}),
    diagnostics: [],
  };
}

function parseMemorySourceHandle(
  value: string,
): { generationId: string; sourceId: string } | null {
  const parts = value.split(":");
  if (parts.length !== 4 || parts[0] !== "memory-source" || parts[1] !== "v2") {
    return null;
  }
  try {
    return {
      generationId: Buffer.from(parts[2]!, "base64url").toString("utf8"),
      sourceId: Buffer.from(parts[3]!, "base64url").toString("utf8"),
    };
  } catch {
    return null;
  }
}

function paginateMemorySource(
  sourceRef: string,
  source: ReturnType<typeof resolveMemorySource>,
  cursorValue: string | undefined,
  requestedMaxChars: number | undefined,
  scopeHash?: string,
) {
  const scalar = source.scalar_text ?? source.text;
  const actualHash = createHash("sha256").update(scalar).digest("hex");
  if (actualHash !== source.source_hash) throw new Error("source_changed");
  const maxChars = strictInteger(requestedMaxChars, 4_000, 256, 16_000);
  const cursor = cursorValue ? decodeSourceCursor(cursorValue) : null;
  if (
    cursor &&
    (cursor.source_ref !== sourceRef ||
      cursor.source_hash !== source.source_hash)
  ) throw new Error("source_changed");
  if (cursor && cursor.scope_hash !== scopeHash) {
    throw new Error("stale_cursor");
  }
  const start = cursor?.next_byte ?? 0;
  const bytes = Buffer.from(scalar, "utf8");
  if (start < 0 || start > bytes.length) throw new Error("source_changed");
  let text = "";
  let end = start;
  let splitGrapheme = false;
  for (
    const item of [
      ...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(
        bytes.subarray(start).toString("utf8"),
      ),
    ].slice(0, maxChars)
  ) {
    const candidate = text + item.segment;
    if (
      Buffer.byteLength(JSON.stringify({ text: candidate }), "utf8") > 20 * 1024
    ) {
      if (!text) {
        for (const codepoint of item.segment) {
          const next = text + codepoint;
          if (
            Buffer.byteLength(JSON.stringify({ text: next }), "utf8") >
              20 * 1024
          ) break;
          text = next;
          end = start + Buffer.byteLength(text, "utf8");
        }
        splitGrapheme = true;
      }
      break;
    }
    text = candidate;
    end = start + Buffer.byteLength(text, "utf8");
  }
  const next = end < bytes.length
    ? encodeSourceCursor({
      schema: "butler.source-read-cursor.v2",
      source_ref: sourceRef,
      source_hash: source.source_hash,
      scope_hash: scopeHash,
      next_byte: end,
    })
    : null;
  return {
    ok: true as const,
    status: next ? "partial" as const : "complete" as const,
    mode: "source" as const,
    source_ref: sourceRef,
    basis: source.basis,
    source_kind: source.source_kind,
    conversation_session_id: source.conversation_session_id,
    conversation_message_id: source.conversation_message_id,
    text,
    byte_start: start,
    byte_end: end,
    source_hash: source.source_hash,
    next_cursor: next,
    ...(splitGrapheme ? { split_grapheme: true } : {}),
    diagnostics: [],
  };
}

type SourceCursor = {
  schema: "butler.source-read-cursor.v2";
  source_ref: string;
  source_hash: string;
  scope_hash?: string;
  next_byte: number;
};
function encodeSourceCursor(value: SourceCursor): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
function decodeSourceCursor(value: string): SourceCursor {
  const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  if (
    parsed?.schema !== "butler.source-read-cursor.v2" ||
    !Number.isSafeInteger(parsed.next_byte)
  ) throw new Error("invalid_cursor");
  return parsed;
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

function strictInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error("invalid_integer");
  }
  return value;
}

function strictStrings(values: string[], max: number): string[] {
  if (
    !Array.isArray(values) || values.length > max ||
    values.some((value) => typeof value !== "string" || !value.trim())
  ) throw new Error("invalid_array");
  return values.map((value) => value.trim());
}

function normalizeV2ConversationTime(
  value: { from: string; to: string; basis: "conversation" } | undefined,
) {
  if (!value) return undefined;
  const valid = (text: string) =>
    /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(text) &&
    Number.isFinite(Date.parse(text));
  if (
    value.basis !== "conversation" || !valid(value.from) || !valid(value.to) ||
    Date.parse(value.from) >= Date.parse(value.to)
  ) throw new Error("invalid_time");
  return {
    from: new Date(value.from).toISOString(),
    to: new Date(value.to).toISOString(),
    basis: "conversation" as const,
  };
}

function readCatalogLabels(
  butlerData: string,
  ids: string[],
): {
  labels: Map<string, { title: string; kind: "chat" | "project" | "unknown" }>;
  diagnostics: string[];
} {
  const output = new Map<
    string,
    { title: string; kind: "chat" | "project" | "unknown" }
  >();
  const path = [
    join(butlerData, "app-server", "butler-client.sqlite"),
    join(butlerData, "app.sqlite"),
  ].find(existsSync);
  if (!path || ids.length === 0) return { labels: output, diagnostics: [] };
  const db = new Database(path, { readonly: true });
  const diagnostics = new Set<string>();
  try {
    const columns = db.query<{ name: string }, []>("PRAGMA table_info(chats)")
      .all().map((row) => row.name);
    if (!columns.includes("conversation_session_id")) {
      return { labels: output, diagnostics: [] };
    }
    for (const id of ids) {
      const rows = db.query<{ title: string; kind: string }, [string]>(
        "SELECT title,kind FROM chats WHERE conversation_session_id=?",
      ).all(id);
      const distinct = [
        ...new Map(
          rows.map((row) => [JSON.stringify([row.title, row.kind]), row]),
        ).values(),
      ];
      if (distinct.length > 1) {
        diagnostics.add("catalog_conflict");
        continue;
      }
      if (distinct.length === 0) continue;
      const row = distinct[0]!;
      output.set(id, {
        title: row.title,
        kind: row.kind === "chat" || row.kind === "project"
          ? row.kind
          : "unknown",
      });
    }
  } catch {
    diagnostics.add("catalog_unavailable");
  } finally {
    db.close();
  }
  return { labels: output, diagnostics: [...diagnostics] };
}

function messageScalarPreview(
  message: Parameters<typeof decodeMessageScalars>[0],
): string {
  return decodeMessageScalars(message)[0]?.text ?? "";
}

type ListCursor = {
  schema: "butler.list-conversation-sessions-cursor.v2";
  filter_hash: string;
  revision: number;
  last_at: string;
  session_id: string;
};
function encodeListCursor(value: ListCursor): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
function decodeListCursor(value: string): ListCursor {
  const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  if (parsed?.schema !== "butler.list-conversation-sessions-cursor.v2") {
    throw new Error("invalid_cursor");
  }
  return parsed;
}
