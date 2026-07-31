import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const listMcpCapabilitiesToolDefinition = {
  type: "function",
  name: "list_mcp_capabilities",
  description: "List configured MCP servers and their available tools, resources, and resource templates. Use before calling an external MCP tool or reading an MCP resource.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      include_disabled: {
        type: "boolean",
        description: "Include disabled MCP servers in the listing.",
      },
    },
    required: [],
  },
  effectBoundary: "none",
  concurrencySafe: true,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const listMcpCapabilitiesToolMetadata = {
  category: "mcp",
  tags: [
    "mcp",
    "tools",
    "resources",
    "external",
    "connector",
    "server",
  ],
  safetyNotes: [
    "Discovery only; returns configured MCP tools and resources without executing them.",
  ],
  satisfiesCompletionObligations: [
    "source_verified",
  ],
} satisfies ToolCapabilityMetadata;
