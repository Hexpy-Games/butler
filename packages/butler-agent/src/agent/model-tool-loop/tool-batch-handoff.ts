export const TOOL_BATCH_HANDOFF_SCHEMA = "butler.tool-batch-handoff.v1" as const;

export function toolBatchCompletedHandoffText(): string {
  return JSON.stringify({
    schema_version: TOOL_BATCH_HANDOFF_SCHEMA,
    status: "tool_batch_completed",
  });
}

export function isToolBatchCompletedHandoffText(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return parsed.schema_version === TOOL_BATCH_HANDOFF_SCHEMA &&
      parsed.status === "tool_batch_completed";
  } catch {
    return false;
  }
}
