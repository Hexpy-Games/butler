import { afterEach, expect, test } from "bun:test";
import {
  runBtccAgentLoop,
  type BtccAgentLoopToolDefinition,
} from "../../packages/butler-agent/src/agent/btcc/agent-loop/index.ts";
import type { ModelRoundPort } from
  "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";
import { runOpenAIModelRound } from
  "../../packages/butler-agent/src/integrations/providers/openai/model-round.ts";
import { normalizeLocalTextToolName } from
  "../../packages/butler-agent/src/integrations/providers/shared/tools.ts";
import { extractHostedChatToolCalls } from
  "../../packages/butler-agent/src/integrations/providers/shared/hosted-chat-client.ts";
import { extractLocalToolCalls } from
  "../../packages/butler-agent/src/integrations/providers/local/tool-call-protocol.ts";

const originalFetch = globalThis.fetch;
const originalOpenAIBaseUrl = process.env.OPENAI_BASE_URL;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalOpenAIBaseUrl === undefined) {
    delete process.env.OPENAI_BASE_URL;
  } else {
    process.env.OPENAI_BASE_URL = originalOpenAIBaseUrl;
  }
});

test("runBtccAgentLoop sends an unknown OpenAI function call to the model as tool_unavailable", async () => {
  process.env.OPENAI_BASE_URL = "https://example.test/v1";
  const requests: Record<string, unknown>[] = [];
  const responses = [
    {
      id: "response-1",
      model: "gpt-5.5",
      output: [{
        type: "function_call",
        call_id: "call-unknown",
        name: "hallucinated_tool",
        arguments: JSON.stringify({ query: "hello" }),
      }],
    },
    {
      id: "response-2",
      model: "gpt-5.5",
      output_text: "I recovered from the unavailable tool.",
      output: [],
    },
  ];
  let responseIndex = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, init: RequestInit | undefined) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const response = responses[responseIndex];
    responseIndex += 1;
    if (!response) throw new Error("scripted_openai_response_exhausted");
    return Response.json(response);
  }) as unknown as typeof fetch;

  const knownTool: BtccAgentLoopToolDefinition = {
    name: "known_tool",
    description: "A tool the model is allowed to call.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  };
  let executeCount = 0;
  const modelRound: ModelRoundPort = {
    runRound: (request) => runOpenAIModelRound(request, {
      authorization: "Bearer test-key",
      mode: "api_key",
    }),
  };

  const result = await runBtccAgentLoop({
    prompt: "Use the available tools.",
    model: "openai/gpt-5.5",
    tools: [knownTool],
    modelRound,
    executeTool: async () => {
      executeCount += 1;
      return { shouldNotRun: true };
    },
  });

  expect(result.finalText).toBe("I recovered from the unavailable tool.");
  expect(executeCount).toBe(0);
  expect(requests).toHaveLength(2);
  const continuationInput = requests[1]?.input as Array<Record<string, unknown>>;
  const toolOutput = continuationInput.find((item) =>
    item.type === "function_call_output"
  );
  expect(toolOutput?.output).toBeString();
  expect(toolOutput?.output).toContain("tool_unavailable");
  expect(toolOutput?.output).toContain("hallucinated_tool");
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
});
