import {
  listMcpServerCapabilities,
  type McpCapabilityServerView,
} from "../../interfaces/mcp-client/client.ts";
import { buildExternalToolCatalog, type ExternalToolCatalogInput } from "./progressive-catalog.ts";
import type { ToolCatalogEntry } from "./types.ts";

export async function buildMcpToolCatalog(input: {
  butlerData: string;
  includeDisabled?: boolean;
  timeoutMs?: number;
}): Promise<ToolCatalogEntry[]> {
  const capabilities = await listMcpServerCapabilities({
    butlerData: input.butlerData,
    includeDisabled: input.includeDisabled,
    timeoutMs: input.timeoutMs,
  });
  return buildExternalToolCatalog(capabilities.servers.flatMap(mcpServerToolInputs));
}

function mcpServerToolInputs(server: McpCapabilityServerView): ExternalToolCatalogInput[] {
  if (!server.ok) return [];
  return server.tools.map((tool) => ({
    provider: "mcp",
    namespace: server.id,
    name: tool.name,
    category: "mcp",
    description: tool.description ?? `MCP tool ${tool.name} from ${server.display_name}.`,
    tags: [
      "mcp",
      "tool",
      "external",
      "server",
      server.id,
      server.display_name,
    ],
    riskLevel: "high",
    schema: tool.input_schema ?? {},
  }));
}
