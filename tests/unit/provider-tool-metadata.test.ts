import { expect, test } from "bun:test";
import type { ModelRoundTool } from
  "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";
import { modelFacingFunctionTools } from
  "../../packages/butler-agent/src/integrations/providers/shared/tools.ts";

test("provider model-round tool conversion preserves concurrency safety internally", () => {
  const tool: ModelRoundTool = {
    name: "web_search",
    description: "Search the web",
    parameters: { type: "object", properties: {} },
    concurrencySafe: true,
  };

  expect(tool.concurrencySafe).toBe(true);
  expect(modelFacingFunctionTools([tool])).toEqual([{
    type: "function",
    name: "web_search",
    description: "Search the web",
    parameters: { type: "object", properties: {} },
  }]);
});

test("provider model-round tool conversion keeps unspecified concurrency conservative", () => {
  const tool: ModelRoundTool = {
    name: "replace_work_plan",
    description: "Replace a durable plan",
    parameters: { type: "object", properties: {} },
  };

  expect(tool.concurrencySafe).toBeUndefined();
  expect(modelFacingFunctionTools([tool])[0]).not.toHaveProperty("concurrencySafe");
});

test("provider model-facing schemas omit nested descriptions and concurrency metadata", () => {
  const tool: ModelRoundTool = {
    name: "web_search",
    description: "Search the web",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
      },
    },
    concurrencySafe: true,
  };

  expect(modelFacingFunctionTools([tool])).toEqual([{
    type: "function",
    name: "web_search",
    description: "Search the web",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
    },
  }]);
});
