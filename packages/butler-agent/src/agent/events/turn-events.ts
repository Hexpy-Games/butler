import { randomUUID } from "node:crypto";
import { sanitizePublicText } from "./public-text.ts";
import {
  TURN_ACKNOWLEDGED_EVENT_KIND,
  TURN_STATE_CONTRACT_EVENT_KINDS,
  isAuthoredDecisionSource,
  normalizeTurnStateContractPayload,
} from "./turn-state-contract.ts";

export { isPublicTextSafe, sanitizePublicText } from "./public-text.ts";

export const TURN_EVENT_KINDS = [
  "turn.started",
  "turn.first_progress",
  "turn.iteration.started",
  "assistant.decision.delta",
  "assistant.decision.completed",
  "model.stream.text_delta",
  "model.stream.reasoning_delta",
  "model.stream.tool_call_delta",
  "model.stream.completed",
  "work.block.started",
  "work.block.updated",
  "work.block.completed",
  "assistant.public_note",
  "tool.started",
  "tool.progress",
  "tool.completed",
  "tool.failed",
  "guard.started",
  "guard.completed",
  "cognition.feedback.captured",
  "message.final.started",
  "message.final.delta",
  "message.final.completed",
  "turn.observation",
  "turn.continuation_scheduled",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  ...TURN_STATE_CONTRACT_EVENT_KINDS,
] as const;

export type AgentTurnEventKind = typeof TURN_EVENT_KINDS[number];
export type AgentTurnEventVisibility = "public" | "internal";

export type ProviderStreamEventKind =
  | "model.stream.text_delta"
  | "model.stream.reasoning_delta"
  | "model.stream.tool_call_delta"
  | "model.stream.completed";

export interface ModelStreamTextDeltaPayload {
  streamId: string;
  textDelta: string;
  target: "opening_decision" | "public_note" | "final_candidate";
  sequence?: number;
}

export interface ModelStreamReasoningDeltaPayload {
  streamId: string;
  charCount: number;
  sequence?: number;
}

export interface ModelStreamToolCallDeltaPayload {
  streamId: string;
  callIndex: number;
  sequence: number;
  toolCallId?: string;
  safeToolName?: string;
  argumentCharCount: number;
  rawArgumentsDelta?: string;
  publicState: "generating" | "ready";
}

export interface ModelStreamCompletedPayload {
  streamId: string;
  status: "completed" | "failed" | "aborted";
}

export type ProviderStreamEventPayload =
  | ModelStreamTextDeltaPayload
  | ModelStreamReasoningDeltaPayload
  | ModelStreamToolCallDeltaPayload
  | ModelStreamCompletedPayload;

export interface AgentTurnEvent {
  id: string;
  sessionId: string;
  turnId: string;
  sessionSequence: number;
  turnSequence: number;
  createdAt: string;
  kind: AgentTurnEventKind;
  visibility: AgentTurnEventVisibility;
  payload: Record<string, unknown>;
}

export interface AgentTurnEventInput {
  id?: string;
  sessionId: string;
  turnId: string;
  sessionSequence: number;
  turnSequence: number;
  createdAt?: string;
  kind: AgentTurnEventKind;
  visibility?: AgentTurnEventVisibility;
  payload?: Record<string, unknown>;
}

export type RuntimeTurnEventInput = Omit<
  AgentTurnEventInput,
  "id" | "sessionId" | "turnId" | "sessionSequence" | "turnSequence" | "createdAt"
> & {
  createdAt?: string;
};

export interface ProgressRowLike {
  id: string;
  kind: string;
  safe_label: string;
  state: string;
  created_at?: string;
  safe_tool_name?: string;
  safe_input_label?: string;
  safe_count?: number;
  safe_order?: number;
  safe_path_labels?: string[];
  tool_call_id?: string;
  bridge_phase?: string;
  work_block_id?: string;
  work_block_label?: string;
  work_decision_summary?: string;
  work_decision_rationale?: string;
  work_decision_next_step?: string;
  work_decision_source?: string;
  work_decision_evidence_refs?: string[];
  runtime_fault_id?: string;
  runtime_fault_kind?: string;
  runtime_fault_retryable?: boolean;
  runtime_fault_public_summary?: string;
  runtime_fault_safe_error_code?: string;
  runtime_fault_safe_cause?: string;
  safe_detail_rows?: Array<{
    id: string;
    kind?: string;
    safe_label: string;
    safe_value?: string;
    state?: string;
  }>;
}

const TURN_EVENT_KIND_SET = new Set<string>(TURN_EVENT_KINDS);
export const FIRST_VISIBLE_PROGRESS_EVENT_KIND = "turn.first_progress";

export function createAgentTurnEvent(input: AgentTurnEventInput): AgentTurnEvent {
  if (!input.sessionId.trim()) throw new Error("turn event sessionId is required");
  if (!input.turnId.trim()) throw new Error("turn event turnId is required");
  if (!TURN_EVENT_KIND_SET.has(input.kind)) {
    throw new Error(`Unknown turn event kind: ${input.kind}`);
  }
  if (!Number.isInteger(input.sessionSequence) || input.sessionSequence < 1) {
    throw new Error("turn event sessionSequence must be a positive integer");
  }
  if (!Number.isInteger(input.turnSequence) || input.turnSequence < 1) {
    throw new Error("turn event turnSequence must be a positive integer");
  }
  return {
    id: input.id?.trim() || `turn-event-${randomUUID()}`,
    sessionId: input.sessionId,
    turnId: input.turnId,
    sessionSequence: input.sessionSequence,
    turnSequence: input.turnSequence,
    createdAt: input.createdAt || new Date().toISOString(),
    kind: input.kind,
    visibility: input.visibility ?? "public",
    payload: sanitizeTurnEventPayload(
      normalizeTurnStateContractPayload(input.kind, input.payload ?? {}) ??
        normalizeProviderStreamPayload(input.kind, input.payload ?? {}, input.visibility ?? "public") ??
        input.payload ??
        {},
      input.visibility ?? "public",
    ),
  };
}

export function normalizeAgentTurnEvent(value: unknown): AgentTurnEvent | null {
  if (!isRecord(value)) return null;
  try {
    return createAgentTurnEvent({
      id: stringValue(value.id),
      sessionId: requiredString(value.sessionId),
      turnId: requiredString(value.turnId),
      sessionSequence: numberValue(value.sessionSequence),
      turnSequence: numberValue(value.turnSequence),
      createdAt: stringValue(value.createdAt),
      kind: requiredString(value.kind) as AgentTurnEventKind,
      visibility: value.visibility === "internal" ? "internal" : "public",
      payload: isRecord(value.payload) ? value.payload : {},
    });
  } catch {
    return null;
  }
}

export function sanitizeTurnEventPayload(
  payload: Record<string, unknown>,
  visibility: AgentTurnEventVisibility = "public",
): Record<string, unknown> {
  if (visibility === "internal") return jsonSafeRecord(payload);
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "operatorSummary") continue;
    sanitized[key] = sanitizePublicPayloadValue(value, key);
  }
  return sanitized;
}

export function publicNotePayload(text: unknown, fallback = "Working"): Record<string, unknown> {
  return {
    note: sanitizePublicText(text, fallback),
  };
}

function normalizeProviderStreamPayload(
  kind: string,
  payload: Record<string, unknown>,
  visibility: AgentTurnEventVisibility,
): Record<string, unknown> | null {
  if (kind === "model.stream.text_delta") {
    return {
      streamId: requiredPayloadText(payload.streamId, "model stream id is required"),
      textDelta: requiredPayloadText(payload.textDelta, "model stream text delta is required"),
      target: requiredTextDeltaTarget(payload.target),
      ...optionalPayloadSequence(payload.sequence),
    };
  }
  if (kind === "model.stream.reasoning_delta") {
    if (visibility !== "internal") {
      throw new Error("model stream reasoning deltas must be internal");
    }
    return {
      streamId: requiredPayloadText(payload.streamId, "model stream id is required"),
      charCount: requiredNonNegativeInteger(payload.charCount, "model stream reasoning charCount must be a non-negative integer"),
      ...optionalPayloadSequence(payload.sequence),
    };
  }
  if (kind === "model.stream.tool_call_delta") {
    if (visibility === "public" && payload.rawArgumentsDelta !== undefined) {
      throw new Error("public model stream tool call deltas must not include rawArgumentsDelta");
    }
    return {
      streamId: requiredPayloadText(payload.streamId, "model stream id is required"),
      callIndex: requiredNonNegativeInteger(payload.callIndex, "model stream tool call callIndex must be a non-negative integer"),
      sequence: requiredNonNegativeInteger(payload.sequence, "model stream tool call sequence must be a non-negative integer"),
      ...optionalPayloadTextField("toolCallId", payload.toolCallId),
      ...optionalPayloadTextField("safeToolName", payload.safeToolName),
      argumentCharCount: requiredNonNegativeInteger(
        payload.argumentCharCount,
        "model stream tool call argumentCharCount must be a non-negative integer",
      ),
      ...(visibility === "internal" ? optionalInternalRawStringField("rawArgumentsDelta", payload.rawArgumentsDelta) : {}),
      publicState: requiredToolCallPublicState(payload.publicState),
    };
  }
  if (kind === "model.stream.completed") {
    return {
      streamId: requiredPayloadText(payload.streamId, "model stream id is required"),
      status: requiredStreamCompletedStatus(payload.status),
    };
  }
  return null;
}

export function progressRowFromTurnEvent(event: AgentTurnEvent): ProgressRowLike | null {
  if (event.visibility !== "public") return null;
  const payload = event.payload;
  const createdAt = event.createdAt;
  if (event.kind === "assistant.public_note") {
    const workBlockId = optionalPublicText(payload.workBlockId);
    const note = sanitizePublicText(payload.note, "Working");
    return {
      id: event.id,
      kind: "message",
      safe_label: note,
      state: "running",
      created_at: createdAt,
      work_block_id: workBlockId,
      work_block_label: optionalPublicText(payload.workBlockLabel) ?? (workBlockId ? note : undefined),
      ...publicDecisionFields(payload),
    };
  }
  if (event.kind === FIRST_VISIBLE_PROGRESS_EVENT_KIND) {
    return {
      id: event.id,
      kind: "turn",
      safe_label: sanitizePublicText(payload.note ?? payload.safeLabel, "Working"),
      state: "thinking",
      created_at: createdAt,
    };
  }
  if (event.kind === TURN_ACKNOWLEDGED_EVENT_KIND) {
    return {
      id: event.id,
      kind: "turn",
      safe_label: sanitizePublicText(payload.safeLabel, "Request received. Preparing the work."),
      state: "accepted",
      created_at: createdAt,
    };
  }
  if (event.kind === "work.block.started" || event.kind === "work.block.updated" || event.kind === "work.block.completed") {
    const label = sanitizePublicText(payload.label ?? payload.safeLabel, "Working");
    return {
      id: event.id,
      kind: "work_block",
      safe_label: label,
      state: event.kind === "work.block.completed" ? "delivered" : "running",
      created_at: createdAt,
      work_block_id: optionalPublicText(payload.workBlockId) ?? event.id,
      work_block_label: label,
      ...publicDecisionFields(payload),
    };
  }
  if (event.kind === "guard.started" || event.kind === "guard.completed") {
    return {
      id: event.id,
      kind: "system",
      safe_label: event.kind === "guard.started" ? "Checking response" : "Response checked",
      state: event.kind === "guard.started" ? "running" : "delivered",
      created_at: createdAt,
    };
  }
  if (event.kind.startsWith("tool.")) {
    const state = event.kind === "tool.failed"
      ? "failed"
      : event.kind === "tool.completed"
        ? "delivered"
        : "running";
    const toolName = sanitizePublicText(payload.toolName, "Tool");
    const inputLabel = optionalPublicText(payload.inputLabel);
    const safeLabel = sanitizePublicText(payload.safeLabel, inputLabel ? `${toolName}: ${inputLabel}` : toolName);
    return {
      id: event.id,
      kind: safeProgressKind(payload.activityKind),
      safe_label: safeLabel,
      state,
      created_at: createdAt,
      safe_tool_name: toolName,
      safe_input_label: inputLabel,
      tool_call_id: optionalPublicText(payload.toolCallId),
      bridge_phase: optionalPublicText(payload.bridgePhase),
      work_block_id: optionalPublicText(payload.workBlockId),
      work_block_label: optionalPublicText(payload.workBlockLabel),
      ...publicDecisionFields(payload),
      safe_detail_rows: safeDetailRows(payload.detailRows),
    };
  }
  if (event.kind === "turn.accepted" || event.kind === "turn.started") {
    return {
      id: event.id,
      kind: "turn",
      safe_label: event.kind === "turn.accepted" ? "Accepted" : "Started",
      state: event.kind === "turn.accepted" ? "accepted" : "thinking",
      created_at: createdAt,
    };
  }
  if (event.kind === "message.final.started") {
    return {
      id: event.id,
      kind: "message",
      safe_label: "Preparing final answer",
      state: "running",
      created_at: createdAt,
    };
  }
  if (event.kind === "message.final.completed" || event.kind === "turn.completed") {
    return {
      id: event.id,
      kind: "turn",
      safe_label: event.kind === "message.final.completed" ? "Final answer ready" : "Completed",
      state: "delivered",
      created_at: createdAt,
    };
  }
  if (event.kind === "turn.failed" || event.kind === "turn.cancelled") {
    const label = event.kind === "turn.failed"
      ? sanitizePublicText(payload.safeLabel, "Failed")
      : "Cancelled";
    return {
      id: event.id,
      kind: "turn",
      safe_label: label,
      state: event.kind === "turn.failed" ? "failed" : "cancelled",
      created_at: createdAt,
    };
  }
  if (event.kind === "runtime.fault") {
    const publicSummary = sanitizePublicText(
      payload.publicSummary,
      "Butler runtime was interrupted before the turn could continue.",
    );
    return {
      id: event.id,
      kind: "runtime_fault",
      safe_label: publicSummary,
      state: "runtime_fault",
      created_at: createdAt,
      runtime_fault_id: sanitizePublicText(payload.faultId, event.id),
      runtime_fault_kind: sanitizePublicText(payload.kind, "runtime_fault"),
      runtime_fault_retryable: payload.retryable === true,
      runtime_fault_public_summary: publicSummary,
      runtime_fault_safe_error_code: optionalPublicText(payload.safeErrorCode),
      runtime_fault_safe_cause: optionalPublicText(payload.safeCause),
    };
  }
  return null;
}

export function turnEventFromProgressRow(input: {
  sessionId: string;
  turnId: string;
  row: ProgressRowLike;
  sessionSequence: number;
  turnSequence: number;
}): AgentTurnEvent {
  const row = input.row;
  return createAgentTurnEvent({
    sessionId: input.sessionId,
    turnId: input.turnId,
    sessionSequence: input.sessionSequence,
    turnSequence: input.turnSequence,
    kind: "tool.progress",
    createdAt: row.created_at,
    payload: {
      activityKind: row.kind,
      state: row.state,
      toolName: row.safe_tool_name,
      inputLabel: row.safe_input_label,
      safeLabel: row.safe_label,
      toolCallId: row.tool_call_id,
      workBlockId: row.work_block_id,
      workBlockLabel: row.work_block_label,
      decisionSummary: row.work_decision_summary,
      decisionRationale: row.work_decision_rationale,
      decisionNextStep: row.work_decision_next_step,
      decisionSource: row.work_decision_source,
      decisionEvidenceRefs: row.work_decision_evidence_refs,
      detailRows: row.safe_detail_rows,
      safeOrder: row.safe_order,
    },
  });
}

export const TURN_EVENT_COMPATIBILITY_MAPPINGS = [
  { source: "progress.summary", target: "tool.progress" },
  { source: "worker activity summary", target: "assistant.public_note or tool.progress compatibility projection" },
  { source: "typing presence", target: "transport presence compatibility projection" },
  { source: "message.created assistant", target: "message.final.completed plus canonical message record" },
] as const;

function sanitizePublicPayloadValue(value: unknown, key: string): unknown {
  if (key === "retryable" && typeof value === "boolean") return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return sanitizePublicText(value, decisionPayloadKey(key) ? "" : fallbackLabel(key));
  }
  if (Array.isArray(value)) {
    return value.slice(0, 12).map((item, index) =>
      sanitizePublicPayloadValue(item, `${key}_${index}`),
    );
  }
  if (isRecord(value)) {
    const sanitized: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      sanitized[childKey] = sanitizePublicPayloadValue(childValue, childKey);
    }
    return sanitized;
  }
  return null;
}

function decisionPayloadKey(key: string): boolean {
  return /^decision(?:Summary|Rationale|NextStep|EvidenceRefs|Source|Id)?$/u.test(key) ||
    /^(?:summary|rationale|nextStep|evidenceRefs)$/u.test(key);
}

function jsonSafeRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function safeProgressKind(value: unknown): string {
  const text = sanitizePublicText(value, "used_tool");
  if (
    text === "searched" ||
    text === "read" ||
    text === "ran_command" ||
    text === "edited" ||
    text === "dispatch" ||
    text === "used_tool" ||
    text === "context" ||
    text === "model"
  ) return text;
  return "used_tool";
}

function safeDetailRows(value: unknown): ProgressRowLike["safe_detail_rows"] {
  if (!Array.isArray(value)) return undefined;
  const rows = value
    .filter((row): row is Record<string, unknown> => isRecord(row))
    .map((row, index) => ({
      id: sanitizePublicText(row.id, `detail-${index + 1}`),
      kind: optionalPublicText(row.kind),
      safe_label: sanitizePublicText(row.safe_label, "Detail"),
      safe_value: optionalPublicText(row.safe_value),
      state: optionalPublicText(row.state),
    }))
    .slice(0, 8);
  return rows.length > 0 ? rows : undefined;
}

function publicDecisionFields(payload: Record<string, unknown>): Partial<ProgressRowLike> {
  const source = optionalPublicText(payload.decisionSource ?? payload.source);
  if (!isAuthoredDecisionSource(source)) return {};
  const summary = optionalPublicText(payload.decisionSummary ?? payload.summary);
  const rationale = optionalPublicText(payload.decisionRationale ?? payload.rationale);
  const nextStep = optionalPublicText(payload.decisionNextStep ?? payload.nextStep);
  if (!summary || !rationale || !nextStep) return {};
  const rawEvidenceRefs = payload.decisionEvidenceRefs ?? payload.evidenceRefs;
  const evidenceRefs = Array.isArray(rawEvidenceRefs)
    ? rawEvidenceRefs
        .map((item) => optionalPublicText(item))
        .filter((item): item is string => Boolean(item))
        .slice(0, 6)
    : undefined;
  const fields: Partial<ProgressRowLike> = {};
  if (summary) fields.work_decision_summary = summary;
  if (rationale) fields.work_decision_rationale = rationale;
  if (nextStep) fields.work_decision_next_step = nextStep;
  if (source) fields.work_decision_source = source;
  if (evidenceRefs && evidenceRefs.length > 0) fields.work_decision_evidence_refs = evidenceRefs;
  return fields;
}

function optionalPublicText(value: unknown): string | undefined {
  const text = sanitizePublicText(value, "");
  return text || undefined;
}

function requiredPayloadText(value: unknown, message: string): string {
  const text = optionalPublicText(value);
  if (!text) throw new Error(message);
  return text;
}

function optionalPayloadTextField(key: string, value: unknown): Record<string, string> {
  const text = optionalPublicText(value);
  return text ? { [key]: text } : {};
}

function optionalInternalRawStringField(key: string, value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== "string") {
    throw new Error(`model stream ${key} must be a string`);
  }
  return { [key]: JSON.parse(JSON.stringify(value)) as string };
}

function optionalPayloadSequence(value: unknown): Record<string, number> {
  if (value === undefined) return {};
  return {
    sequence: requiredNonNegativeInteger(value, "model stream sequence must be a non-negative integer"),
  };
}

function requiredNonNegativeInteger(value: unknown, message: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(message);
  return value as number;
}

function requiredTextDeltaTarget(value: unknown): ModelStreamTextDeltaPayload["target"] {
  if (
    value === "opening_decision" ||
    value === "public_note" ||
    value === "final_candidate"
  ) return value;
  throw new Error("model stream text delta target is invalid");
}

function requiredToolCallPublicState(value: unknown): ModelStreamToolCallDeltaPayload["publicState"] {
  if (value === "generating" || value === "ready") return value;
  throw new Error("model stream tool call publicState is invalid");
}

function requiredStreamCompletedStatus(value: unknown): ModelStreamCompletedPayload["status"] {
  if (value === "completed" || value === "failed" || value === "aborted") return value;
  throw new Error("model stream completed status is invalid");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function fallbackLabel(key: string): string {
  return key
    .split(/[_-]+/u)
    .filter(Boolean)
    .map((part) => part[0]?.toLocaleUpperCase("en-US") + part.slice(1))
    .join(" ") || "Value";
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("required string");
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("required number");
  return value;
}
