import {
  retainToolEvidence,
  RAW_TOOL_ARTIFACT_SCHEMA,
  type EvidencePacket,
  type ToolEvidenceRetentionContext,
} from "./tool-evidence-retention.ts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";

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

function exactArtifactOutput(completed: Record<string, unknown>): unknown | undefined {
  const packet = record(completed.evidence_packet);
  const rehydrate = record(packet?.rehydrate);
  const path = typeof rehydrate?.path === "string" ? rehydrate.path : null;
  const digest = typeof packet?.digest === "string" ? packet.digest : null;
  if (!path || !digest) return undefined;
  try {
    const artifact = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (artifact.schema !== RAW_TOOL_ARTIFACT_SCHEMA || artifact.digest !== digest) return undefined;
    if (typeof artifact.serialized_text !== "string") return undefined;
    const actualDigest = createHash("sha256").update(artifact.serialized_text).digest("hex");
    return actualDigest === digest ? artifact.raw : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Adds exact inline outputs only when the complete finalized provider request
 * still fits the caller's conservative serialized UTF-8 upper bound. Candidate
 * order follows the serialized object order and never depends on tool names,
 * content keywords, or arbitrary result-size thresholds.
 */
export function compileCompletedToolEvidenceInline(input: {
  body: Record<string, unknown>;
  serializedUtf8Capacity: number;
}): Record<string, unknown> {
  const compiled = JSON.parse(JSON.stringify(input.body)) as Record<string, unknown>;
  const candidates: Record<string, unknown>[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const current = record(value);
    if (!current) return;
    if (current.schema === COMPLETED_TOOL_EVIDENCE_SCHEMA) candidates.push(current);
    for (const nested of Object.values(current)) visit(nested);
  };
  visit(compiled);

  for (const completed of candidates) {
    const exact = exactArtifactOutput(completed);
    if (exact === undefined) continue;
    completed.inline_output = exact;
    if (Buffer.byteLength(JSON.stringify(compiled), "utf8") > input.serializedUtf8Capacity) {
      delete completed.inline_output;
    }
  }
  return compiled;
}
