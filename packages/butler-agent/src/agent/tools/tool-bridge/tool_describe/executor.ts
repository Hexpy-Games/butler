import type { WebSearchProvider } from "../../../../integrations/search/provider.ts";
import { describeMcpToolSchema } from "../../../../interfaces/mcp-client/tool-description.ts";
import {
  parseToolCatalogId,
  schemaDigest,
  type ExternalToolCatalogInput,
} from "../../progressive-catalog.ts";
import { BUTLER_TOOLS, TOOL_CAPABILITY_METADATA } from "../../registry.ts";
import { nativeToolAvailability } from "../../tool-availability.ts";
import { disabledExternalToolDescription } from "../external-description.ts";
import { canBridgeMcpTool, nativeBridgeAvailability, scopedOutDisabledReason } from "../scope.ts";

type ToolCall = { args: Record<string, unknown> };
type PluginToolCatalog =
  | readonly ExternalToolCatalogInput[]
  | (() => Promise<readonly ExternalToolCatalogInput[]>);
type PluginToolDescriber = (input: {
  id: string;
  namespace: string;
  name: string;
}) => Promise<ExternalToolCatalogInput | null | undefined>;

export function createToolDescribeToolHandler(input: {
  butlerData: string;
  webSearchProvider?: WebSearchProvider;
  mcpTimeoutMs?: number;
  pluginCatalog?: PluginToolCatalog;
  pluginToolDescriber?: PluginToolDescriber;
  currentToolNames?: readonly string[] | (() => readonly string[]);
  hiddenNativeToolNames?: readonly string[];
}) {
  return async (call: ToolCall) => {
    const ids = parseIds(call.args.ids);
    if (ids.length === 0) {
      return {
        ok: false,
        descriptions: [],
        missing: [],
        error: { code: "invalid_tool_catalog_ids", message: "tool_describe requires at least one catalog id." },
      };
    }
    const descriptions = [];
    const missing = [];
    for (const id of ids) {
      const description = await describeToolId(id, input);
      if (description) descriptions.push(description);
      else missing.push({ id, error: "unknown_tool_catalog_id" });
    }
    return { ok: missing.length === 0, descriptions, missing };
  };
}

async function describeToolId(
  id: string,
  input: {
    butlerData: string;
    webSearchProvider?: WebSearchProvider;
    mcpTimeoutMs?: number;
    pluginCatalog?: PluginToolCatalog;
    pluginToolDescriber?: PluginToolDescriber;
    currentToolNames?: readonly string[] | (() => readonly string[]);
    hiddenNativeToolNames?: readonly string[];
  },
) {
  const parsed = parseToolCatalogId(id);
  if (!parsed) return null;
  if (parsed.provider === "native") return describeNativeTool(id, parsed.name, input);
  if (parsed.provider === "mcp" && parsed.namespace) {
    return await describeMcpTool(id, parsed.namespace, parsed.name, input);
  }
  if (parsed.provider === "plugin" && parsed.namespace) {
    return await describePluginTool(id, parsed.namespace, parsed.name, input);
  }
  return null;
}

function describeNativeTool(
  id: string,
  name: string,
  input: {
    butlerData: string;
    webSearchProvider?: WebSearchProvider;
    currentToolNames?: readonly string[] | (() => readonly string[]);
    hiddenNativeToolNames?: readonly string[];
  },
) {
  if (input.hiddenNativeToolNames?.includes(name)) return null;
  const tool = BUTLER_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return null;
  const metadata = TOOL_CAPABILITY_METADATA[tool.name];
  if (!metadata) return null;
  const bridgeAvailability = nativeBridgeAvailability({
    toolName: tool.name,
    metadata,
    currentToolNames: input.currentToolNames,
  });
  const availability: { enabled: boolean; disabledReason: string | null; recoveryHint?: string | null } =
    bridgeAvailability.enabled
      ? nativeToolAvailability(tool, input)
      : bridgeAvailability;
  const schema = sanitizeSchemaForModel(tool.parameters);
  return {
    id,
    name: tool.name,
    namespace: null,
    provider: "native",
    category: metadata.category,
    enabled: availability.enabled,
    disabled_reason: availability.disabledReason,
    recovery_hint: availability.enabled ? null : availability.recoveryHint,
    safety_notes: metadata.safetyNotes,
    schema,
    schema_digest: schemaDigest(schema),
    call_affordance: availability.enabled
      ? { type: "native_tool", tool_name: tool.name }
      : { type: "disabled", reason: availability.disabledReason },
  };
}

async function describeMcpTool(
  id: string,
  serverId: string,
  toolName: string,
  input: {
    butlerData: string;
    mcpTimeoutMs?: number;
    currentToolNames?: readonly string[] | (() => readonly string[]);
  },
) {
  if (!canBridgeMcpTool(input)) {
    return {
      id,
      name: toolName,
      namespace: serverId,
      provider: "mcp",
      category: "mcp",
      enabled: false,
      disabled_reason: scopedOutDisabledReason("mcp"),
      recovery_hint: "Use a session with the MCP tool profile or choose an enabled native tool from tool_search.",
      safety_notes: ["MCP tools require explicit current-session MCP capability."],
      schema: {},
      schema_digest: schemaDigest({}),
      call_affordance: { type: "disabled", reason: scopedOutDisabledReason("mcp") },
    };
  }
  const tool = await describeMcpToolSchema({
    butlerData: input.butlerData,
    serverId,
    toolName,
    timeoutMs: input.mcpTimeoutMs,
  });
  if (!tool.ok && tool.reason === "tool_not_found") return null;
  if (!tool.ok && tool.reason === "server_not_found") return null;
  if (!tool.ok) {
    const disabledReason = mcpDescribeDisabledReason(tool);
    return {
      id,
      name: toolName,
      namespace: serverId,
      provider: "mcp",
      category: "mcp",
      enabled: false,
      disabled_reason: disabledReason,
      recovery_hint: "Retry tool_describe later, choose another MCP server/tool, or continue with enabled native tools.",
      safety_notes: ["Inspect the MCP schema and user intent before invoking external tools."],
      schema: {},
      schema_digest: schemaDigest({}),
      call_affordance: { type: "disabled", reason: disabledReason },
    };
  }
  const schema = sanitizeSchemaForModel(tool.input_schema);
  return {
    id,
    name: tool.tool_name,
    namespace: tool.server_id,
    provider: "mcp",
    category: "mcp",
    enabled: true,
    disabled_reason: null,
    safety_notes: ["Calls a configured MCP server tool; inspect schema and user intent first."],
    schema,
    schema_digest: schemaDigest(schema),
    call_affordance: { type: "mcp_tool", server_id: tool.server_id, tool_name: tool.tool_name },
  };
}

async function describePluginTool(
  id: string,
  namespace: string,
  name: string,
  input: {
    pluginCatalog?: PluginToolCatalog;
    pluginToolDescriber?: PluginToolDescriber;
  },
) {
  let tool: ExternalToolCatalogInput | null | undefined;
  try {
    tool = await resolvePluginTool(id, namespace, name, input);
  } catch {
    const reason = "Plugin schema unavailable.";
    return disabledExternalToolDescription({
      id,
      name,
      namespace,
      provider: "plugin",
      category: "automation",
      disabledReason: reason,
      safetyNotes: ["Plugin schema loading failed; treat this as recoverable model feedback, not an app failure."],
      recoveryHint: "Retry tool_describe later, choose another catalog result, or continue with enabled native/MCP tools.",
    });
  }
  if (!tool) return null;
  const schema = sanitizeSchemaForModel(tool.schema ?? {});
  const disabledReason = typeof tool.disabledReason === "string" && tool.disabledReason.trim()
    ? tool.disabledReason.trim()
    : scopedOutDisabledReason("plugin");
  return {
    id,
    name: tool.name.trim(),
    namespace,
    provider: "plugin",
    category: tool.category,
    enabled: false,
    disabled_reason: disabledReason,
    recovery_hint: tool.recoveryHint?.trim() ||
      "Choose an enabled native/MCP tool, or retry after a guarded plugin dispatcher is available.",
    safety_notes: ["Plugin tools are external extensions; inspect schema and user intent first."],
    schema,
    schema_digest: schemaDigest(schema),
    call_affordance: { type: "disabled", reason: disabledReason },
  };
}

function mcpDescribeDisabledReason(tool: { reason: string; error: string }): string {
  if (tool.reason === "server_unavailable") return "MCP server unavailable.";
  return tool.error;
}

function resolvePluginTool(
  id: string,
  namespace: string,
  name: string,
  input: {
    pluginCatalog?: PluginToolCatalog;
    pluginToolDescriber?: PluginToolDescriber;
  },
): ExternalToolCatalogInput | Promise<ExternalToolCatalogInput | null | undefined> | null {
  if (input.pluginToolDescriber) return input.pluginToolDescriber({ id, namespace, name });
  if (!Array.isArray(input.pluginCatalog)) return null;
  return input.pluginCatalog.find((candidate) =>
    candidate.provider === "plugin" &&
    candidate.namespace === namespace &&
    candidate.name.trim() === name,
  ) ?? null;
}

function sanitizeSchemaForModel(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeSchemaForModel);
  if (!value || typeof value !== "object") return value;
  const next: Record<string, unknown> = {};
  for (const [key, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveSchemaKey(key)) {
      next[key] = "[redacted]";
      continue;
    }
    next[key] = sanitizeSchemaForModel(rawValue);
  }
  return next;
}

function isSensitiveSchemaKey(key: string): boolean {
  const normalized = key.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/gu, "_");
  return [
    "default",
    "example",
    "examples",
    "const",
    "secret",
    "token",
    "api_key",
    "apikey",
    "password",
    "authorization",
  ].includes(normalized);
}

function parseIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean))];
}
