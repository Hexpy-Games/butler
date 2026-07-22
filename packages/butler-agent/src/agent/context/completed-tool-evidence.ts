import {
  EVIDENCE_PACKET_SCHEMA,
  retainToolEvidence,
  TOOL_EVIDENCE_REHYDRATION_SCHEMA,
  type EvidencePacket,
  type ToolEvidenceRetentionContext,
} from "./tool-evidence-retention.ts";
import { structuredToolResultModelPreview } from "../turn/tool-result-model-preview.ts";
import { SEMANTIC_WORK_BLOCK_TOOL_LIMIT } from "../turn/tool-batch-capacity.ts";

export const COMPLETED_TOOL_EVIDENCE_SCHEMA = "butler.completed-tool-evidence.v1";

export interface CompletedToolEvidence {
  schema: typeof COMPLETED_TOOL_EVIDENCE_SCHEMA;
  status: "complete";
  tool_name: string;
  tool_call_id?: string;
  subject: string | null;
  facts: Record<string, unknown>;
  evidence_packet: EvidencePacket;
  inline_output?: unknown;
}

/**
 * Converts a successful tool result into the only representation allowed to
 * cross a later provider-request boundary. The exact result is retained by the
 * evidence store; provider adapters serialize this provider-neutral value and
 * may admit its declared provider-safe preview when the exact request fits.
 *
 * Failed results remain structured failures so the provider-valid call/result
 * pair is preserved and the model can repair the call.
 */
export function toolResultPayloadForProvider(input: {
  payload: Record<string, unknown>;
  toolName: string;
  toolCallId?: string;
  evidenceRetention?: ToolEvidenceRetentionContext;
}): Record<string, unknown> {
  if (input.payload.ok !== true) return input.payload;
  if (isTerminalEvidenceObservation(input.payload.output)) {
    return terminalEvidenceObservationForProvider(input.payload);
  }
  if (isWorkBlockExecutionResult(input.payload.output)) {
    return workBlockPayloadForProvider(input);
  }

  const evidence = retainToolEvidence({
    context: input.evidenceRetention,
    toolName: input.toolName,
    toolCallId: input.toolCallId,
    output: input.payload.output,
    reason: "completed_tool_result_boundary",
  });
  const inlineOutput = structuredToolResultModelPreview({
    toolName: input.toolName,
    output: input.payload.output,
  });
  const completed: CompletedToolEvidence = {
    schema: COMPLETED_TOOL_EVIDENCE_SCHEMA,
    status: "complete",
    tool_name: input.toolName,
    ...(input.toolCallId ? { tool_call_id: input.toolCallId } : {}),
    subject: evidence.packet.subject,
    facts: evidence.packet.facts,
    evidence_packet: evidence.packet,
    ...(inlineOutput === null ? {} : { inline_output: inlineOutput }),
  };

  return { ok: true, output: completed };
}

function isTerminalEvidenceObservation(value: unknown): value is Record<string, unknown> {
  const output = record(value);
  if (
    output?.schema_version !== TOOL_EVIDENCE_REHYDRATION_SCHEMA ||
    output.terminal_evidence_observation !== true ||
    output.ok !== true ||
    output.rawTextStored !== false
  ) return false;
  const artifact = record(output.artifact);
  if (!artifact || typeof artifact.id !== "string" || !artifact.id.trim()) return false;
  const slices = [output.text, output.stdout, output.stderr]
    .filter((slice) => slice !== undefined);
  return slices.length > 0 && slices.every(isBoundedEvidenceSlice);
}

function isBoundedEvidenceSlice(value: unknown): boolean {
  const slice = record(value);
  return Boolean(
    slice &&
    typeof slice.text === "string" &&
    finiteNonNegativeNumber(slice.start_line) &&
    finiteNonNegativeNumber(slice.returned_lines) &&
    finiteNonNegativeNumber(slice.total_lines) &&
    finiteNonNegativeNumber(slice.estimated_tokens) &&
    typeof slice.truncated_by_lines === "boolean" &&
    typeof slice.truncated_by_tokens === "boolean",
  );
}

function finiteNonNegativeNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function terminalEvidenceObservationForProvider(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const output = record(payload.output)!;
  const artifact = record(output.artifact);
  if (!artifact) return payload;
  const { path: _path, cwd: _cwd, ...providerSafeArtifact } = artifact;
  return {
    ...payload,
    output: {
      ...output,
      artifact: providerSafeArtifact,
    },
  };
}

function isWorkBlockExecutionResult(value: unknown): value is Record<string, unknown> {
  const output = record(value);
  return output?.butler_work_block_result === true && Array.isArray(output.results);
}

function workBlockPayloadForProvider(input: {
  payload: Record<string, unknown>;
  toolName: string;
  toolCallId?: string;
  evidenceRetention?: ToolEvidenceRetentionContext;
}): Record<string, unknown> {
  const output = record(input.payload.output)!;
  const childResults = (output.results as unknown[]).map((value, index) => {
    const child = record(value) ?? {};
    const name = typeof child.name === "string" && child.name.trim()
      ? child.name.trim()
      : "unknown_tool";
    if (child.ok !== true) {
      return {
        name,
        ok: false,
        ...(typeof child.error === "string" ? { error: child.error } : {}),
        ...(child.output !== undefined ? { output: child.output } : {}),
      };
    }
    const childPayload = toolResultPayloadForProvider({
      payload: { ok: true, output: child.output ?? null },
      toolName: name,
      toolCallId: input.toolCallId ? `${input.toolCallId}:${index}` : undefined,
      evidenceRetention: input.evidenceRetention,
    });
    return {
      name,
      ok: true,
      output: childPayload.output,
    };
  });
  return {
    ok: true,
    output: {
      butler_work_block_result: true,
      ...(output.decision_feedback !== undefined
        ? { decision_feedback: output.decision_feedback }
        : {}),
      ...(output.frontier !== undefined ? { frontier: output.frontier } : {}),
      results: childResults,
    },
  };
}

export function serializeToolResultPayloadForProvider(input: {
  payload: Record<string, unknown>;
  toolName: string;
  toolCallId?: string;
  evidenceRetention?: ToolEvidenceRetentionContext;
}): string {
  return JSON.stringify(toolResultPayloadForProvider(input));
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Compiles provider-safe completed observations against the exact serialized
 * request capacity. Results outside the newest semantic block, or results that
 * do not fit, remain lossless evidence pointers. Exact raw evidence crosses the
 * boundary only through an explicit bounded read_tool_evidence_artifact call.
 */
export function compileCompletedToolEvidencePointers(input: {
  body: Record<string, unknown>;
  maxSerializedTokens?: number;
  measureSerializedTokens?: (value: Record<string, unknown>) => number;
}): Record<string, unknown> {
  const source = JSON.parse(JSON.stringify(input.body)) as Record<string, unknown>;
  const inlineCount = countCompletedToolEvidenceInlineOutputs(source);
  const selected = new Set<number>();
  let compiled = compileCompletedToolEvidenceSelection(source, selected);
  const capacity = finiteSerializedTokenCapacity(input.maxSerializedTokens);
  if (capacity === null || !input.measureSerializedTokens || inlineCount === 0) return compiled;

  // Only the newest semantic block can contain results the model has not yet
  // observed. Older results already crossed a provider boundary and stay as
  // lossless evidence pointers. This structural bound also keeps compilation
  // linear in long-lived turns instead of repeatedly rebuilding their entire
  // history for every retained result.
  const oldestUnobservedIndex = Math.max(
    0,
    inlineCount - SEMANTIC_WORK_BLOCK_TOOL_LIMIT,
  );
  for (let index = inlineCount - 1; index >= oldestUnobservedIndex; index -= 1) {
    const candidateSelection = new Set(selected).add(index);
    const candidate = compileCompletedToolEvidenceSelection(source, candidateSelection);
    if (input.measureSerializedTokens(candidate) <= capacity) {
      selected.add(index);
      compiled = candidate;
    }
  }
  return compiled;
}

function countCompletedToolEvidenceInlineOutputs(value: unknown): number {
  let count = 0;
  visitJsonValue(value, (current) => {
    if (
      isCompletedToolEvidenceRecord(current) &&
      Object.prototype.hasOwnProperty.call(current, "inline_output")
    ) count += 1;
  });
  return count;
}

function compileCompletedToolEvidenceSelection(
  source: Record<string, unknown>,
  selected: ReadonlySet<number>,
): Record<string, unknown> {
  let inlineIndex = 0;
  return transformJsonValue(source, (current) => {
    if (
      !isCompletedToolEvidenceRecord(current) ||
      !Object.prototype.hasOwnProperty.call(current, "inline_output")
    ) return current;
    const index = inlineIndex;
    inlineIndex += 1;
    if (!selected.has(index)) delete current.inline_output;
    return current;
  }) as Record<string, unknown>;
}

function visitJsonValue(
  value: unknown,
  visit: (current: Record<string, unknown>) => void,
): void {
  if (typeof value === "string") {
    const parsed = parseJsonContainer(value);
    if (parsed !== null) visitJsonValue(parsed, visit);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) visitJsonValue(item, visit);
    return;
  }
  const current = record(value);
  if (!current) return;
  visit(current);
  for (const nested of Object.values(current)) visitJsonValue(nested, visit);
}

function transformJsonValue(
  value: unknown,
  transform: (current: Record<string, unknown>) => Record<string, unknown>,
): unknown {
  if (typeof value === "string") {
    const parsed = parseJsonContainer(value);
    return parsed === null ? value : JSON.stringify(transformJsonValue(parsed, transform));
  }
  if (Array.isArray(value)) {
    return value.map((item) => transformJsonValue(item, transform));
  }
  const current = record(value);
  if (!current) return value;
  const transformed = transform({ ...current });
  return Object.fromEntries(
    Object.entries(transformed).map(([key, nested]) => [
      key,
      transformJsonValue(nested, transform),
    ]),
  );
}

function parseJsonContainer(value: string): unknown | null {
  const trimmed = value.trim();
  if (
    !(trimmed.startsWith("{") || trimmed.startsWith("[")) ||
    !value.includes(`"${COMPLETED_TOOL_EVIDENCE_SCHEMA}"`)
  ) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return containsCompletedToolEvidence(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function containsCompletedToolEvidence(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsCompletedToolEvidence);
  const current = record(value);
  if (!current) return false;
  if (isCompletedToolEvidenceRecord(current)) return true;
  return Object.values(current).some((nested) =>
    typeof nested === "string" ? false : containsCompletedToolEvidence(nested),
  );
}

function isCompletedToolEvidenceRecord(
  value: Record<string, unknown>,
): value is Record<string, unknown> & CompletedToolEvidence {
  const packet = record(value.evidence_packet);
  return value.schema === COMPLETED_TOOL_EVIDENCE_SCHEMA &&
    value.status === "complete" &&
    typeof value.tool_name === "string" &&
    Boolean(value.tool_name.trim()) &&
    packet?.schema === EVIDENCE_PACKET_SCHEMA;
}

function finiteSerializedTokenCapacity(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : null;
}
