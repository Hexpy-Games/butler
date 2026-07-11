import type { SessionRole } from "../../../../test-support/harness/contracts.ts";

export function metadataRuntimePolicy(metadata: unknown): Record<string, unknown> {
  const record = metadata && typeof metadata === "object" ? metadata as Record<string, unknown> : {};
  return record.runtimePolicy && typeof record.runtimePolicy === "object"
    ? record.runtimePolicy as Record<string, unknown>
    : {};
}

export function metadataPolicyValue(metadata: unknown, key: string): unknown {
  const record = metadata && typeof metadata === "object" ? metadata as Record<string, unknown> : {};
  const runtimePolicy = metadataRuntimePolicy(metadata);
  return record[key] ?? runtimePolicy[key];
}

export function workerModelRulesFromMetadata(metadata: unknown): Array<{
  id?: string;
  label?: string;
  condition?: string;
  model?: string;
  reasoning_effort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  enabled?: boolean;
}> {
  if (!Array.isArray(metadata)) return [];
  return metadata.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const rule = item as Record<string, unknown>;
    const model = typeof rule.model === "string" ? rule.model.trim() : "";
    if (!model) return [];
    const reasoning = rule.reasoning_effort;
    const reasoningEffort: "none" | "low" | "medium" | "high" | "xhigh" | "max" | undefined =
      reasoning === "none" ||
      reasoning === "low" ||
      reasoning === "medium" ||
      reasoning === "high" ||
      reasoning === "xhigh" ||
      reasoning === "max"
        ? reasoning
        : undefined;
    return [{
      id: typeof rule.id === "string" ? rule.id : undefined,
      label: typeof rule.label === "string" ? rule.label : undefined,
      condition: typeof rule.condition === "string" ? rule.condition : undefined,
      model,
      reasoning_effort: reasoningEffort,
      enabled: rule.enabled === false ? false : true,
    }];
  }).slice(0, 12);
}

export function shouldRunGoalCompletionReview(metadata: unknown, role: SessionRole): boolean {
  const value = metadataPolicyValue(metadata, "completionReview");
  if (value === "disabled" || value === false) return false;
  if (value === "enabled" || value === true) return true;
  return role === "butler" || role === "steward";
}
