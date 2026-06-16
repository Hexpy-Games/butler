import { createMcpToolHandlers } from "../shared.ts";

export function createReadMcpResourceToolHandler(input: Parameters<typeof createMcpToolHandlers>[0]) {
  return createMcpToolHandlers(input).read_mcp_resource;
}
