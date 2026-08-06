import { expect, test } from "bun:test";
import {
  runBtccAgentLoop,
  type BtccAgentLoopToolDefinition,
} from "../../packages/butler-agent/src/agent/btcc/agent-loop/index.ts";
import type {
  ModelRoundMessage,
  ModelRoundPort,
  ModelRoundRequest,
  ModelRoundResult,
  ModelRoundToolCall,
} from "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";

const echoTool: BtccAgentLoopToolDefinition = {
  name: "echo",
  description: "Echo a message.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      message: { type: "string" },
    },
    required: ["message"],
  },
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function call(
  id: string,
  name: string,
  args: Record<string, unknown>,
): ModelRoundToolCall {
  return {
    id,
    name,
    arguments: args,
    rawArguments: JSON.stringify(args),
  };
}

function response(input: Partial<ModelRoundResult> = {}): ModelRoundResult {
  return {
    toolCalls: [],
    ...input,
  };
}

type ModelRoundStep =
  | ModelRoundResult
  | ((request: ModelRoundRequest, index: number) => ModelRoundResult | Promise<ModelRoundResult>);

function scriptedModelRound(steps: readonly ModelRoundStep[]): {
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
        const step = steps[index];
        index += 1;
        if (!step) throw new Error("scripted_model_round_exhausted");
        return typeof step === "function" ? await step(request, index - 1) : step;
      },
    },
  };
}

function toolMessages(request: ModelRoundRequest | undefined): ModelRoundMessage[] {
  return request?.messages.filter((message) => message.role === "tool") ?? [];
}

test("BTCC returns a text-only model response", async () => {
  const { port } = scriptedModelRound([response({ text: "hi" })]);

  const result = await runBtccAgentLoop({
    prompt: "hello",
    model: "test/model",
    tools: [echoTool],
    modelRound: port,
    executeTool: async () => {
      throw new Error("should not execute");
    },
  });

  expect(result.finalText).toBe("hi");
  expect(result.stoppedByLimit).toBe(false);
  expect(result.events.map((event) => event.type)).toEqual([
    "model_call",
    "model_response",
  ]);
});

test("BTCC does not create an empty-response retry loop", async () => {
  let calls = 0;
  const { port } = scriptedModelRound([
    () => {
      calls += 1;
      return response();
    },
    () => {
      calls += 1;
      return response();
    },
  ]);

  const result = await runBtccAgentLoop({
    prompt: "hello",
    model: "test/model",
    tools: [echoTool],
    maxIterations: 8,
    modelRound: port,
    executeTool: async () => {
      throw new Error("should not execute");
    },
  });

  expect(calls).toBe(2);
  expect(result.finalText).toBe("");
  expect(result.stoppedByLimit).toBe(false);
});

test("BTCC keeps bounded web evidence in the model message and the full result in the event", async () => {
  let providerToolContent = "";
  const webTool: BtccAgentLoopToolDefinition = {
    name: "web_search",
    description: "Search the web.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  };
  const { port } = scriptedModelRound([
    response({
      toolCalls: [call("call-web", "web_search", { query: "current market" })],
    }),
    (request) => {
      providerToolContent = toolMessages(request)[0]?.content ?? "";
      return response({ text: "research complete" });
    },
  ]);

  const result = await runBtccAgentLoop({
    prompt: "research the market",
    model: "test/model",
    tools: [webTool],
    modelRound: port,
    executeTool: async () => ({
      ok: true,
      turn_time_remaining_seconds: 42,
      query: "current market",
      results: [{ raw_duplicate: "RAW_WEB_RESULT_SHOULD_STAY_DURABLE" }],
      public_web_evidence_items: [{
        evidence_item_id: "public-web-market-1",
        source_url: "https://example.com/market",
        source_identity: "example.com",
        published_at: "2026-07-31",
        content_kind: "search_snippet",
        bounded_content: "Market evidence from the source.",
        limitations: ["Search excerpt."],
      }],
      search_warnings: ["One planned search failed."],
      failed_queries: [{ query: "blocked query", error: "challenge" }],
      read_required: true,
      recommended_read_urls: ["https://example.com/market"],
    }),
  });

  const providerPayload = JSON.parse(providerToolContent) as Record<string, any>;
  expect(providerPayload.output).toMatchObject({
    tool_name: "web_search",
    evidence_item_count: 1,
    search_warnings: ["One planned search failed."],
    failed_queries: [{ query: "blocked query", error: "challenge" }],
    read_required: true,
    recommended_read_urls: ["https://example.com/market"],
  });
  expect(providerPayload.output).not.toHaveProperty("turn_time_remaining_seconds");
  expect(providerToolContent).toContain("Market evidence from the source.");
  expect(providerToolContent).not.toContain("RAW_WEB_RESULT_SHOULD_STAY_DURABLE");
  const durableEvent = result.events.find((event) => event.type === "tool_result");
  expect(JSON.stringify(durableEvent?.toolResult?.output))
    .toContain("RAW_WEB_RESULT_SHOULD_STAY_DURABLE");
});

test("BTCC serializes schema validation failures as structured observations", async () => {
  const modelInputs: string[] = [];
  let executed = 0;
  const { port } = scriptedModelRound([
    (request) => {
      modelInputs.push(request.messages.map((message) => `${message.role}:${message.content}`).join("\n"));
      return response({ toolCalls: [call("call-missing", "echo", {})] });
    },
    (request) => {
      modelInputs.push(request.messages.map((message) => `${message.role}:${message.content}`).join("\n"));
      return response({
        toolCalls: [call("call-extra", "echo", { message: "hello", extra: true })],
      });
    },
    (request) => {
      modelInputs.push(request.messages.map((message) => `${message.role}:${message.content}`).join("\n"));
      return response({ text: "I can retry with the schema now." });
    },
  ]);

  const result = await runBtccAgentLoop({
    prompt: "echo hello",
    model: "test/model",
    tools: [echoTool],
    maxIterations: 3,
    modelRound: port,
    executeTool: async () => {
      executed += 1;
      return { ok: true };
    },
  });

  expect(result.finalText).toBe("I can retry with the schema now.");
  expect(executed).toBe(0);
  expect(result.events.filter((event) => event.type === "tool_result")).toHaveLength(2);
  const context = modelInputs.slice(1).join("\n");
  expect(context).toContain("\"observation_kind\":\"tool_invalid_arguments\"");
  expect(context).toContain("Tool echo requires argument: message");
  expect(context).toContain("Tool echo received unsupported argument(s): extra");
  expect(context).toContain("\"model_visible_content\"");
});

test("BTCC rejects JSON Schema type, enum, and array violations as ordinary tool observations", async () => {
  const modelInputs: string[] = [];
  let executed = 0;
  const collectTool: BtccAgentLoopToolDefinition = {
    name: "collect",
    description: "Collect typed values.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["mode", "items"],
      properties: {
        mode: { type: "string", enum: ["brief", "full"] },
        items: {
          type: "array",
          minItems: 2,
          items: { type: "string" },
        },
      },
    },
  };
  const { port } = scriptedModelRound([
    (request) => {
      modelInputs.push(request.messages.map((message) => `${message.role}:${message.content}`).join("\n"));
      return response({
        toolCalls: [call("call-wrong-enum", "collect", { mode: "other", items: ["one", "two"] })],
      });
    },
    (request) => {
      modelInputs.push(request.messages.map((message) => `${message.role}:${message.content}`).join("\n"));
      return response({
        toolCalls: [call("call-short-array", "collect", { mode: "brief", items: ["one"] })],
      });
    },
    (request) => {
      modelInputs.push(request.messages.map((message) => `${message.role}:${message.content}`).join("\n"));
      return response({
        toolCalls: [call("call-wrong-item-type", "collect", { mode: "brief", items: ["one", 2] })],
      });
    },
    (request) => {
      modelInputs.push(request.messages.map((message) => `${message.role}:${message.content}`).join("\n"));
      return response({ text: "I corrected the typed arguments." });
    },
  ]);

  const result = await runBtccAgentLoop({
    prompt: "collect values",
    model: "test/model",
    tools: [collectTool],
    maxIterations: 4,
    modelRound: port,
    executeTool: async () => {
      executed += 1;
      return { ok: true };
    },
  });

  expect(result.finalText).toBe("I corrected the typed arguments.");
  expect(executed).toBe(0);
  expect(result.events.filter((event) => event.type === "tool_result")).toHaveLength(3);
  const context = modelInputs.slice(1).join("\n");
  expect(context).toContain("Invalid enum value at $.mode");
  expect(context).toContain("Expected at least 2 items at $.items");
  expect(context).toContain("Expected string at $.items[1]");
  expect(context).toContain("\"observation_kind\":\"tool_invalid_arguments\"");
});

test("BTCC keeps tool validation feedback after provider compaction", async () => {
  let providerToolContent = "";
  const webTool: BtccAgentLoopToolDefinition = {
    name: "web_search",
    description: "Search the web.",
    parameters: {
      type: "object",
      required: ["query"],
      properties: { query: { type: "string" } },
      additionalProperties: false,
    },
  };
  const { port } = scriptedModelRound([
    response({ toolCalls: [call("call-invalid-web", "web_search", {})] }),
    (request) => {
      providerToolContent = toolMessages(request)[0]?.content ?? "";
      return response({ text: "I can correct the search call." });
    },
  ]);

  const result = await runBtccAgentLoop({
    prompt: "research the market",
    model: "test/model",
    tools: [webTool],
    modelRound: port,
    executeTool: async () => {
      throw new Error("invalid calls should not execute");
    },
  });

  expect(result.finalText).toBe("I can correct the search call.");
  expect(providerToolContent).toContain("Tool web_search requires argument: query");
  expect(providerToolContent).toContain("tool_invalid_arguments");
  expect(providerToolContent).toContain("Use this observation to retry");
});

test("BTCC preserves the exact structured successful result for the next round", async () => {
  let observed = "";
  const { port } = scriptedModelRound([
    response({ toolCalls: [call("call-exact", "echo", { message: "exact" })] }),
    (request) => {
      observed = toolMessages(request)[0]?.content ?? "";
      return response({ text: "done" });
    },
  ]);

  await runBtccAgentLoop({
    prompt: "read exact result",
    model: "test/model",
    tools: [echoTool],
    modelRound: port,
    executeTool: async () => ({ text: "RAW_EXACT_RESULT", nested: { count: 7 } }),
  });

  expect(JSON.parse(observed)).toEqual({
    ok: true,
    output: { text: "RAW_EXACT_RESULT", nested: { count: 7 } },
  });
  expect(observed).not.toContain("completed-tool-evidence");
  expect(observed).not.toContain("evidence_packet");
});

test("BTCC exposes assistant text before executing selected tools", async () => {
  const order: string[] = [];
  const { port } = scriptedModelRound([
    response({
      text: "I will run the echo check now.",
      toolCalls: [call("call-1", "echo", { message: "hello" })],
    }),
    response({ text: "echo result received" }),
  ]);

  const result = await runBtccAgentLoop({
    prompt: "echo hello",
    model: "test/model",
    tools: [echoTool],
    modelRound: port,
    onAssistantTextBeforeTools: async ({ text, toolCalls }) => {
      order.push(`before:${text}:${toolCalls[0]?.name}`);
    },
    executeTool: async (toolCall) => {
      order.push(`tool:${toolCall.name}`);
      return { echoed: toolCall.arguments.message };
    },
  });

  expect(result.finalText).toBe("echo result received");
  expect(order).toEqual([
    "before:I will run the echo check now.:echo",
    "tool:echo",
  ]);
  expect(result.messages.some((message) =>
    message.role === "assistant" && message.content === "I will run the echo check now."
  )).toBe(true);
});

test("BTCC executes a model-selected tool and continues with its result", async () => {
  const executed: string[] = [];
  const { port, requests } = scriptedModelRound([
    response({ toolCalls: [call("call-1", "echo", { message: "hello" })] }),
    response({ text: "echo result received" }),
  ]);

  const result = await runBtccAgentLoop({
    prompt: "echo hello",
    model: "test/model",
    tools: [echoTool],
    modelRound: port,
    executeTool: async (toolCall) => {
      executed.push(toolCall.name);
      return { echoed: toolCall.arguments.message };
    },
  });

  expect(result.finalText).toBe("echo result received");
  expect(executed).toEqual(["echo"]);
  expect(toolMessages(requests[1])).toHaveLength(1);
  expect(result.events.map((event) => event.type)).toEqual([
    "model_call",
    "model_response",
    "tool_call",
    "tool_result",
    "model_call",
    "model_response",
  ]);
});

test("BTCC executes every tool requested in one model response", async () => {
  const executed: string[] = [];
  const visibleBatches: string[][] = [];
  const sevenTools = Array.from({ length: 7 }, (_, index) => ({
    ...echoTool,
    name: `echo_${index + 1}`,
  }));
  const { port } = scriptedModelRound([
    response({
      text: "Inspect all seven requested targets.",
      toolCalls: sevenTools.map((tool, index) =>
        call(`call-${index + 1}`, tool.name, { message: String(index + 1) })),
    }),
    response({ text: "all seven results observed" }),
  ]);

  const result = await runBtccAgentLoop({
    prompt: "inspect seven targets",
    model: "test/model",
    tools: sevenTools,
    modelRound: port,
    onAssistantTextBeforeTools: ({ toolCalls }) => {
      visibleBatches.push(toolCalls.map((toolCall) => toolCall.id));
    },
    executeTool: async (toolCall) => {
      executed.push(toolCall.id);
      return { echoed: toolCall.arguments.message };
    },
  });

  expect(result.finalText).toBe("all seven results observed");
  expect(visibleBatches).toEqual([[
    "call-1",
    "call-2",
    "call-3",
    "call-4",
    "call-5",
    "call-6",
    "call-7",
  ]]);
  expect(executed).toEqual([
    "call-1",
    "call-2",
    "call-3",
    "call-4",
    "call-5",
    "call-6",
    "call-7",
  ]);
});

test("BTCC returns validation errors as model-visible tool results", async () => {
  let observed = "";
  const { port } = scriptedModelRound([
    response({ toolCalls: [call("call-1", "echo", {})] }),
    (request) => {
      observed = toolMessages(request)[0]?.content ?? "";
      return response({ text: "I saw the validation error." });
    },
  ]);

  const result = await runBtccAgentLoop({
    prompt: "bad tool args",
    model: "test/model",
    tools: [echoTool],
    modelRound: port,
    executeTool: async () => {
      throw new Error("should not execute invalid tool input");
    },
  });

  const toolEvent = result.events.find((event) => event.type === "tool_result");
  expect(toolEvent?.toolResult?.ok).toBe(false);
  expect(toolEvent?.toolResult?.error).toContain("requires argument");
  expect(observed).toContain("requires argument");
  expect(result.finalText).toBe("I saw the validation error.");
});

test("BTCC converts thrown tool errors into model-visible tool results", async () => {
  let observed = "";
  const { port } = scriptedModelRound([
    response({ toolCalls: [call("call-1", "echo", { message: "hello" })] }),
    (request) => {
      observed = toolMessages(request)[0]?.content ?? "";
      return response({ text: "The tool failed truthfully." });
    },
  ]);

  const result = await runBtccAgentLoop({
    prompt: "tool fails",
    model: "test/model",
    tools: [echoTool],
    modelRound: port,
    executeTool: async () => {
      throw new Error("boom");
    },
  });

  const toolEvent = result.events.find((event) => event.type === "tool_result");
  expect(toolEvent?.toolResult?.ok).toBe(false);
  expect(toolEvent?.toolResult?.error).toBe("boom");
  expect(observed).toContain('"ok":false');
  expect(observed).toContain("boom");
  expect(result.finalText).toBe("The tool failed truthfully.");
});

test("BTCC runs concurrency-safe tool calls in parallel and preserves result order", async () => {
  const safeTools: BtccAgentLoopToolDefinition[] = [
    { name: "slow", description: "Slow safe tool.", parameters: {}, concurrencySafe: true },
    { name: "fast", description: "Fast safe tool.", parameters: {}, concurrencySafe: true },
  ];
  let active = 0;
  let maxActive = 0;
  const finished: string[] = [];
  let toolMessageNames: string[] = [];
  const { port } = scriptedModelRound([
    response({
      toolCalls: [
        call("call-slow", "slow", {}),
        call("call-fast", "fast", {}),
      ],
    }),
    (request) => {
      toolMessageNames = toolMessages(request).map((message) => message.name ?? "");
      return response({ text: "parallel results received" });
    },
  ]);

  const result = await runBtccAgentLoop({
    prompt: "run both",
    model: "test/model",
    tools: safeTools,
    modelRound: port,
    executeTool: async (toolCall) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(toolCall.name === "slow" ? 30 : 5);
      finished.push(toolCall.name);
      active -= 1;
      return { tool: toolCall.name };
    },
  });

  expect(result.finalText).toBe("parallel results received");
  expect(maxActive).toBe(2);
  expect(finished).toEqual(["fast", "slow"]);
  expect(toolMessageNames).toEqual(["slow", "fast"]);
  expect(result.events.map((event) => event.type)).toEqual([
    "model_call",
    "model_response",
    "tool_call",
    "tool_call",
    "tool_result",
    "tool_result",
    "model_call",
    "model_response",
  ]);
});

test("BTCC keeps mixed concurrency-safe and unsafe tool batches serial", async () => {
  const mixedTools: BtccAgentLoopToolDefinition[] = [
    { name: "safe", description: "Safe tool.", parameters: {}, concurrencySafe: true },
    { name: "unsafe", description: "Unsafe tool.", parameters: {} },
  ];
  let active = 0;
  let maxActive = 0;
  const order: string[] = [];
  const { port } = scriptedModelRound([
    response({
      toolCalls: [call("call-safe", "safe", {}), call("call-unsafe", "unsafe", {})],
    }),
    response({ text: "serial results received" }),
  ]);

  const result = await runBtccAgentLoop({
    prompt: "run mixed tools",
    model: "test/model",
    tools: mixedTools,
    modelRound: port,
    executeTool: async (toolCall) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(`start:${toolCall.name}`);
      await delay(5);
      order.push(`finish:${toolCall.name}`);
      active -= 1;
      return { tool: toolCall.name };
    },
  });

  expect(result.finalText).toBe("serial results received");
  expect(maxActive).toBe(1);
  expect(order).toEqual([
    "start:safe",
    "finish:safe",
    "start:unsafe",
    "finish:unsafe",
  ]);
});

test("BTCC feeds repeated identical failed tool calls back to the model", async () => {
  let modelCalls = 0;
  const { port } = scriptedModelRound([
    (request, index) => {
      modelCalls += 1;
      return index === 3
        ? response({ text: "I saw the repeated tool failures and can answer normally." })
        : response({ toolCalls: [call(`call-${index}`, "echo", { message: "same" })] });
    },
    (request, index) => {
      modelCalls += 1;
      return index === 3
        ? response({ text: "I saw the repeated tool failures and can answer normally." })
        : response({ toolCalls: [call(`call-${index}`, "echo", { message: "same" })] });
    },
    (request, index) => {
      modelCalls += 1;
      return index === 3
        ? response({ text: "I saw the repeated tool failures and can answer normally." })
        : response({ toolCalls: [call(`call-${index}`, "echo", { message: "same" })] });
    },
    (request, index) => {
      modelCalls += 1;
      return index === 3
        ? response({ text: "I saw the repeated tool failures and can answer normally." })
        : response({ toolCalls: [call(`call-${index}`, "echo", { message: "same" })] });
    },
  ]);

  const result = await runBtccAgentLoop({
    prompt: "try a failing local action",
    model: "test/model",
    tools: [echoTool],
    maxIterations: 8,
    modelRound: port,
    executeTool: async () => {
      throw new Error("boom");
    },
  });

  expect(modelCalls).toBe(4);
  expect(result.stoppedByLimit).toBe(false);
  expect(result.finalText).toBe("I saw the repeated tool failures and can answer normally.");
  expect(result.finalText).not.toContain("same tool call failed repeatedly");
  expect(result.events.filter((event) => event.type === "tool_result")).toHaveLength(3);
  expect(result.events.map((event) => event.type)).not.toContain("execution_window_boundary");
});

test("BTCC records every completed parallel result before terminal finalization", async () => {
  const safeTools: BtccAgentLoopToolDefinition[] = [
    { name: "terminal", description: "Terminal safe tool.", parameters: {}, concurrencySafe: true },
    { name: "other", description: "Other safe tool.", parameters: {}, concurrencySafe: true },
  ];
  const { port } = scriptedModelRound([response({
    toolCalls: [call("call-terminal", "terminal", {}), call("call-other", "other", {})],
  })]);

  const result = await runBtccAgentLoop({
    prompt: "run terminal and other",
    model: "test/model",
    tools: safeTools,
    modelRound: port,
    executeTool: async (toolCall) => ({ tool: toolCall.name }),
    finalTextFromToolResult: ({ toolCall }) =>
      toolCall.name === "terminal" ? "Terminal result is enough." : null,
  });

  expect(result.finalText).toBe("Terminal result is enough.");
  expect(result.messages.filter((message) => message.role === "tool")
    .map((message) => message.name ?? "")).toEqual(["terminal", "other"]);
  expect(result.events.map((event) => event.type)).toEqual([
    "model_call",
    "model_response",
    "tool_call",
    "tool_call",
    "tool_result",
    "tool_result",
  ]);
});

test("BTCC does not terminalize repeated failed tool calls when error text changes", async () => {
  let attempts = 0;
  const { port } = scriptedModelRound([
    (request, index) => index === 3
      ? response({ text: "I can report the changing failures without synthetic stop text." })
      : response({ toolCalls: [call(`call-${index}`, "echo", { message: "same path" })] }),
    (request, index) => index === 3
      ? response({ text: "I can report the changing failures without synthetic stop text." })
      : response({ toolCalls: [call(`call-${index}`, "echo", { message: "same path" })] }),
    (request, index) => index === 3
      ? response({ text: "I can report the changing failures without synthetic stop text." })
      : response({ toolCalls: [call(`call-${index}`, "echo", { message: "same path" })] }),
    (request, index) => index === 3
      ? response({ text: "I can report the changing failures without synthetic stop text." })
      : response({ toolCalls: [call(`call-${index}`, "echo", { message: "same path" })] }),
  ]);

  const result = await runBtccAgentLoop({
    prompt: "retry same missing file",
    model: "test/model",
    tools: [echoTool],
    maxIterations: 8,
    modelRound: port,
    executeTool: async () => {
      attempts += 1;
      throw new Error(`ENOENT attempt ${attempts}`);
    },
  });

  expect(attempts).toBe(3);
  expect(result.stoppedByLimit).toBe(false);
  expect(result.finalText).toBe("I can report the changing failures without synthetic stop text.");
  expect(result.finalText).not.toContain("same tool call failed repeatedly");
  expect(result.events.filter((event) => event.type === "tool_result")).toHaveLength(3);
  expect(result.events.map((event) => event.type)).not.toContain("execution_window_boundary");
});

test("BTCC records every repeated parallel failure before continuing", async () => {
  const safeTools: BtccAgentLoopToolDefinition[] = [
    { name: "fail", description: "Failing safe tool.", parameters: {}, concurrencySafe: true },
    { name: "other", description: "Other safe tool.", parameters: {}, concurrencySafe: true },
  ];
  const { port } = scriptedModelRound([
    response({ toolCalls: [call("call-fail-1", "fail", {})] }),
    response({
      toolCalls: [call("call-fail-2", "fail", {}), call("call-other", "other", {})],
    }),
    response({ text: "Repeated failure observations stayed in context." }),
  ]);

  const result = await runBtccAgentLoop({
    prompt: "retry then run another safe check",
    model: "test/model",
    tools: safeTools,
    modelRound: port,
    executeTool: async (toolCall) => {
      if (toolCall.name === "fail") throw new Error("still failing");
      return { tool: toolCall.name };
    },
  });

  expect(result.finalText).toBe("Repeated failure observations stayed in context.");
  expect(result.messages.filter((message) => message.role === "tool")
    .map((message) => message.name ?? "")).toEqual(["fail", "fail", "other"]);
  expect(result.events.map((event) => event.type)).toEqual([
    "model_call",
    "model_response",
    "tool_call",
    "tool_result",
    "model_call",
    "model_response",
    "tool_call",
    "tool_call",
    "tool_result",
    "tool_result",
    "model_call",
    "model_response",
  ]);
});

test("BTCC lets the model use a successful alternate result after repeated failures", async () => {
  const safeTools: BtccAgentLoopToolDefinition[] = [
    { name: "fail", description: "Failing safe tool.", parameters: {}, concurrencySafe: true },
    { name: "alternate", description: "Alternate safe tool.", parameters: {}, concurrencySafe: true },
  ];
  let modelCalls = 0;
  const { port } = scriptedModelRound([
    () => {
      modelCalls += 1;
      return response({ toolCalls: [call("call-fail-1", "fail", { target: "same" })] });
    },
    () => {
      modelCalls += 1;
      return response({
        toolCalls: [
          call("call-fail-2", "fail", { target: "same" }),
          call("call-alternate", "alternate", { target: "other" }),
        ],
      });
    },
    () => {
      modelCalls += 1;
      return response({ text: "Used the successful alternate result." });
    },
  ]);

  const result = await runBtccAgentLoop({
    prompt: "try failing primary then alternate",
    model: "test/model",
    tools: safeTools,
    modelRound: port,
    executeTool: async (toolCall) => {
      if (toolCall.name === "fail") throw new Error("still failing");
      return { tool: toolCall.name, ok: true };
    },
  });

  expect(modelCalls).toBe(3);
  expect(result.finalText).toBe("Used the successful alternate result.");
});

test("BTCC keeps repeated invalid schema arguments as structured observations", async () => {
  const modelInputs: string[] = [];
  const { port } = scriptedModelRound([
    (request, index) => {
      modelInputs.push(request.messages.map((message) => `${message.role}:${message.content}`).join("\n"));
      return index < 3
        ? response({ toolCalls: [call(`call-invalid-${index}`, "echo", {})] })
        : response({ text: "I repaired the arguments after the observations." });
    },
    (request, index) => {
      modelInputs.push(request.messages.map((message) => `${message.role}:${message.content}`).join("\n"));
      return index < 3
        ? response({ toolCalls: [call(`call-invalid-${index}`, "echo", {})] })
        : response({ text: "I repaired the arguments after the observations." });
    },
    (request, index) => {
      modelInputs.push(request.messages.map((message) => `${message.role}:${message.content}`).join("\n"));
      return index < 3
        ? response({ toolCalls: [call(`call-invalid-${index}`, "echo", {})] })
        : response({ text: "I repaired the arguments after the observations." });
    },
    (request, index) => {
      modelInputs.push(request.messages.map((message) => `${message.role}:${message.content}`).join("\n"));
      return index < 3
        ? response({ toolCalls: [call(`call-invalid-${index}`, "echo", {})] })
        : response({ text: "I repaired the arguments after the observations." });
    },
  ]);

  const result = await runBtccAgentLoop({
    prompt: "echo with repaired schema",
    model: "test/model",
    tools: [echoTool],
    maxIterations: 5,
    modelRound: port,
    executeTool: async () => {
      throw new Error("invalid calls should not execute");
    },
  });

  expect(result.finalText).toBe("I repaired the arguments after the observations.");
  expect(result.finalText).not.toContain("same tool call failed repeatedly");
  expect(result.events.filter((event) => event.type === "tool_result")).toHaveLength(3);
  const context = modelInputs.slice(1).join("\n");
  expect(context).toContain("\"observation_kind\":\"tool_invalid_arguments\"");
  expect(context).toContain("Tool echo requires argument: message");
});

test("BTCC produces a truthful partial response when the loop limit is reached", async () => {
  const { port } = scriptedModelRound([response({
    toolCalls: [call("call-1", "echo", { message: "still running" })],
  })]);

  const result = await runBtccAgentLoop({
    prompt: "never finishes",
    model: "test/model",
    tools: [echoTool],
    maxIterations: 1,
    modelRound: port,
    executeTool: async () => ({ ok: true }),
  });

  expect(result.stoppedByLimit).toBe(true);
  expect(result.finalText).toContain("available tool budget");
  expect(result.finalText).not.toContain("agent loop");
  expect(result.finalText).toContain("echo: ok");
  expect(result.events.at(-1)?.type).toBe("execution_window_boundary");
});

test("BTCC continues through multiple execution windows in the same loop", async () => {
  const requests: ModelRoundRequest[] = [];
  const { port } = scriptedModelRound([
    (request) => {
      requests.push(request);
      return response({
        toolCalls: [call("window-call-1", "echo", { message: "first" })],
      });
    },
    (request) => {
      requests.push(request);
      return response({
        toolCalls: [call("window-call-2", "echo", { message: "second" })],
      });
    },
    (request) => {
      requests.push(request);
      return response({ text: "one final answer" });
    },
  ]);
  const boundaries: number[] = [];

  const result = await runBtccAgentLoop({
    prompt: "finish this request",
    model: "test/model",
    tools: [echoTool],
    maxIterations: 1,
    modelRound: port,
    executeTool: async (toolCall) => ({ message: toolCall.arguments.message }),
    onExecutionWindowBoundary: ({ windowIndex }) => {
      boundaries.push(windowIndex);
      return `Execution checkpoint ${windowIndex + 1}. Use the existing evidence.`;
    },
  });

  expect(result.finalText).toBe("one final answer");
  expect(result.stoppedByLimit).toBe(false);
  expect(requests).toHaveLength(3);
  expect(boundaries).toEqual([0, 1]);
  expect(result.events.filter((event) => event.type === "execution_window_boundary"))
    .toHaveLength(2);
  expect(requests[0]?.messages.filter((message) => message.role === "user"))
    .toHaveLength(1);
  expect(requests[1]?.messages.filter((message) => message.role === "user"))
    .toHaveLength(2);
  expect(requests[2]?.messages.filter((message) => message.role === "user"))
    .toHaveLength(3);
});

test("BTCC carries an empty window response into the next execution window", async () => {
  const { port, requests } = scriptedModelRound([
    response(),
    response({ text: "completed after the empty window" }),
  ]);
  const boundaries: number[] = [];

  const result = await runBtccAgentLoop({
    prompt: "recover from an empty window",
    model: "test/model",
    tools: [echoTool],
    maxIterations: 1,
    modelRound: port,
    executeTool: async () => ({ ok: true }),
    onExecutionWindowBoundary: ({ windowIndex }) => {
      boundaries.push(windowIndex);
      return "Execution checkpoint: preserve the existing evidence.";
    },
  });

  expect(result.finalText).toBe("completed after the empty window");
  expect(result.stoppedByLimit).toBe(false);
  expect(requests).toHaveLength(2);
  expect(boundaries).toEqual([0]);
  expect(requests[1]?.messages.at(-1)).toMatchObject({
    role: "user",
    content: "Execution checkpoint: preserve the existing evidence.",
  });
});

test("BTCC continues after an empty response in a later execution window", async () => {
  const { port } = scriptedModelRound([
    response(),
    response({ toolCalls: [call("empty-window-tool", "echo", { message: "evidence" })] }),
    response(),
    response({ text: "completed after persistent empty responses" }),
  ]);
  let boundaries = 0;

  const result = await runBtccAgentLoop({
    prompt: "preserve the same Turn through empty responses",
    model: "test/model",
    tools: [echoTool],
    maxIterations: 2,
    modelRound: port,
    executeTool: async () => ({ ok: true }),
    onExecutionWindowBoundary: () => {
      boundaries += 1;
      return "Execution checkpoint: preserve the existing evidence.";
    },
  });

  expect(result.finalText).toBe("completed after persistent empty responses");
  expect(result.stoppedByLimit).toBe(false);
  expect(boundaries).toBe(2);
});

test("BTCC treats a two-iteration window as non-terminal", async () => {
  let modelCalls = 0;
  let boundaries = 0;
  const { port } = scriptedModelRound([
    response({ toolCalls: [call("window-two-1", "echo", { message: "one" })] }),
    response({ toolCalls: [call("window-two-2", "echo", { message: "two" })] }),
    response({ toolCalls: [call("window-two-3", "echo", { message: "three" })] }),
    response({ text: "finished after the second window" }),
  ]);

  const result = await runBtccAgentLoop({
    prompt: "cross a two-round window",
    model: "test/model",
    tools: [echoTool],
    maxIterations: 2,
    modelRound: {
      async runRound(request) {
        modelCalls += 1;
        return port.runRound(request);
      },
    },
    executeTool: async () => ({ ok: true }),
    onExecutionWindowBoundary: () => {
      boundaries += 1;
      return "Execution checkpoint: preserve the existing evidence.";
    },
  });

  expect(modelCalls).toBe(4);
  expect(boundaries).toBe(1);
  expect(result.finalText).toBe("finished after the second window");
  expect(result.stoppedByLimit).toBe(false);
});

test("BTCC does not derive an execution window from an exhausted usage attribution", async () => {
  let modelCalls = 0;
  const { port } = scriptedModelRound([
    () => {
      modelCalls += 1;
      return response({ toolCalls: [call("budget-window-1", "echo", { message: "one" })] });
    },
    () => {
      modelCalls += 1;
      return response({ text: "completed after the usage observation" });
    },
  ]);

  const result = await runBtccAgentLoop({
    prompt: "do not stop at the attribution counter",
    model: "test/model",
    tools: [echoTool],
    maxIterations: 1,
    usageAttribution: {
      turnId: "usage-window-turn",
      budgetState: {
        status: "exhausted",
        requestCount: 330,
        maxRequests: 330,
      },
    },
    modelRound: port,
    executeTool: async () => ({ ok: true }),
    onExecutionWindowBoundary: () => "Use the existing evidence from the previous window.",
  });

  expect(modelCalls).toBe(2);
  expect(result.finalText).toBe("completed after the usage observation");
  expect(result.stoppedByLimit).toBe(false);
});

test("BTCC aborts between execution windows without starting another model round", async () => {
  const controller = new AbortController();
  const stopped = new Error("user stopped the Turn");
  let modelCalls = 0;
  const { port } = scriptedModelRound([
    () => {
      modelCalls += 1;
      return response({
        toolCalls: [call("abort-window-1", "echo", { message: "stop" })],
      });
    },
  ]);

  const running = runBtccAgentLoop({
    prompt: "stop between windows",
    model: "test/model",
    tools: [echoTool],
    maxIterations: 1,
    signal: controller.signal,
    modelRound: port,
    executeTool: async () => ({ ok: true }),
    onExecutionWindowBoundary: () => {
      controller.abort(stopped);
      return "This observation must not start another model round.";
    },
  });

  await expect(running).rejects.toThrow("user stopped the Turn");
  expect(modelCalls).toBe(1);
});

test("BTCC delegates loop-limit synthesis when a finalizer is provided", async () => {
  const { port } = scriptedModelRound([response({
    toolCalls: [call("call-1", "echo", { message: "evidence" })],
  })]);

  const result = await runBtccAgentLoop({
    prompt: "search then answer",
    model: "test/model",
    tools: [echoTool],
    maxIterations: 1,
    modelRound: port,
    executeTool: async () => ({ evidence: "usable" }),
    onLoopLimit: async ({ toolResults }) => `Final answer from ${toolResults[0]?.name}.`,
  });

  expect(result.stoppedByLimit).toBe(true);
  expect(result.finalText).toBe("Final answer from echo.");
  expect(result.finalText).not.toContain("available tool budget");
  expect(result.messages.at(-1)).toMatchObject({
    role: "assistant",
    content: "Final answer from echo.",
  });
});

test("BTCC can stop immediately after a terminal tool result", async () => {
  let modelCalls = 0;
  const { port } = scriptedModelRound([
    () => {
      modelCalls += 1;
      return response({ toolCalls: [call("call-1", "echo", { message: "report" })] });
    },
  ]);

  const result = await runBtccAgentLoop({
    prompt: "publish report",
    model: "test/model",
    tools: [echoTool],
    modelRound: port,
    executeTool: async () => ({ report: "Published report." }),
    finalTextFromToolResult: ({ toolResult }) => {
      const output = toolResult.output as { report?: string };
      return output.report ?? null;
    },
  });

  expect(modelCalls).toBe(1);
  expect(result.stoppedByLimit).toBe(false);
  expect(result.finalText).toBe("Published report.");
  expect(result.events.map((event) => event.type)).toEqual([
    "model_call",
    "model_response",
    "tool_call",
    "tool_result",
  ]);
});
