import type {
  NativeToolAvailabilityOverrides,
  ToolCapabilityMetadata,
} from "../types.ts";
import {
  PROJECT_LEDGER_LIFECYCLE_TOOL_NAMES,
  PROJECT_LEDGER_MUTATION_TOOL_NAME_SET,
} from "../project-ledger/mutation-tools.ts";

const ALWAYS_DISCOVERABLE_NATIVE_CATEGORIES = new Set(["search"]);
const BRIDGE_TOOL_NAMES = new Set(["tool_search", "tool_describe", "tool_call"]);
const PROJECT_LEDGER_LIFECYCLE_TOOL_NAME_SET = new Set<string>(PROJECT_LEDGER_LIFECYCLE_TOOL_NAMES);

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
  return nativeBridgeAvailability(input).enabled;
}

export function nativeBridgeAvailability(input: {
  toolName: string;
  metadata: ToolCapabilityMetadata;
  currentToolNames?: readonly string[] | (() => readonly string[]);
  nativeToolAvailabilityOverrides?: NativeToolAvailabilityOverrides;
}): { enabled: boolean; disabledReason: string | null; recoveryHint: string | null } {
  const availabilityOverride =
    input.nativeToolAvailabilityOverrides?.[input.toolName];
  if (availabilityOverride) {
    return {
      enabled: false,
      disabledReason: availabilityOverride.disabledReason,
      recoveryHint: availabilityOverride.recoveryHint,
    };
  }
  if (BRIDGE_TOOL_NAMES.has(input.toolName)) {
    return {
      enabled: false,
      disabledReason: "Bridge tools cannot be recursively invoked through the bridge.",
      recoveryHint: "Call the visible bridge tool directly.",
    };
  }
  const currentToolNames = new Set(currentToolNamesFromInput(input.currentToolNames));
  if (currentToolNames.has(input.toolName)) {
    return { enabled: true, disabledReason: null, recoveryHint: null };
  }
  if (PROJECT_LEDGER_MUTATION_TOOL_NAME_SET.has(input.toolName)) {
    if ([...currentToolNames].some((toolName) => PROJECT_LEDGER_LIFECYCLE_TOOL_NAME_SET.has(toolName))) {
      return { enabled: true, disabledReason: null, recoveryHint: null };
    }
    return {
      enabled: false,
      disabledReason: "Project Ledger mutation tools require a Ledger-tracked project turn with mutation tools in the current native surface.",
      recoveryHint: "Use or resume a project turn whose runtime policy has tracking_mode=ledger. Do not mutate Project Ledger records through run_command or write_file.",
    };
  }
  if (input.metadata.tags.includes("project-ledger") && currentToolNames.has("project_ledger_status")) {
    return { enabled: true, disabledReason: null, recoveryHint: null };
  }
  if (input.metadata.tags.includes("project-ledger")) {
    return {
      enabled: false,
      disabledReason: "Project Ledger tools are outside the current turn's project tool surface.",
      recoveryHint: "Use a project-scoped turn with Project Ledger tools selected, or continue without Ledger closeout when tracking_mode is local or none.",
    };
  }
  if (ALWAYS_DISCOVERABLE_NATIVE_CATEGORIES.has(input.metadata.category)) {
    return { enabled: true, disabledReason: null, recoveryHint: null };
  }
  return {
    enabled: false,
    disabledReason: scopedOutDisabledReason("native"),
    recoveryHint: "Choose a tool already present in the current native surface, or adjust the structured runtime policy that selects tool profiles.",
  };
}

export function canDiscoverMcpTools(input: {
  currentToolNames?: readonly string[] | (() => readonly string[]);
}): boolean {
  const currentToolNames = new Set(currentToolNamesFromInput(input.currentToolNames));
  return currentToolNames.has("call_mcp_tool") || currentToolNames.has("list_mcp_capabilities");
}

export function mcpBridgeAvailability(input: {
  currentToolNames?: readonly string[] | (() => readonly string[]);
  nativeToolAvailabilityOverrides?: NativeToolAvailabilityOverrides;
}): { enabled: boolean; disabledReason: string | null; recoveryHint: string | null } {
  const availabilityOverride =
    input.nativeToolAvailabilityOverrides?.call_mcp_tool;
  if (availabilityOverride) {
    return {
      enabled: false,
      disabledReason: availabilityOverride.disabledReason,
      recoveryHint: availabilityOverride.recoveryHint,
    };
  }
  const currentToolNames = new Set(currentToolNamesFromInput(input.currentToolNames));
  if (currentToolNames.has("call_mcp_tool")) {
    return { enabled: true, disabledReason: null, recoveryHint: null };
  }
  return {
    enabled: false,
    disabledReason: scopedOutDisabledReason("mcp"),
    recoveryHint: "Use a session with the MCP tool profile or choose an enabled native tool from tool_search.",
  };
}

export function scopedOutDisabledReason(provider: "native" | "mcp" | "plugin"): string {
  if (provider === "native") return "tool is outside the current session's scoped progressive surface";
  if (provider === "mcp") return "MCP tool calls require the MCP tool profile in the current session";
  return "Plugin invocation requires a registered guarded plugin dispatcher";
}
