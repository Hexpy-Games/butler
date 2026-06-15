import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../types.ts";

export const readMcpResourceToolDefinition = {
  type: "function",
  name: "read_mcp_resource",
  description: "Read a resource URI exposed by a configured, enabled MCP server. Use list_mcp_capabilities first when the resource URI is not already known.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      server_id: {
        type: "string",
        description: "Configured MCP server id.",
      },
      uri: {
        type: "string",
        description: "Resource URI to read.",
      },
    },
    required: [
      "server_id",
      "uri",
    ],
  },
  concurrencySafe: true,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const readMcpResourceToolMetadata = {
  category: "mcp",
  tags: [
    "mcp",
    "resource",
    "read",
    "external",
    "connector",
    "server",
  ],
  safetyNotes: [
    "Reads a configured MCP resource URI through the selected server.",
  ],
  satisfiesCompletionObligations: [
    "source_verified",
  ],
} satisfies ToolCapabilityMetadata;
