import { afterEach, expect, test } from "bun:test";
import {
  runBtccAgentLoop,
  type BtccAgentLoopToolDefinition,
} from "../../packages/butler-agent/src/agent/btcc/agent-loop/index.ts";
import type {
  ModelRoundPort,
  ModelRoundRequest,
  ModelRoundResult,
} from "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";
import { getRegisteredProviderAdapterDefinitions } from
  "../../packages/butler-agent/src/integrations/providers/registry.ts";
import { runHostedOpenAICompatibleModelRound } from
  "../../packages/butler-agent/src/integrations/providers/shared/hosted-chat-tool-runtime.ts";
import type { HostedRuntimeConfig } from
  "../../packages/butler-agent/src/integrations/providers/shared/model-routing.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const probeTool: BtccAgentLoopToolDefinition = {
  name: "probe",
  description: "Return evidence for one step.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: { step: { type: "number" } },
    required: ["step"],
  },
  concurrencySafe: true,
};

function scriptedPort(responses: ModelRoundResult[]): {
  port: ModelRoundPort;
  requests: ModelRoundRequest[];
} {
  const requests: ModelRoundRequest[] = [];
  let index = 0;
  return {
    requests,
    port: {
      async runRound(request) {
        requests.push(request);
        const response = responses[index++];
        if (!response) throw new Error("scripted_model_round_exhausted");
        return response;
      },
    },
  };
}

test("BTCC owns tool batches, result handoff, and the next model round", async () => {
  const { port, requests } = scriptedPort([
    {
      text: "I will inspect both steps.",
      toolCalls: [
        { id: "probe-1", name: "probe", arguments: { step: 1 }, rawArguments: '{"step":1}' },
        { id: "probe-2", name: "probe", arguments: { step: 2 }, rawArguments: '{"step":2}' },
      ],
      continuation: { provider: "test", token: "opaque-1" },
      usage: {
        model: "test/model",
        promptTokens: 10,
        cachedTokens: 2,
        totalTokens: 15,
        outputTokens: 5,
      },
    },
    { text: "Both steps are complete.", toolCalls: [] },
  ]);
  const executed: number[] = [];

  const result = await runBtccAgentLoop({
    prompt: "Inspect both steps.",
    model: "test/model",
    tools: [probeTool],
    modelRound: port,
    executeTool: async ({ arguments: args }) => {
      executed.push(Number(args.step));
      return { evidence: `step-${args.step}` };
    },
  });

  expect(result.finalText).toBe("Both steps are complete.");
  expect(executed).toEqual([1, 2]);
  expect(requests).toHaveLength(2);
  expect(requests[1]?.continuation).toEqual({ provider: "test", token: "opaque-1" });
  expect(requests[1]?.messages.filter((message) => message.role === "tool")).toHaveLength(2);
  expect(result.events.filter((event) => event.type === "model_call")).toHaveLength(2);
});

test("BTCC recovers one empty response and presents the observation to the model", async () => {
  const { port, requests } = scriptedPort([
    { toolCalls: [] },
    { text: "Recovered with a useful answer.", toolCalls: [] },
  ]);

  const result = await runBtccAgentLoop({
    prompt: "Answer usefully.",
    model: "test/model",
    tools: [],
    modelRound: port,
    executeTool: async () => null,
  });

  expect(result.finalText).toBe("Recovered with a useful answer.");
  expect(requests[1]?.messages.at(-1)).toMatchObject({
    role: "user",
    content: expect.stringContaining("previous response contained no text or tool call"),
  });
});

test("unknown and invalid tool calls become ordinary model-visible results", async () => {
  const { port, requests } = scriptedPort([
    {
      toolCalls: [
        { id: "unknown-1", name: "not_available", arguments: {}, rawArguments: "{}" },
        { id: "invalid-1", name: "probe", arguments: {}, rawArguments: "{}" },
      ],
    },
    { text: "I recovered from both tool errors.", toolCalls: [] },
  ]);
  let executeCount = 0;

  const result = await runBtccAgentLoop({
    prompt: "Use the available tools.",
    model: "test/model",
    tools: [probeTool],
    modelRound: port,
    executeTool: async () => {
      executeCount += 1;
      return null;
    },
  });

  expect(result.finalText).toBe("I recovered from both tool errors.");
  expect(executeCount).toBe(0);
  const toolMessages = requests[1]?.messages.filter((message) => message.role === "tool") ?? [];
  expect(toolMessages).toHaveLength(2);
  expect(toolMessages.map((message) => message.content).join("\n")).toContain("tool_unavailable");
  expect(toolMessages.map((message) => message.content).join("\n")).toContain("tool_invalid_arguments");
});

test("final candidate review and correction remain inside BTCC", async () => {
  const { port, requests } = scriptedPort([
    { text: "Premature answer", toolCalls: [] },
    { text: "Complete answer", toolCalls: [] },
  ]);
  const reviews: string[] = [];

  const result = await runBtccAgentLoop({
    prompt: "Complete the task.",
    model: "test/model",
    tools: [],
    modelRound: port,
    executeTool: async () => null,
    reviewFinalCandidate: ({ text }) => {
      reviews.push(text);
      return text === "Premature answer"
        ? { status: "continue", observation: "The evidence section is still missing." }
        : { status: "accepted" };
    },
  });

  expect(result.finalText).toBe("Complete answer");
  expect(reviews).toEqual(["Premature answer", "Complete answer"]);
  expect(requests[1]?.messages.at(-1)).toMatchObject({
    role: "user",
    content: "The evidence section is still missing.",
  });
});

test("all registered provider families expose the one-round boundary", () => {
  for (const adapter of getRegisteredProviderAdapterDefinitions()) {
    expect(typeof adapter.runRound, adapter.providerId).toBe("function");
    expect("runFunctionToolPrompt" in adapter, adapter.providerId).toBe(false);
  }
});

test("hosted adapter normalizes one response while preserving usage and provider data", async () => {
  const config: HostedRuntimeConfig = {
    providerId: "zai",
    modelId: "glm-5.2",
    modelRef: "zai/glm-5.2",
    authType: "api_key",
    apiKey: "test-key",
    apiBaseUrl: "https://example.test/v1",
  };
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    return Response.json({
      id: "chat-1",
      model: "glm-5.2-served",
      choices: [{
        message: {
          role: "assistant",
          content: "I need evidence.",
          tool_calls: [{
            id: "call-1",
            type: "function",
            function: { name: "probe", arguments: '{"step":1}' },
          }],
        },
      }],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    });
  }) as unknown as typeof fetch;

  const result = await runHostedOpenAICompatibleModelRound(config, {
    model: config.modelRef,
    messages: [{ role: "user", content: "Inspect step one." }],
    tools: [probeTool],
  });

  expect(requests).toBe(1);
  expect(result.text).toBe("I need evidence.");
  expect(result.toolCalls[0]).toMatchObject({
    id: "call-1",
    name: "probe",
    arguments: { step: 1 },
  });
  expect(result.usage).toMatchObject({
    promptTokens: 12,
    outputTokens: 4,
    totalTokens: 16,
  });
  expect(result.providerIdentity).toEqual({
    provider: "zai",
    configuredModel: "zai/glm-5.2",
    reportedModel: "glm-5.2-served",
  });
  expect(result.assistantMessage?.providerData).toBeDefined();
});
