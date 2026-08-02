import { expect, test } from "bun:test";
import {
  activeFunctionTools,
  functionToolToAgentTool,
  modelFacingFunctionTools,
} from
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

test("provider boundary retains concurrency internally but omits it from the model-visible schema", () => {
  const options = {
    prompt: "search",
    tools: [{
      type: "function" as const,
      name: "web_search",
      description: "Search the web",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
        },
      },
      concurrencySafe: true,
    }],
    executeTool: async () => ({ ok: true }),
  };

  const active = activeFunctionTools(options);
  expect(active[0]?.concurrencySafe).toBe(true);
  expect(functionToolToAgentTool(active[0]!).concurrencySafe).toBe(true);

  const modelFacing = modelFacingFunctionTools(active);
  expect(modelFacing).toEqual([{
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
  expect(modelFacing[0]).not.toHaveProperty("concurrencySafe");
});
