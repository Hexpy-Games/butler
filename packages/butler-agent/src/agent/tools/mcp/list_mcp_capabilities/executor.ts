import { createMcpToolHandlers } from "../shared.ts";

export function createListMcpCapabilitiesToolHandler(input: Parameters<typeof createMcpToolHandlers>[0]) {
  return createMcpToolHandlers(input).list_mcp_capabilities;
}
