import { createToolSearchToolHandler } from "./tool_search/executor.ts";
import { createToolDescribeToolHandler } from "./tool_describe/executor.ts";
import { createToolCallToolHandler } from "./tool_call/executor.ts";

type ToolBridgeInput =
  & Parameters<typeof createToolSearchToolHandler>[0]
  & Parameters<typeof createToolDescribeToolHandler>[0]
  & Parameters<typeof createToolCallToolHandler>[0];

export function createToolBridgeToolHandlers(input: ToolBridgeInput) {
  return {
    "tool_search": createToolSearchToolHandler(input),
    "tool_describe": createToolDescribeToolHandler(input),
    "tool_call": createToolCallToolHandler(input),
  };
}
