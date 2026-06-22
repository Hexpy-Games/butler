import { createToolSearchToolHandler } from "./tool_search/executor.ts";
import { createToolDescribeToolHandler } from "./tool_describe/executor.ts";

type ToolBridgeInput =
  & Parameters<typeof createToolSearchToolHandler>[0]
  & Parameters<typeof createToolDescribeToolHandler>[0];

export function createToolBridgeToolHandlers(input: ToolBridgeInput) {
  return {
    "tool_search": createToolSearchToolHandler(input),
    "tool_describe": createToolDescribeToolHandler(input),
  };
}
