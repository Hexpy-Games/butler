import { expect, test } from "bun:test";
import { runAgentLoop } from
  "../../packages/butler-agent/src/agent/model-tool-loop/index.ts";
import { functionCallContinuationItems } from
  "../../packages/butler-agent/src/integrations/providers/openai/responses.ts";
import { responseToAgentModelResponse } from
  "../../packages/butler-agent/src/integrations/providers/shared/tools.ts";

test("OpenAI unknown function calls remain visible to the loop as a correctable tool error", async () => {
  const response = {
    id: "response-1",
    output: [{
      type: "function_call",
      call_id: "call-unknown",
      name: "hallucinated_tool",
      arguments: JSON.stringify({ query: "hello" }),
    }],
  } as never;

  expect(functionCallContinuationItems(response)).toEqual([{
    type: "function_call",
    call_id: "call-unknown",
    name: "hallucinated_tool",
    arguments: JSON.stringify({ query: "hello" }),
  }]);
  const mapped = responseToAgentModelResponse(response, new Set(["known_tool"]));
  expect(mapped.toolCalls).toEqual([{
    id: "call-unknown",
    name: "hallucinated_tool",
    arguments: { query: "hello" },
  }]);

  let modelCalls = 0;
  let executorCalls = 0;
  const result = await runAgentLoop({
    messages: [{ role: "user", content: "hello" }],
    tools: [{
      name: "known_tool",
      description: "Known tool",
      inputSchema: { type: "object", properties: {} },
    }],
    async callModel({ messages }) {
      modelCalls += 1;
      if (modelCalls === 1) return mapped;
      expect(messages.at(-1)?.content).toContain("tool_unavailable");
      return { text: "I corrected the tool choice and can still answer." };
    },
    async executeTool() {
      executorCalls += 1;
      return { unreachable: true };
    },
  });

  expect(executorCalls).toBe(0);
  expect(modelCalls).toBe(2);
  expect(result.finalText).toBe("I corrected the tool choice and can still answer.");
});
