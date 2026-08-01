import { expect, test } from "bun:test";
import { functionToolToAgentTool } from
  "../../packages/butler-agent/src/integrations/providers/shared/tools.ts";

test("provider tool conversion preserves concurrency safety", () => {
  expect(functionToolToAgentTool({
    type: "function",
    name: "web_search",
    description: "Search the web",
    parameters: { type: "object", properties: {} },
    concurrencySafe: true,
  })).toEqual({
    name: "web_search",
    description: "Search the web",
    inputSchema: { type: "object", properties: {} },
    concurrencySafe: true,
  });
});

test("provider tool conversion keeps unspecified concurrency conservative", () => {
  expect(functionToolToAgentTool({
    type: "function",
    name: "replace_work_plan",
    description: "Replace a durable plan",
    parameters: { type: "object", properties: {} },
  }).concurrencySafe).toBeUndefined();
});
