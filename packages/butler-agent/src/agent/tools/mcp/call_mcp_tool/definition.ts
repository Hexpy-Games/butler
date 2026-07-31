import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const callMcpToolToolDefinition = {
  type: "function",
  name: "call_mcp_tool",
  description: "Call a tool exposed by a configured, enabled MCP server. Use list_mcp_capabilities first when the server id or tool schema is not already known.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      server_id: {
        type: "string",
        description: "Configured MCP server id.",
      },
      tool_name: {
        type: "string",
        description: "MCP tool name on that server.",
      },
      arguments: {
        type: "object",
        description: "Tool arguments matching the server-provided MCP schema.",
        additionalProperties: true,
      },
    },
    required: [
      "server_id",
      "tool_name",
    ],
  },
  effectBoundary: "dynamic",
  concurrencySafe: false,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const callMcpToolToolMetadata = {
  category: "mcp",
  tags: [
    "mcp",
    "tool",
    "call",
    "external",
    "connector",
    "server",
  ],
  safetyNotes: [
    "Calls a configured MCP server tool; inspect tool schema and user intent first.",
  ],
} satisfies ToolCapabilityMetadata;
