import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

export const TURN_EVENT_KINDS = [
  "turn.accepted",
  "turn.started",
  "turn.iteration.started",
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
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
] as const;

export type AgentTurnEventKind = typeof TURN_EVENT_KINDS[number];
export type AgentTurnEventVisibility = "public" | "internal";

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
  work_block_id?: string;
  work_block_label?: string;
  work_decision_summary?: string;
  work_decision_rationale?: string;
  work_decision_next_step?: string;
  work_decision_source?: string;
  work_decision_evidence_refs?: string[];
  safe_detail_rows?: Array<{
    id: string;
    kind?: string;
    safe_label: string;
    safe_value?: string;
    state?: string;
  }>;
}

const TURN_EVENT_KIND_SET = new Set<string>(TURN_EVENT_KINDS);
const SAFE_TEXT_MAX = 240;

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
    payload: sanitizeTurnEventPayload(input.payload ?? {}, input.visibility ?? "public"),
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
    sanitized[key] = sanitizePublicPayloadValue(value, key);
  }
  return sanitized;
}

export function publicNotePayload(text: unknown, fallback = "Working"): Record<string, unknown> {
  return {
    note: sanitizePublicText(text, fallback),
  };
}

export function isPublicTextSafe(value: unknown): boolean {
  return sanitizePublicText(value, "") === String(value ?? "").trim().slice(0, SAFE_TEXT_MAX);
}

export function sanitizePublicText(value: unknown, fallback = "Working"): string {
  const raw = typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : "";
  const normalized = stripControlCharacters(raw)
    .replace(secretAssignmentPattern(), "[redacted]")
    .replace(/\bbearer\s+[\w.~+/=-]+/giu, "Bearer [redacted]")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return fallback;
  if (looksPrivateOrInternal(normalized)) return fallback;
  return normalized.slice(0, SAFE_TEXT_MAX);
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
      ...publicDecisionFields(payload, label),
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
      work_block_id: optionalPublicText(payload.workBlockId),
      work_block_label: optionalPublicText(payload.workBlockLabel) ?? safeLabel,
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

function looksPrivateOrInternal(value: string): boolean {
  if (looksPrivateOrInternalText(value)) return true;
  const decoded = decodeBase64Candidate(value);
  return Boolean(decoded && looksPrivateOrInternalText(decoded));
}

function looksPrivateOrInternalText(value: string): boolean {
  return /<\s*\/?\s*(?:think|thinking|reasoning)\b[^>]*>/iu.test(value) ||
    /<\|?(?:channel|start|message|assistant|analysis|final)[^>]*\|?>/i.test(value) ||
    /\b(?:hidden reasoning|chain[- ]of[- ]thought|scratchpad|internal plan|let me think|let's think|i need to think|we need to think|step[- ]by[- ]step reasoning)\b/iu.test(value) ||
    /\b(?:tool_call|tool_result|argumentsJson|raw transcript|sessionId|eventId|FileNotFoundException|root_path|butler-workers|ENOENT)\b/u.test(value) ||
    /(?:^|[\s"'`:=])\/(?:Users|private|tmp|var\/folders|home|Volumes|opt|usr|etc)\b/u.test(value) ||
    /(?:^|[\s"'`:=])(?:[A-Za-z]:\\|\\\\[^\s\\]+\\[^\s\\]+)/u.test(value) ||
    /^\s*[{[]/u.test(value) && /"(?:eventId|sessionId|payload|arguments|tool_call)"/u.test(value);
}

function decodeBase64Candidate(value: string): string | null {
  const compact = value.replace(/\s+/gu, "");
  if (compact.length < 24 || compact.length > 2_048) return null;
  if (!/^[A-Za-z0-9+/=_-]+$/u.test(compact)) return null;
  try {
    const normalized = compact.replace(/-/gu, "+").replace(/_/gu, "/");
    const decoded = Buffer.from(normalized, "base64").toString("utf8");
    if (!decoded || decoded.includes("\uFFFD")) return null;
    return decoded;
  } catch {
    return null;
  }
}

function secretAssignmentPattern(): RegExp {
  return /\b(?:api[_-]?key|token|secret|password|database_url|db_url)\s*[:=]\s*\S+|\b(?:auth|authorization)\s*[:=]\s*(?:bearer\s+)?\S+/giu;
}

function safeProgressKind(value: unknown): string {
  const text = sanitizePublicText(value, "used_tool");
  if (
    text === "searched" ||
    text === "read" ||
    text === "ran_command" ||
    text === "edited" ||
    text === "dispatch" ||
    text === "used_tool"
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

function publicDecisionFields(
  payload: Record<string, unknown>,
  fallbackSummary?: string,
): Partial<ProgressRowLike> {
  const summary = optionalPublicText(payload.decisionSummary ?? payload.summary) ?? fallbackSummary;
  const rationale = optionalPublicText(payload.decisionRationale ?? payload.rationale);
  const nextStep = optionalPublicText(payload.decisionNextStep ?? payload.nextStep);
  const source = optionalPublicText(payload.decisionSource ?? payload.source);
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

function stripControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("");
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
