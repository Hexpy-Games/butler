import {
  retainToolEvidence,
  TOOL_EVIDENCE_REHYDRATION_SCHEMA,
  type EvidencePacket,
  type ToolEvidenceRetentionContext,
} from "./tool-evidence-retention.ts";

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
 * evidence store; provider adapters only serialize this provider-neutral value.
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
  const completed: CompletedToolEvidence = {
    schema: COMPLETED_TOOL_EVIDENCE_SCHEMA,
    status: "complete",
    tool_name: input.toolName,
    ...(input.toolCallId ? { tool_call_id: input.toolCallId } : {}),
    subject: evidence.packet.subject,
    facts: evidence.packet.facts,
    evidence_packet: evidence.packet,
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
 * Keeps completed results pointer-first across later provider boundaries.
 * Exact raw evidence crosses the boundary only through an explicit bounded
 * read_tool_evidence_artifact observation.
 */
export function compileCompletedToolEvidencePointers(input: {
  body: Record<string, unknown>;
}): Record<string, unknown> {
  const compiled = JSON.parse(JSON.stringify(input.body)) as Record<string, unknown>;
  const stripLegacyInlineOutput = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) stripLegacyInlineOutput(item);
      return;
    }
    const current = record(value);
    if (!current) return;
    if (current.schema === COMPLETED_TOOL_EVIDENCE_SCHEMA) {
      delete current.inline_output;
    }
    for (const nested of Object.values(current)) stripLegacyInlineOutput(nested);
  };
  stripLegacyInlineOutput(compiled);
  return compiled;
}
