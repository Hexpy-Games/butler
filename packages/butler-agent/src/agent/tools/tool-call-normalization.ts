import { parseToolCatalogId } from "./progressive-catalog.ts";

export type NormalizedGuidedToolCall = {
  name: string;
  args: Record<string, unknown>;
};

export function normalizeGuidedToolCall(input: {
  toolName: string;
  args: Record<string, unknown>;
}): NormalizedGuidedToolCall {
  const nested = toolCallArguments(input.args);
  const target = progressiveTargetToolName(input.args.id);
  if (
    nested && target &&
    (input.toolName === "tool_call" || target === input.toolName)
  ) {
    return { name: target, args: nested };
  }
  return { name: input.toolName, args: input.args };
}

function toolCallArguments(
  args: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const value = args.arguments;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function progressiveTargetToolName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = parseToolCatalogId(value)?.name;
  return name && name !== "tool_call" ? name : undefined;
}
