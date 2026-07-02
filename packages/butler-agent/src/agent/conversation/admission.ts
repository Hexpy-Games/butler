import type { AgentTurnEventVisibility } from "../events/turn-events.ts";
import {
  safeIdentifier,
  safeOptionalPublicText,
  safePublicText,
  safeToolArgumentKeys,
  safeToolArgumentRecord,
} from "../output/evidence/transcript-sanitizers.ts";
import type {
  ConversationProviderShape,
  ConversationRole,
  ConversationStatus,
  ConversationVisibility,
} from "./types.ts";
import {
  ACTIVITY_TURN_EVENT_KINDS,
  GATEWAY_PROJECTION_TRANSCRIPT_KINDS,
  INTERNAL_CONVERSATION_TURN_EVENT_KINDS,
  TELEMETRY_TURN_EVENT_KINDS,
  TRANSCRIPT_TOP_LEVEL_EVENT_KINDS,
} from "./admission-kinds.ts";

export { TRANSCRIPT_TOP_LEVEL_EVENT_KINDS } from "./admission-kinds.ts";

export type AdmissionClass =
  | "semantic_message"
  | "semantic_tool_call"
  | "semantic_tool_result"
  | "semantic_summary"
  | "activity_state"
  | "gateway_projection"
  | "audit_event"
  | "discarded_telemetry"
  | "ambiguous_recovery";

export type ConversationAdmissionSource =
  | "gateway"
  | "runtime_turn_event"
  | "transcript"
  | "conversation";

export interface ConversationAdmissionInput {
  source: ConversationAdmissionSource;
  kind: string;
  role?: ConversationRole;
  text?: string | null;
  sourceGateway?: string | null;
  sourceRef?: string | null;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  visibility?: AgentTurnEventVisibility | ConversationVisibility;
  knownToolCallIds?: ReadonlySet<string>;
}

export type ConversationAdmissionOperation =
  | {
    kind: "append_message";
    role: ConversationRole;
    text: string;
    visibility: ConversationVisibility;
    sourceGateway: string | null;
    sourceRef: string | null;
  }
  | {
    kind: "append_tool_call";
    toolCallId: string;
    providerShape: ConversationProviderShape;
    contentJson: unknown;
    status: ConversationStatus;
  }
  | {
    kind: "append_tool_result";
    toolCallId: string;
    parentToolCallId: string;
    providerShape: ConversationProviderShape;
    contentJson: unknown;
    status: ConversationStatus;
  }
  | {
    kind: "write_summary";
    summaryText: string;
    coversFromSeq: number;
    coversToSeq: number;
    sourceHash: string;
    model: string | null;
  };

export interface AdmissionDecision {
  admitted: boolean;
  className: AdmissionClass;
  eventKind: string;
  reason: string;
  operation?: ConversationAdmissionOperation;
}

const SAFE_TOOL_CALL_ARGUMENTS_SCHEMA = "butler.tool-call-arguments-transcript.v1";
const SAFE_TOOL_RESULT_EVIDENCE_SCHEMA = "butler.tool-result-evidence-transcript.v1";
const EVIDENCE_JSON_MAX_DEPTH = 6;
const EVIDENCE_JSON_MAX_ARRAY_ITEMS = 48;
const EVIDENCE_JSON_MAX_OBJECT_ENTRIES = 48;
const UNSAFE_TOOL_CONTENT_KEY = /\b(?:raw[_-]?(?:arguments(?:[_-]?delta)?|output|stdout|stderr)|stdout|stderr|api[_-]?key|token|secret|password|passphrase|authorization|credential|credentials|access[_-]?token|refresh[_-]?token|private[_-]?key|session[_-]?key|cookie|set-cookie)\b/iu;

export function classifyForConversation(input: ConversationAdmissionInput): AdmissionDecision {
  if (input.source === "gateway") return classifyGatewayEvent(input);
  if (input.source === "runtime_turn_event") return classifyRuntimeTurnEvent(input);
  if (input.source === "conversation") return classifyConversationEvent(input);
  if (input.source === "transcript") return classifyTranscriptEvent(input);
  return deny(input, "audit_event", "unknown_source");
}

function classifyGatewayEvent(input: ConversationAdmissionInput): AdmissionDecision {
  if (input.kind === "inbound.accepted" && input.role === "user") {
    return semanticMessage(input, "user", "accepted_user_message");
  }
  if (input.kind === "outbound.final" && input.role === "assistant") {
    return semanticMessage(input, "assistant", "final_assistant_message");
  }
  return deny(input, "audit_event", "gateway_event_not_allowlisted");
}

function classifyRuntimeTurnEvent(input: ConversationAdmissionInput): AdmissionDecision {
  if (INTERNAL_CONVERSATION_TURN_EVENT_KINDS.has(input.kind) && input.visibility !== "internal") {
    return deny(input, "audit_event", "finalized_tool_event_not_internal");
  }
  if (input.kind === "tool_call.finalized") return semanticToolCall(input);
  if (input.kind === "tool_result.finalized") return semanticToolResult(input, "complete");
  if (input.kind === "tool_result.failed") return semanticToolResult(input, "failed");
  if (TELEMETRY_TURN_EVENT_KINDS.has(input.kind)) {
    return deny(input, "discarded_telemetry", "telemetry_not_semantic");
  }
  if (ACTIVITY_TURN_EVENT_KINDS.has(input.kind)) {
    return deny(input, "activity_state", "turn_activity_not_semantic");
  }
  return deny(input, "audit_event", "unknown_runtime_event_kind");
}

function classifyConversationEvent(input: ConversationAdmissionInput): AdmissionDecision {
  if (input.kind !== "summary.committed") {
    return deny(input, "audit_event", "conversation_event_not_allowlisted");
  }
  const summaryText = trimmed(input.text);
  const payload = input.payload ?? {};
  const coversFromSeq = integerPayload(payload.coversFromSeq);
  const coversToSeq = integerPayload(payload.coversToSeq);
  const sourceHash = stringPayload(payload.sourceHash);
  if (!summaryText || coversFromSeq === null || coversToSeq === null || !sourceHash) {
    return deny(input, "audit_event", "summary_missing_coverage");
  }
  return {
    admitted: true,
    className: "semantic_summary",
    eventKind: input.kind,
    reason: "conversation_summary",
    operation: {
      kind: "write_summary",
      summaryText,
      coversFromSeq,
      coversToSeq,
      sourceHash,
      model: stringPayload(payload.model),
    },
  };
}

function classifyTranscriptEvent(input: ConversationAdmissionInput): AdmissionDecision {
  if (GATEWAY_PROJECTION_TRANSCRIPT_KINDS.has(input.kind)) {
    return deny(input, "gateway_projection", "gateway_projection_not_semantic");
  }
  if (TRANSCRIPT_TOP_LEVEL_EVENT_KINDS.includes(input.kind as typeof TRANSCRIPT_TOP_LEVEL_EVENT_KINDS[number])) {
    return deny(input, "audit_event", "transcript_kind_not_semantic");
  }
  return deny(input, "audit_event", "unknown_transcript_event_kind");
}

function semanticMessage(
  input: ConversationAdmissionInput,
  role: ConversationRole,
  reason: string,
): AdmissionDecision {
  const text = trimmed(input.text);
  if (!text) return deny(input, "audit_event", "message_text_missing");
  return {
    admitted: true,
    className: "semantic_message",
    eventKind: input.kind,
    reason,
    operation: {
      kind: "append_message",
      role,
      text,
      visibility: "model",
      sourceGateway: input.sourceGateway ?? null,
      sourceRef: input.sourceRef ?? null,
    },
  };
}

function semanticToolCall(input: ConversationAdmissionInput): AdmissionDecision {
  const toolCallId = stringPayload(input.payload?.toolCallId);
  if (!toolCallId) return deny(input, "audit_event", "tool_call_id_missing");
  return {
    admitted: true,
    className: "semantic_tool_call",
    eventKind: input.kind,
    reason: "finalized_tool_call",
    operation: {
      kind: "append_tool_call",
      toolCallId,
      providerShape: "generic",
      status: "complete",
      contentJson: safeToolContent(input.payload, input.kind),
    },
  };
}

function semanticToolResult(
  input: ConversationAdmissionInput,
  status: Extract<ConversationStatus, "complete" | "failed">,
): AdmissionDecision {
  const toolCallId = stringPayload(input.payload?.toolCallId);
  if (!toolCallId) return deny(input, "audit_event", "tool_result_call_id_missing");
  if (!input.knownToolCallIds?.has(toolCallId)) {
    return deny(input, "audit_event", "orphan_tool_result_rejected");
  }
  return {
    admitted: true,
    className: "semantic_tool_result",
    eventKind: input.kind,
    reason: "known_tool_result",
    operation: {
      kind: "append_tool_result",
      toolCallId,
      parentToolCallId: toolCallId,
      providerShape: "generic",
      status,
      contentJson: safeToolContent(input.payload, input.kind),
    },
  };
}

function safeToolContent(payload: Record<string, unknown> | undefined, eventKind: string): Record<string, unknown> {
  const isToolCall = eventKind === "tool_call.finalized";
  const isToolResult = eventKind === "tool_result.finalized" || eventKind === "tool_result.failed";
  return compactToolContent({
    eventKind,
    toolCallId: stringPayload(payload?.toolCallId),
    safeToolName: safeOptionalPublicText(payload?.safeToolName) ?? safeOptionalPublicText(payload?.toolName),
    safeLabel: safeOptionalPublicText(payload?.safeLabel),
    safeInputLabel: safeOptionalPublicText(payload?.inputLabel),
    workBlockId: stringPayload(payload?.workBlockId),
    workBlockLabel: safeOptionalPublicText(payload?.workBlockLabel),
    status: safeOptionalPublicText(payload?.status),
    ...(isToolCall
      ? { arguments: safeToolArguments(payload?.arguments) }
      : {}),
    ...(isToolResult
      ? {
        ok: booleanPayload(payload?.ok),
        result: safeToolResultEvidence(payload?.result),
        error: safeOptionalPublicText(payload?.safeError),
        observation: safeToolObservation(payload?.safeObservation),
      }
      : {}),
  });
}

function recordPayload(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function safeToolArguments(value: unknown): Record<string, unknown> | null {
  const record = recordPayload(value);
  if (record?.schema_version !== SAFE_TOOL_CALL_ARGUMENTS_SCHEMA) return null;
  const safeArguments = recordPayload(removeUnsafeToolContent(record.safe_arguments)) ?? {};
  return compactToolContent({
    schema_version: SAFE_TOOL_CALL_ARGUMENTS_SCHEMA,
    argument_keys: safeToolArgumentKeys(safeArguments),
    safe_arguments: safeToolArgumentRecord(safeArguments),
  });
}

function safeToolResultEvidence(value: unknown): Record<string, unknown> | null {
  const record = recordPayload(value);
  if (record?.schema_version !== SAFE_TOOL_RESULT_EVIDENCE_SCHEMA) return null;
  return compactToolContent({
    schema_version: SAFE_TOOL_RESULT_EVIDENCE_SCHEMA,
    evidence_capability_receipts: safeEvidenceArray(record.evidence_capability_receipts),
    evidence_receipts: safeEvidenceArray(record.evidence_receipts),
    evidence_limitations: safePublicTextArray(record.evidence_limitations),
    completion_obligation_evidence: safeEvidenceRecord(record.completion_obligation_evidence),
    rejected_evidence_capability_receipts: safeEvidenceArray(record.rejected_evidence_capability_receipts),
  });
}

function safeToolObservation(value: unknown): Record<string, unknown> | null {
  const record = recordPayload(value);
  if (!record) return null;
  return compactToolContent({
    observationId: stringPayload(record.observationId),
    kind: safeOptionalPublicText(record.kind),
    visibility: record.visibility === "model" ? "model" : null,
    summary: safeOptionalPublicText(record.summary),
    modelVisibleContent: safeOptionalPublicText(record.modelVisibleContent),
    causedByToolCallId: stringPayload(record.causedByToolCallId),
    createdAt: stringPayload(record.createdAt),
  });
}

function safeEvidenceArray(value: unknown): unknown[] | null {
  if (!Array.isArray(value)) return null;
  return value.slice(0, EVIDENCE_JSON_MAX_ARRAY_ITEMS)
    .map((item) => safeEvidenceJson(item, 0))
    .filter((item) => item !== null);
}

function safeEvidenceRecord(value: unknown): Record<string, unknown> | null {
  const record = safeEvidenceJson(value, 0);
  return recordPayload(record);
}

function safeEvidenceJson(value: unknown, depth: number): unknown {
  if (depth > EVIDENCE_JSON_MAX_DEPTH) return "[redacted]";
  if (typeof value === "string") return safePublicText(value, "[redacted]");
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, EVIDENCE_JSON_MAX_ARRAY_ITEMS)
      .map((item) => safeEvidenceJson(item, depth + 1))
      .filter((item) => item !== null);
  }
  const record = recordPayload(value);
  if (!record) return null;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record).slice(0, EVIDENCE_JSON_MAX_OBJECT_ENTRIES)) {
    if (isUnsafeToolContentKey(key)) continue;
    output[safeIdentifier(key, "field")] = safeEvidenceJson(child, depth + 1);
  }
  return output;
}

function safePublicTextArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .map((item) => safeOptionalPublicText(item))
    .filter((item): item is string => Boolean(item));
}

function removeUnsafeToolContent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeUnsafeToolContent);
  const record = recordPayload(value);
  if (!record) return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (isUnsafeToolContentKey(key)) continue;
    output[key] = removeUnsafeToolContent(child);
  }
  return output;
}

function compactToolContent(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === null || value === undefined) continue;
    output[key] = value;
  }
  return output;
}

function booleanPayload(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function isUnsafeToolContentKey(key: string): boolean {
  return UNSAFE_TOOL_CONTENT_KEY.test(key);
}

function deny(input: ConversationAdmissionInput, className: Exclude<AdmissionClass, `semantic_${string}`>, reason: string): AdmissionDecision {
  return {
    admitted: false,
    className,
    eventKind: input.kind,
    reason,
  };
}

function trimmed(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringPayload(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function integerPayload(value: unknown): number | null {
  return Number.isInteger(value) ? value as number : null;
}
