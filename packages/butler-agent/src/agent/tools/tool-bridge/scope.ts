import type { ToolCapabilityMetadata } from "../types.ts";

const ALWAYS_DISCOVERABLE_NATIVE_CATEGORIES = new Set(["search"]);
const BRIDGE_TOOL_NAMES = new Set(["tool_search", "tool_describe", "tool_call"]);

export function currentToolNamesFromInput(
  value: readonly string[] | (() => readonly string[]) | undefined,
): readonly string[] {
  return typeof value === "function" ? value() : value ?? [];
}

export function canBridgeNativeTool(input: {
  toolName: string;
  metadata: ToolCapabilityMetadata;
  currentToolNames?: readonly string[] | (() => readonly string[]);
}): boolean {
  if (BRIDGE_TOOL_NAMES.has(input.toolName)) return false;
  const currentToolNames = new Set(currentToolNamesFromInput(input.currentToolNames));
  if (currentToolNames.has(input.toolName)) return true;
  return ALWAYS_DISCOVERABLE_NATIVE_CATEGORIES.has(input.metadata.category);
}

export function canBridgeMcpTool(input: {
  currentToolNames?: readonly string[] | (() => readonly string[]);
}): boolean {
  const currentToolNames = new Set(currentToolNamesFromInput(input.currentToolNames));
  return currentToolNames.has("call_mcp_tool") || currentToolNames.has("list_mcp_capabilities");
}

export function scopedOutDisabledReason(provider: "native" | "mcp" | "plugin"): string {
  if (provider === "native") return "tool is outside the current session's scoped progressive surface";
  if (provider === "mcp") return "MCP tool calls require the MCP tool profile in the current session";
  return "Plugin invocation requires a registered guarded plugin dispatcher";
}
