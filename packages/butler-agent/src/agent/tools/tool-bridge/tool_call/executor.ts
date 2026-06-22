import type { WebSearchProvider } from "../../../../integrations/search/provider.ts";
import type { ButlerToolCall, ButlerToolHandler } from "../../butler-tools.ts";
import type { ExternalToolCatalogInput } from "../../progressive-catalog.ts";
import { disabledToolRecovery } from "../audit.ts";
import { validateJsonObjectSchema } from "../schema-validation.ts";
import { currentToolNamesFromInput } from "../scope.ts";
import { createToolDescribeToolHandler } from "../tool_describe/executor.ts";

type ToolCall = { args: Record<string, unknown>; rawArguments?: string };
type PluginToolCatalog =
  | readonly ExternalToolCatalogInput[]
  | (() => Promise<readonly ExternalToolCatalogInput[]>);
type PluginToolDescriber = (input: {
  id: string;
  namespace: string;
  name: string;
}) => Promise<ExternalToolCatalogInput | null | undefined>;
export type ToolCallResolveResult =
  | {
    ok: true;
    targetCall: ButlerToolCall;
    bridgeInvocation: Record<string, unknown>;
  }
  | {
    ok: false;
    result: ReturnType<typeof bridgeError>;
  };

type ToolDescription = {
  id: string;
  name: string;
  namespace: string | null;
  provider: string;
  category: string;
  enabled: boolean;
  disabled_reason: string | null;
  schema: unknown;
  call_affordance: Record<string, unknown>;
};

const BRIDGE_TOOL_NAMES = new Set(["tool_search", "tool_describe", "tool_call"]);

export function createToolCallToolHandler(input: {
  butlerData: string;
  webSearchProvider?: WebSearchProvider;
  mcpTimeoutMs?: number;
  pluginCatalog?: PluginToolCatalog;
  pluginToolDescriber?: PluginToolDescriber;
  dispatchTool: ButlerToolHandler;
  currentToolNames?: readonly string[] | (() => readonly string[]);
  describedToolIds?: readonly string[] | (() => readonly string[]);
}) {
  return async (call: ToolCall) => {
    const resolved = await resolveToolCallTarget(call, input);
    if (!resolved.ok) return resolved.result;
    if (call.args.__bridge_resolve_only === true) {
      return resolved;
    }
    try {
      return withBridgeInvocation(
        await input.dispatchTool(resolved.targetCall),
        resolved.bridgeInvocation,
      );
    } catch (error) {
      return bridgeError("underlying_tool_error", errorMessage(error), {
        id: resolved.bridgeInvocation.id,
        recoverable: false,
        next_action: "Treat this as an operational tool failure, not an app failure. Choose another enabled tool, adjust the request if applicable, or continue with available evidence.",
      });
    }
  };
}

export async function resolveToolCallTarget(
  call: ToolCall,
  input: {
    butlerData: string;
    webSearchProvider?: WebSearchProvider;
    mcpTimeoutMs?: number;
    pluginCatalog?: PluginToolCatalog;
    pluginToolDescriber?: PluginToolDescriber;
    currentToolNames?: readonly string[] | (() => readonly string[]);
    describedToolIds?: readonly string[] | (() => readonly string[]);
  },
): Promise<ToolCallResolveResult> {
  const id = stringArg(call.args.id);
  const args = objectArg(call.args.arguments);
  if (!id) return { ok: false, result: bridgeError("invalid_tool_catalog_id", "tool_call requires a non-empty catalog id.") };
  if (!args) return { ok: false, result: bridgeError("invalid_tool_arguments", "tool_call arguments must be an object.") };

  const description = await describeOneTool(createToolDescribeToolHandler(input), id);
  if (!description) {
    return { ok: false, result: bridgeError("unknown_tool_catalog_id", `Unknown tool catalog id: ${id}`, { id }) };
  }
  if (!description.enabled) {
    const recovery = disabledToolRecovery({
      id,
      provider: description.provider,
      category: description.category,
      reason: description.disabled_reason,
    });
    return {
      ok: false,
      result: bridgeError("disabled_tool", recovery.reason, {
        id,
        reason: recovery.reason,
        alternatives: recovery.alternatives,
        next_action: recovery.next_action,
        recovery,
      }),
    };
  }
  if (!isToolCallAllowedByTurnDescription(description, input)) {
    return {
      ok: false,
      result: bridgeError("tool_not_described", `Tool must be described before invocation: ${id}`, {
        id,
        next_action: "Call tool_describe for this exact catalog id, inspect the schema, then retry tool_call with schema-valid arguments.",
      }),
    };
  }

  const validation = validateJsonObjectSchema(args, description.schema);
  if (!validation.ok) {
    return { ok: false, result: bridgeError("invalid_tool_arguments", validation.message, { id, path: validation.path }) };
  }

  const targetCall = describedToolCall(description, args);
  if (!targetCall.ok) return { ok: false, result: targetCall.result };
  return {
    ok: true,
    targetCall: targetCall.call,
    bridgeInvocation: bridgeInvocationMetadata(description),
  };
}

function isToolCallAllowedByTurnDescription(
  description: ToolDescription,
  input: {
    currentToolNames?: readonly string[] | (() => readonly string[]);
    describedToolIds?: readonly string[] | (() => readonly string[]);
  },
): boolean {
  const visibleToolNames = new Set(currentToolNamesFromInput(input.currentToolNames));
  if (visibleToolNames.has(description.name)) return true;
  if (input.describedToolIds === undefined) return true;
  const describedToolIds = new Set(currentToolNamesFromInput(input.describedToolIds));
  return describedToolIds.has(description.id);
}

async function describeOneTool(
  describe: ReturnType<typeof createToolDescribeToolHandler>,
  id: string,
): Promise<ToolDescription | null> {
  const result = await describe({ args: { ids: [id] } }) as {
    ok?: boolean;
    descriptions?: ToolDescription[];
  };
  return result.descriptions?.[0] ?? null;
}

function describedToolCall(
  description: ToolDescription,
  args: Record<string, unknown>,
): { ok: true; call: ButlerToolCall } | { ok: false; result: ReturnType<typeof bridgeError> } {
  const affordance = description.call_affordance;
  if (affordance.type === "native_tool") {
    const toolName = stringArg(affordance.tool_name);
    if (!toolName || BRIDGE_TOOL_NAMES.has(toolName)) {
      return { ok: false, result: bridgeError("forbidden_bridge_target", "Bridge tools cannot recursively invoke bridge tools.") };
    }
    return { ok: true, call: toolCall(toolName, args) };
  }
  if (affordance.type === "mcp_tool") {
    const serverId = stringArg(affordance.server_id);
    const toolName = stringArg(affordance.tool_name);
    if (!serverId || !toolName) {
      return { ok: false, result: bridgeError("invalid_mcp_affordance", "MCP tool affordance is incomplete.") };
    }
    return { ok: true, call: toolCall("call_mcp_tool", {
      server_id: serverId,
      tool_name: toolName,
      arguments: args,
    }) };
  }
  if (affordance.type === "plugin_tool") {
    return { ok: false, result: bridgeError("plugin_invoker_unavailable", "Plugin invocation requires a guarded plugin dispatcher.") };
  }
  return { ok: false, result: bridgeError("unsupported_tool_affordance", "Tool cannot be invoked through tool_call.") };
}

function toolCall(name: string, args: Record<string, unknown>): ButlerToolCall {
  return {
    name,
    args,
    rawArguments: JSON.stringify(args),
  };
}

function bridgeInvocationMetadata(description: ToolDescription) {
  return {
    id: description.id,
    provider: description.provider,
    affordance: description.call_affordance.type,
  };
}

function withBridgeInvocation(result: unknown, bridgeInvocation: Record<string, unknown>) {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return {
      ...result as Record<string, unknown>,
      bridge_invocation: bridgeInvocation,
    };
  }
  return {
    ok: true,
    result,
    bridge_invocation: bridgeInvocation,
  };
}

function bridgeError(
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
) {
  return {
    ok: false,
    error: {
      code,
      message,
      recoverable: true,
      next_action: "Treat this bridge result as recoverable model feedback. Choose another enabled tool or adjust arguments before retrying.",
      ...extra,
    },
  };
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function objectArg(value: unknown): Record<string, unknown> | null {
  return objectRecord(value);
}

function stringArg(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
