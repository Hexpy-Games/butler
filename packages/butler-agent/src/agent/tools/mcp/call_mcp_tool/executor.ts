import { createMcpToolHandlers } from "../shared.ts";

export function createCallMcpToolToolHandler(input: Parameters<typeof createMcpToolHandlers>[0]) {
  return createMcpToolHandlers(input).call_mcp_tool;
}
