const MAX_SIGNAL_CHARS = 64;
const MAX_ENCODED_FACTS_BYTES = 512;

export type GuidedOperationResultStructuralFacts = {
  outcome: "succeeded" | "failed" | "cancelled" | "unknown";
  completeness: "complete" | "incomplete";
  command_execution_summary?: {
    exit_status: number | null;
    timed_out: boolean;
    signal: string | null;
  };
};

type TerminalOperationStatus = "completed" | "failed" | "cancelled";

export function captureGuidedOperationResultStructuralFacts(input: {
  toolName: string;
  status: TerminalOperationStatus;
  result?: unknown;
}): GuidedOperationResultStructuralFacts {
  const layers = resultLayers(input.result);
  const failed = layers.some((layer) =>
    layer.ok === false || layer.timed_out === true ||
    (typeof layer.exit_code === "number" && layer.exit_code !== 0));
  const command = input.toolName === "run_command"
    ? commandExecutionSummary(layers)
    : undefined;
  return {
    outcome: input.status === "cancelled"
      ? "cancelled"
      : input.status === "failed" || failed
      ? "failed"
      : input.result === undefined
      ? "unknown"
      : "succeeded",
    completeness: input.result === undefined ? "incomplete" : "complete",
    ...(command ? { command_execution_summary: command } : {}),
  };
}

/** Legacy rows are classified only from durable metadata, never raw payload. */
export function legacyGuidedOperationResultStructuralFacts(input: {
  status: TerminalOperationStatus;
  resultSha256: string | null;
}): GuidedOperationResultStructuralFacts {
  return {
    outcome: input.status === "failed"
      ? "failed"
      : input.status === "cancelled"
      ? "cancelled"
      : "unknown",
    completeness: input.resultSha256 ? "complete" : "incomplete",
  };
}

export function encodeGuidedOperationResultStructuralFacts(
  value: GuidedOperationResultStructuralFacts,
): string {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > MAX_ENCODED_FACTS_BYTES) {
    throw new Error("guided_operation_result_facts_too_large");
  }
  return encoded;
}

export function decodeGuidedOperationResultStructuralFacts(
  encoded: string,
): GuidedOperationResultStructuralFacts {
  if (Buffer.byteLength(encoded, "utf8") > MAX_ENCODED_FACTS_BYTES) {
    throw new Error("guided_operation_result_facts_invalid");
  }
  const value = JSON.parse(encoded) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("guided_operation_result_facts_invalid");
  }
  const record = value as Record<string, unknown>;
  if (!isOutcome(record.outcome) || !isCompleteness(record.completeness)) {
    throw new Error("guided_operation_result_facts_invalid");
  }
  const command = decodeCommandSummary(record.command_execution_summary);
  if (record.command_execution_summary !== undefined && !command) {
    throw new Error("guided_operation_result_facts_invalid");
  }
  return {
    outcome: record.outcome,
    completeness: record.completeness,
    ...(command ? { command_execution_summary: command } : {}),
  };
}

function commandExecutionSummary(
  layers: readonly Record<string, unknown>[],
): GuidedOperationResultStructuralFacts["command_execution_summary"] {
  const layer = layers.find((candidate) =>
    candidate.exit_code === null || typeof candidate.exit_code === "number" ||
    typeof candidate.timed_out === "boolean" ||
    candidate.signal === null || typeof candidate.signal === "string");
  if (!layer) return undefined;
  return {
    exit_status: Number.isSafeInteger(layer.exit_code) ? Number(layer.exit_code) : null,
    timed_out: layer.timed_out === true,
    signal: typeof layer.signal === "string" &&
        layer.signal.length <= MAX_SIGNAL_CHARS
      ? layer.signal
      : null,
  };
}

function decodeCommandSummary(
  value: unknown,
): GuidedOperationResultStructuralFacts["command_execution_summary"] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!(record.exit_status === null || Number.isSafeInteger(record.exit_status)) ||
    typeof record.timed_out !== "boolean" ||
    !(record.signal === null ||
      (typeof record.signal === "string" && record.signal.length <= MAX_SIGNAL_CHARS))) {
    return undefined;
  }
  return {
    exit_status: record.exit_status as number | null,
    timed_out: record.timed_out,
    signal: record.signal as string | null,
  };
}

function resultLayers(value: unknown): Record<string, unknown>[] {
  const layers: Record<string, unknown>[] = [];
  let current = asRecord(value);
  for (let depth = 0; current && depth < 4; depth += 1) {
    layers.push(current);
    current = asRecord(current.result) ?? asRecord(current.output);
  }
  return layers;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isOutcome(
  value: unknown,
): value is GuidedOperationResultStructuralFacts["outcome"] {
  return value === "succeeded" || value === "failed" ||
    value === "cancelled" || value === "unknown";
}

function isCompleteness(
  value: unknown,
): value is GuidedOperationResultStructuralFacts["completeness"] {
  return value === "complete" || value === "incomplete";
}
