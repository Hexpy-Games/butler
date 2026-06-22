import { createToolSearchToolHandler } from "./tool_search/executor.ts";

export function createToolBridgeToolHandlers(input: Parameters<typeof createToolSearchToolHandler>[0]) {
  return {
    "tool_search": createToolSearchToolHandler(input),
  };
}
