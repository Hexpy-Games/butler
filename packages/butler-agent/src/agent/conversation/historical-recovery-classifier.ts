import type {
  HistoricalAppProjectionRow,
  HistoricalImportDecision,
  HistoricalProvenance,
  HistoricalSourceKind,
  HistoricalTranscriptRow,
} from "./historical-recovery-types.ts";

type HistoricalMessageRole = NonNullable<HistoricalImportDecision["role"]>;

const APP_ACTIVITY_ROLES = new Set(["system_event", "activity", "tool_summary"]);
const DISCARDED_TRANSCRIPT_KINDS = new Set([
  "delivery",
  "worker_status",
  "session_status",
  "memory_note",
  "system",
]);

export function classifyHistoricalTranscriptRow(row: HistoricalTranscriptRow): HistoricalImportDecision {
  const sourceId = row.eventId?.trim() || "unknown";
  const sessionId = row.sessionId?.trim() || "unknown";
  const auditRefs = [`transcript:${sourceId}`];
  const createdAt = validIso(row.timestamp) ? row.timestamp : null;
  if (!row.eventId?.trim() || !row.sessionId?.trim() || !createdAt) {
    return historicalDecision({
      sourceKind: "transcript",
      sourceId,
      sessionId,
      provenance: "ambiguous",
      reason: "missing_stable_transcript_identity",
      createdAt,
      auditRefs,
    });
  }
  if (isHistoricalPlaceholder(row) || isInternalTranscriptRow(row)) {
    return historicalDecision({
      sourceKind: "transcript",
      sourceId,
      sessionId,
      provenance: "discarded",
      reason: "transcript_placeholder_or_internal",
      createdAt,
      auditRefs,
    });
  }
  if (row.kind === "inbound" || row.kind === "outbound") {
    const text = messageText(row.payload);
    if (!text) {
      return historicalDecision({
        sourceKind: "transcript",
        sourceId,
        sessionId,
        provenance: "ambiguous",
        reason: "conversation_text_missing",
        createdAt,
        auditRefs,
      });
    }
    const role = row.kind === "inbound" ? "user" : "assistant";
    return historicalDecision({
      sourceKind: "transcript",
      sourceId,
      sessionId,
      provenance: "recovered",
      reason: "clean_transcript_message_recovered",
      role,
      text,
      createdAt,
      auditRefs,
    });
  }
  if (DISCARDED_TRANSCRIPT_KINDS.has(row.kind)) {
    return historicalDecision({
      sourceKind: "transcript",
      sourceId,
      sessionId,
      provenance: "discarded",
      reason: "transcript_kind_not_semantic",
      createdAt,
      auditRefs,
    });
  }
  return historicalDecision({
    sourceKind: "transcript",
    sourceId,
    sessionId,
    provenance: "ambiguous",
    reason: row.kind === "turn" ? "turn_text_requires_explicit_recovery_policy" : "historical_tool_or_unknown_requires_review",
    createdAt,
    auditRefs,
  });
}

export function classifyHistoricalAppProjectionRow(row: HistoricalAppProjectionRow): HistoricalImportDecision {
  const sourceId = row.id?.trim() || "unknown";
  const sessionId = appExternalSessionId(row.chat_id);
  const auditRefs = [`app_projection:${sourceId}`];
  const createdAt = validIso(row.created_at) ? row.created_at : null;
  const role = appConversationRole(row.role);
  if (!row.id?.trim() || !row.chat_id?.trim() || !createdAt) {
    return historicalDecision({
      sourceKind: "app_projection",
      sourceId,
      sessionId,
      provenance: "ambiguous",
      reason: "missing_stable_app_projection_identity",
      createdAt,
      auditRefs,
      conversationSessionId: cleanString(row.conversation_session_id),
      conversationTurnId: cleanString(row.conversation_turn_id),
      conversationMessageId: cleanString(row.conversation_message_id),
    });
  }
  if (!role) {
    return historicalDecision({
      sourceKind: "app_projection",
      sourceId,
      sessionId,
      provenance: APP_ACTIVITY_ROLES.has(row.role) ? "discarded" : "ambiguous",
      reason: APP_ACTIVITY_ROLES.has(row.role) ? "app_activity_projection_not_semantic" : "unknown_app_projection_role",
      createdAt,
      auditRefs,
      conversationSessionId: cleanString(row.conversation_session_id),
      conversationTurnId: cleanString(row.conversation_turn_id),
      conversationMessageId: cleanString(row.conversation_message_id),
    });
  }
  const text = row.text?.trim() ?? "";
  if (!text) {
    return historicalDecision({
      sourceKind: "app_projection",
      sourceId,
      sessionId,
      provenance: "ambiguous",
      reason: "conversation_text_missing",
      role,
      createdAt,
      auditRefs,
      conversationSessionId: cleanString(row.conversation_session_id),
      conversationTurnId: cleanString(row.conversation_turn_id),
      conversationMessageId: cleanString(row.conversation_message_id),
    });
  }
  const hasCanonicalRefs = Boolean(row.conversation_session_id?.trim() && row.conversation_message_id?.trim());
  return historicalDecision({
    sourceKind: "app_projection",
    sourceId,
    sessionId,
    provenance: hasCanonicalRefs ? "trusted" : "recovered",
    reason: hasCanonicalRefs ? "app_projection_has_canonical_refs" : "legacy_app_projection_recovered",
    role,
    text,
    createdAt,
    auditRefs,
    conversationSessionId: cleanString(row.conversation_session_id),
    conversationTurnId: cleanString(row.conversation_turn_id),
    conversationMessageId: cleanString(row.conversation_message_id),
  });
}

export function classifyHistoricalRows(input: {
  transcriptRows?: HistoricalTranscriptRow[];
  appRows?: HistoricalAppProjectionRow[];
}): HistoricalImportDecision[] {
  return [
    ...(input.transcriptRows ?? []).map(classifyHistoricalTranscriptRow),
    ...(input.appRows ?? []).map(classifyHistoricalAppProjectionRow),
  ];
}

function historicalDecision(input: {
  sourceKind: HistoricalSourceKind;
  sourceId: string;
  sessionId: string;
  provenance: HistoricalProvenance;
  reason: string;
  role?: HistoricalMessageRole | null;
  text?: string | null;
  createdAt: string | null;
  auditRefs: string[];
  conversationSessionId?: string | null;
  conversationTurnId?: string | null;
  conversationMessageId?: string | null;
}): HistoricalImportDecision {
  const role = input.role ?? null;
  const text = input.text?.trim() ?? "";
  const admit = (input.provenance === "trusted" || input.provenance === "recovered") &&
    Boolean(role && text && input.createdAt);
  return {
    source_kind: input.sourceKind,
    source_id: input.sourceId,
    session_id: input.sessionId,
    conversation_session_id: input.conversationSessionId ?? null,
    conversation_turn_id: input.conversationTurnId ?? null,
    conversation_message_id: input.conversationMessageId ?? null,
    provenance: input.provenance,
    admit,
    reason: input.reason,
    role,
    created_at: input.createdAt,
    audit_refs: input.auditRefs,
    message: admit && role && input.createdAt
      ? {
          role,
          text,
          created_at: input.createdAt,
        }
      : null,
  };
}

function appExternalSessionId(chatId: string): string {
  const trimmed = chatId?.trim() || "unknown";
  return trimmed === "general" ? "butler/app-general" : `butler/app-${safeSessionSegment(trimmed)}`;
}

function safeSessionSegment(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/[^a-z0-9._-]+/gu, "-") || "session";
}

function appConversationRole(role: string): HistoricalMessageRole | null {
  if (role === "user" || role === "assistant") return role;
  return null;
}

function messageText(payload: Record<string, unknown> | null | undefined): string {
  const message = recordPayload(payload?.message);
  const value = message?.text ?? payload?.text;
  return typeof value === "string" ? value.trim() : "";
}

function isHistoricalPlaceholder(row: HistoricalTranscriptRow): boolean {
  const timestampMs = Date.parse(row.timestamp);
  const payload = row.payload ?? {};
  const payloadEventId = payload.eventId;
  const message = recordPayload(payload.message);
  const messageTimestamp = message?.timestamp;
  return !Number.isFinite(timestampMs) ||
    timestampMs <= 0 ||
    row.transport === "mock" ||
    (typeof payloadEventId === "string" && payloadEventId.startsWith("mock:")) ||
    (typeof messageTimestamp === "string" && Date.parse(messageTimestamp) <= 0);
}

function isInternalTranscriptRow(row: HistoricalTranscriptRow): boolean {
  const route = recordPayload(row.payload?.route);
  const role = route?.role ?? row.payload?.role;
  return row.sessionId.startsWith("steward/") || role === "steward";
}

function recordPayload(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function cleanString(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function validIso(value: string | null | undefined): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
