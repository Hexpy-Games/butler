import { expect, test } from "bun:test";
import { runAgentLoop } from
  "../../packages/butler-agent/src/agent/model-tool-loop/index.ts";
import { functionCallContinuationItems } from
  "../../packages/butler-agent/src/integrations/providers/openai/responses.ts";
import {
  normalizeLocalTextToolName,
  responseToAgentModelResponse,
  unavailableFunctionToolPayload,
} from "../../packages/butler-agent/src/integrations/providers/shared/tools.ts";
import { extractHostedChatToolCalls } from
  "../../packages/butler-agent/src/integrations/providers/shared/hosted-chat-client.ts";
import { extractLocalToolCalls } from
  "../../packages/butler-agent/src/integrations/providers/local/tool-call-protocol.ts";

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
    rawArguments: "{\"query\":\"hello\"}",
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

test("non-OpenAI adapters preserve explicit unknown structured tool calls", () => {
  const allowed = new Set(["known_tool"]);
  expect(normalizeLocalTextToolName("native:known_tool", allowed)).toBe("known_tool");
  expect(normalizeLocalTextToolName("hallucinated_tool", allowed))
    .toBe("hallucinated_tool");

  const message = {
    tool_calls: [{
      id: "unknown-call",
      type: "function",
      function: { name: "hallucinated_tool", arguments: "{}" },
    }],
  };
  expect(extractHostedChatToolCalls(message, allowed)[0]?.function.name)
    .toBe("hallucinated_tool");
  expect(extractLocalToolCalls(message, allowed)[0]?.function.name)
    .toBe("hallucinated_tool");
  expect(unavailableFunctionToolPayload({
    name: "hallucinated_tool",
    args: { query: "hello" },
    allowedNames: allowed,
  })).toMatchObject({
    ok: false,
    output: {
      error: { code: "tool_unavailable" },
      observation_kind: "tool_unavailable",
    },
  });
  expect(unavailableFunctionToolPayload({
    name: "known_tool",
    args: {},
    allowedNames: allowed,
  })).toBeNull();
});
