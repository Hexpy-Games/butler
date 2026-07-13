import {
  callMcpTool,
  listMcpServerCapabilities,
  readMcpResource,
} from "../../../interfaces/mcp-client/client.ts";

type ToolCall = { args: Record<string, unknown>; signal?: AbortSignal };

export function createMcpToolHandlers(input: { butlerData: string }) {
  return {
    "list_mcp_capabilities": async (call: ToolCall) => ({
      ok: true,
      ...await listMcpServerCapabilities({
        butlerData: input.butlerData,
        includeDisabled: call.args.include_disabled === true,
        signal: call.signal,
      }),
    }),
    "call_mcp_tool": async (call: ToolCall) => {
      const serverId = typeof call.args.server_id === "string" ? call.args.server_id.trim() : "";
      const toolName = typeof call.args.tool_name === "string" ? call.args.tool_name.trim() : "";
      if (!serverId) throw new Error("call_mcp_tool requires server_id");
      if (!toolName) throw new Error("call_mcp_tool requires tool_name");
      const mcpArguments = call.args.arguments &&
        typeof call.args.arguments === "object" &&
        !Array.isArray(call.args.arguments)
        ? call.args.arguments as Record<string, unknown>
        : {};
      return {
        ok: true,
        ...await callMcpTool({
          butlerData: input.butlerData,
          serverId,
          toolName,
          args: mcpArguments,
          signal: call.signal,
        }),
      };
    },
    "read_mcp_resource": async (call: ToolCall) => {
      const serverId = typeof call.args.server_id === "string" ? call.args.server_id.trim() : "";
      const uri = typeof call.args.uri === "string" ? call.args.uri.trim() : "";
      if (!serverId) throw new Error("read_mcp_resource requires server_id");
      if (!uri) throw new Error("read_mcp_resource requires uri");
      return {
        ok: true,
        ...await readMcpResource({
          butlerData: input.butlerData,
          serverId,
          uri,
          signal: call.signal,
        }),
      };
    },
  };
}
