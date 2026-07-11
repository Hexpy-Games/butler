import type {
  SharedProgressDetailRow,
  SharedProgressRow,
  SharedTurnEvent,
  SharedWorkBlockPhase,
} from "./progress-projection-contract.ts";
import { sanitizePublicText } from "./public-text.ts";

const PUBLIC_DECISION_SOURCES = new Set([
  "assistant-authored",
  "model-authored",
  "principal-authored",
]);

export function eventRowBase(event: SharedTurnEvent): Pick<
  SharedProgressRow,
  "id" | "created_at" | "turn_event_sequence"
> {
  return {
    id: event.id,
    created_at: event.createdAt,
    turn_event_sequence: optionalNonNegativeInteger(event.turnSequence),
  };
}

export function workDecisionFields(
  payload: Record<string, unknown>,
): Partial<SharedProgressRow> {
  const source = optionalText(payload.decisionSource ?? payload.source);
  const fields: Partial<SharedProgressRow> = contractFields(payload);
  const summary = optionalText(payload.decisionSummary ?? payload.summary);
  const rationale = optionalText(payload.decisionRationale ?? payload.rationale);
  const nextStep = optionalText(payload.decisionNextStep ?? payload.nextStep);
  if (
    !source ||
    !PUBLIC_DECISION_SOURCES.has(source) ||
    !summary ||
    !rationale ||
    !nextStep
  ) {
    return fields;
  }
  const decisionId = optionalText(payload.decisionId);
  const title = optionalText(payload.decisionTitle ?? payload.blockTitle);
  if (decisionId) fields.work_decision_id = decisionId;
  if (title) fields.work_decision_title = title;
  if (summary) fields.work_decision_summary = summary;
  if (rationale) fields.work_decision_rationale = rationale;
  if (nextStep) fields.work_decision_next_step = nextStep;
  fields.work_decision_source = source;
  const refs = textList(payload.decisionEvidenceRefs ?? payload.evidenceRefs, 6);
  if (refs.length > 0) fields.work_decision_evidence_refs = refs;
  return fields;
}

export function standaloneDecisionFields(
  payload: Record<string, unknown>,
): Partial<SharedProgressRow> {
  const source = optionalText(payload.source);
  if (!source || !PUBLIC_DECISION_SOURCES.has(source)) return {};
  const fields: Partial<SharedProgressRow> = contractFields(payload);
  const role = optionalText(payload.role);
  const summary = optionalText(payload.summary);
  const rationale = optionalText(payload.rationale);
  const nextStep = optionalText(payload.nextStep);
  if (role) fields.public_decision_role = role;
  if (summary) fields.public_decision_summary = summary;
  if (rationale) fields.public_decision_rationale = rationale;
  if (nextStep) fields.public_decision_next_step = nextStep;
  fields.public_decision_source = source;
  const modelCallId = optionalText(payload.modelCallId);
  if (modelCallId) fields.public_decision_model_call_id = modelCallId;
  const latencyMs = optionalNonNegativeInteger(payload.latencyMs);
  if (latencyMs !== undefined) fields.public_decision_latency_ms = latencyMs;
  const refs = textList(payload.evidenceRefs, 6);
  if (refs.length > 0) fields.public_decision_evidence_refs = refs;
  return fields;
}

function contractFields(payload: Record<string, unknown>): Partial<SharedProgressRow> {
  const fields: Partial<SharedProgressRow> = {};
  const contractId = optionalText(payload.contractId);
  const workstreamId = optionalText(payload.workstreamId);
  const semanticBlockId = optionalText(payload.semanticBlockId);
  if (contractId) fields.work_contract_id = contractId;
  if (workstreamId) fields.work_stream_id = workstreamId;
  if (semanticBlockId) fields.semantic_block_id = semanticBlockId;
  return fields;
}

export function workBlockPhase(kind: string): SharedWorkBlockPhase | null {
  if (kind === "work.block.started") return "started";
  if (kind === "work.block.updated") return "updated";
  if (kind === "work.block.completed") return "completed";
  return null;
}

export function completedBlockState(payload: Record<string, unknown>): string {
  const status = optionalText(payload.status);
  if (status === "failed" || status === "cancelled") return status;
  return "delivered";
}

export function blockSequence(payload: Record<string, unknown>): number | undefined {
  const direct = optionalNonNegativeInteger(payload.blockSequence);
  if (direct !== undefined) return direct;
  const semanticBlockId = optionalText(payload.semanticBlockId);
  const suffix = semanticBlockId?.match(/:block:(\d+)$/u)?.[1];
  return suffix ? optionalNonNegativeInteger(suffix) : undefined;
}

export function progressKind(value: unknown): string {
  const kind = safeText(value, "used_tool");
  return [
    "searched",
    "read",
    "ran_command",
    "edited",
    "dispatch",
    "used_tool",
    "context",
    "model",
    "message",
    "turn",
    "system",
  ].includes(kind)
    ? kind
    : "used_tool";
}

export function detailRows(value: unknown): SharedProgressDetailRow[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows = value
    .filter(isRecord)
    .map((row, index) => ({
      id: safeText(row.id, `detail-${index + 1}`),
      kind: optionalText(row.kind),
      safe_label: safeText(row.safe_label, "Detail"),
      safe_value: optionalText(row.safe_value),
      state: optionalText(row.state),
    }))
    .slice(0, 8);
  return rows.length > 0 ? rows : undefined;
}

function textList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(optionalText)
    .filter((item): item is string => Boolean(item))
    .slice(0, limit);
}

export function optionalText(value: unknown): string | undefined {
  const text = safeText(value, "");
  return text || undefined;
}

export function safeText(value: unknown, fallback: string): string {
  return sanitizePublicText(value, fallback);
}

export function optionalNonNegativeInteger(value: unknown): number | undefined {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 0) return undefined;
  return Math.floor(numberValue);
}

export function recordPayload(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
