import { randomUUID } from "node:crypto";
import { sanitizePublicText } from "./public-text.ts";
import {
  TURN_STATE_CONTRACT_EVENT_KINDS,
  normalizeTurnStateContractPayload,
} from "./turn-state-contract.ts";
import { progressRowFromSharedTurnEvent } from "./progress-projection.ts";

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
  "tool_call.finalized",
  "tool.started",
  "tool.progress",
  "tool.completed",
  "tool.failed",
  "tool.cancelled",
  "tool_result.finalized",
  "tool_result.failed",
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
  id?: string;
  sessionSequence?: number;
  turnSequence?: number;
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
  turn_event_sequence?: number;
  safe_path_labels?: string[];
  tool_call_id?: string;
  tool_result_id?: string;
  tool_result_byte_length?: number;
  bridge_phase?: string;
  receipt_kind?: string;
  public_decision_role?: string;
  public_decision_summary?: string;
  public_decision_rationale?: string;
  public_decision_next_step?: string;
  public_decision_source?: string;
  public_decision_model_call_id?: string;
  public_decision_latency_ms?: number;
  public_decision_evidence_refs?: string[];
  work_contract_id?: string;
  work_stream_id?: string;
  semantic_block_id?: string;
  activity_stage?: string;
  work_block_id?: string;
  work_block_label?: string;
  work_block_phase?: "started" | "updated" | "completed";
  work_block_sequence?: number;
  work_decision_id?: string;
  work_decision_title?: string;
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
      input.kind,
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
  kind?: string,
): Record<string, unknown> {
  if (visibility === "internal") return jsonSafeRecord(payload);
  const preserveProviderStreamNumbers = kind?.startsWith("model.stream.") === true;
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "operatorSummary") continue;
    sanitized[key] = sanitizePublicPayloadValue(value, key, preserveProviderStreamNumbers);
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
  return progressRowFromSharedTurnEvent(event);
}

export function turnEventFromProgressRow(input: {
  sessionId: string;
  turnId: string;
  row: ProgressRowLike;
  sessionSequence: number;
  turnSequence: number;
}): AgentTurnEvent {
  const row = input.row;
  const kind = row.kind === "work_block"
    ? `work.block.${row.work_block_phase ?? (isTerminalProjectionState(row.state) ? "completed" : "started")}` as AgentTurnEventKind
    : "tool.progress";
  return createAgentTurnEvent({
    sessionId: input.sessionId,
    turnId: input.turnId,
    sessionSequence: input.sessionSequence,
    turnSequence: input.turnSequence,
    kind,
    createdAt: row.created_at,
    payload: {
      activityKind: row.kind,
      state: row.state,
      status: row.state,
      toolName: row.safe_tool_name,
      inputLabel: row.safe_input_label,
      safeLabel: row.safe_label,
      toolCallId: row.tool_call_id,
      workBlockId: row.work_block_id,
      workBlockLabel: row.work_block_label,
      contractId: row.work_contract_id,
      workstreamId: row.work_stream_id,
      semanticBlockId: row.semantic_block_id,
      activityStage: row.activity_stage,
      blockSequence: row.work_block_sequence,
      decisionId: row.work_decision_id,
      decisionTitle: row.work_decision_title,
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

function isTerminalProjectionState(state: string): boolean {
  return ["failed", "cancelled", "delivered", "complete", "completed"].includes(state);
}

export const TURN_EVENT_COMPATIBILITY_MAPPINGS = [
  { source: "progress.summary", target: "tool.progress" },
  { source: "worker activity summary", target: "assistant.public_note or tool.progress compatibility projection" },
  { source: "typing presence", target: "transport presence compatibility projection" },
  { source: "message.created assistant", target: "message.final.completed plus canonical message record" },
] as const;

function sanitizePublicPayloadValue(
  value: unknown,
  key: string,
  preserveProviderStreamNumbers = false,
): unknown {
  if (key === "retryable" && typeof value === "boolean") return value;
  if (key === "firstVisible" && typeof value === "boolean") return value;
  if (key === "latencyMs") return optionalNonNegativeInteger(value) ?? null;
  if (preserveProviderStreamNumbers && (
    key === "sequence" ||
    key === "charCount" ||
    key === "callIndex" ||
    key === "argumentCharCount"
  )) {
    return optionalNonNegativeInteger(value) ?? null;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return sanitizePublicText(value, decisionPayloadKey(key) ? "" : fallbackLabel(key));
  }
  if (Array.isArray(value)) {
    return value.slice(0, 12).map((item, index) =>
      sanitizePublicPayloadValue(item, `${key}_${index}`, preserveProviderStreamNumbers),
    );
  }
  if (isRecord(value)) {
    const sanitized: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      sanitized[childKey] = sanitizePublicPayloadValue(
        childValue,
        childKey,
        preserveProviderStreamNumbers,
      );
    }
    return sanitized;
  }
  return null;
}

function decisionPayloadKey(key: string): boolean {
  return /^decision(?:Title|Summary|Rationale|NextStep|EvidenceRefs|Source|Id)?$/u.test(key) ||
    /^(?:summary|rationale|nextStep|evidenceRefs|modelCallId)$/u.test(key);
}

function jsonSafeRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function optionalPublicText(value: unknown): string | undefined {
  const text = sanitizePublicText(value, "");
  return text || undefined;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  const numberValue =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  if (!Number.isFinite(numberValue) || numberValue < 0) return undefined;
  return Math.round(numberValue);
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
