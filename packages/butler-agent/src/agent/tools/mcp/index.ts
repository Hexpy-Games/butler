import { createListMcpCapabilitiesToolHandler } from "./list_mcp_capabilities/executor.ts";
import { createCallMcpToolToolHandler } from "./call_mcp_tool/executor.ts";
import { createReadMcpResourceToolHandler } from "./read_mcp_resource/executor.ts";

export function createMcpToolHandlers(input: Parameters<typeof createListMcpCapabilitiesToolHandler>[0]) {
  return {
    "list_mcp_capabilities": createListMcpCapabilitiesToolHandler(input),
    "call_mcp_tool": createCallMcpToolToolHandler(input),
    "read_mcp_resource": createReadMcpResourceToolHandler(input),
  };
}
