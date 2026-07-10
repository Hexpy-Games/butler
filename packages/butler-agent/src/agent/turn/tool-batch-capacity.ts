export const SEMANTIC_WORK_BLOCK_TOOL_LIMIT = 6;

export interface ToolBatchCapacityObservation {
  observationId: string;
  turnId: string;
  kind: "block_capacity";
  visibility: "model";
  summary: string;
  modelVisibleContent: string;
  causedByToolCallId: string;
  createdAt: string;
}

export function partitionSemanticToolBatch<T>(calls: readonly T[]): {
  executable: T[];
  deferred: T[];
} {
  return {
    executable: calls.slice(0, SEMANTIC_WORK_BLOCK_TOOL_LIMIT),
    deferred: calls.slice(SEMANTIC_WORK_BLOCK_TOOL_LIMIT),
  };
}

export function blockCapacityObservation(input: {
  toolCallId: string;
  toolName: string;
  deferredCount: number;
  turnId?: string;
}): ToolBatchCapacityObservation {
  const deferredCount = Math.max(1, Math.floor(input.deferredCount));
  return {
    observationId: `obs-block-capacity-${safeId(input.toolCallId)}`,
    turnId: safeId(input.turnId ?? "provider-agent-loop"),
    kind: "block_capacity",
    visibility: "model",
    summary: `The semantic work block executed its first ${SEMANTIC_WORK_BLOCK_TOOL_LIMIT} tool calls; ${deferredCount} call(s) require a new decision.`,
    modelVisibleContent: [
      `Tool ${input.toolName} was not executed because the current semantic work block already reached ${SEMANTIC_WORK_BLOCK_TOOL_LIMIT} executed calls.`,
      "Observe the completed results, author a fresh public decision for the next small step, and re-request only the calls still needed.",
      "The runtime did not move or execute this call implicitly.",
    ].join("\n"),
    causedByToolCallId: safeId(input.toolCallId),
    createdAt: new Date(0).toISOString(),
  };
}

export function blockCapacityToolOutput(
  observation: ToolBatchCapacityObservation,
): Record<string, unknown> {
  return {
    ok: false,
    executed: false,
    observation,
    observation_kind: observation.kind,
    summary: observation.summary,
    model_visible_content: observation.modelVisibleContent,
  };
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._:-]/gu, "-").slice(0, 120) || "unknown";
}
