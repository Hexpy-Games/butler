import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getMcpServer } from "./registry.ts";
import { asRecord, withMcpClient } from "./session.ts";

export type McpToolDescribeFailureReason =
  | "server_not_found"
  | "server_disabled"
  | "server_unavailable"
  | "tool_not_found";

export type McpToolDescribeView =
  | {
    ok: true;
    server_id: string;
    tool_name: string;
    description?: string;
    input_schema: Record<string, unknown>;
  }
  | {
    ok: false;
    server_id: string;
    tool_name: string;
    reason: McpToolDescribeFailureReason;
    error: string;
  };

const MAX_TOOL_PAGES = 8;

export async function describeMcpToolSchema(input: {
  butlerData: string;
  serverId: string;
  toolName: string;
  timeoutMs?: number;
}): Promise<McpToolDescribeView> {
  const server = getMcpServer(input.butlerData, input.serverId);
  const toolName = input.toolName.trim();
  if (!server) {
    return mcpDescribeFailure(input.serverId, toolName, "server_not_found", `MCP server not found: ${input.serverId}`);
  }
  if (!server.enabled) {
    return mcpDescribeFailure(server.id, toolName, "server_disabled", `MCP server is disabled: ${server.id}`);
  }
  try {
    const tool = await withMcpClient(
      server,
      input.timeoutMs,
      async (client) => await findToolSchema(client, toolName),
    );
    if (!tool) {
      return mcpDescribeFailure(server.id, toolName, "tool_not_found", `MCP tool not found: ${server.id}/${toolName}`);
    }
    return {
      ok: true,
      server_id: server.id,
      tool_name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    };
  } catch (error) {
    return mcpDescribeFailure(
      server.id,
      toolName,
      "server_unavailable",
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function findToolSchema(
  client: Client,
  toolName: string,
): Promise<{ name: string; description?: string; input_schema: Record<string, unknown> } | null> {
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
    const result = await client.listTools(cursor ? { cursor } : undefined);
    const tools = Array.isArray(result.tools) ? result.tools : [];
    for (const tool of tools) {
      const name = String((tool as { name?: unknown }).name ?? "");
      if (name !== toolName) continue;
      const description = (tool as { description?: unknown }).description;
      return {
        name,
        description: typeof description === "string" ? description : undefined,
        input_schema: asRecord((tool as { inputSchema?: unknown }).inputSchema) ?? {},
      };
    }
    cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
    if (!cursor) break;
  }
  return null;
}

function mcpDescribeFailure(
  serverId: string,
  toolName: string,
  reason: McpToolDescribeFailureReason,
  error: string,
): McpToolDescribeView {
  return {
    ok: false,
    server_id: serverId,
    tool_name: toolName,
    reason,
    error,
  };
}
