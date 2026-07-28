import { expect, test } from "bun:test";
import {
  runAgentLoop,
  type AgentLoopToolDefinition,
} from "../../packages/butler-agent/src/agent/turn/agent-loop.ts";

const tools: AgentLoopToolDefinition[] = [{
  name: "echo",
  description: "Echo a message.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      message: { type: "string" },
    },
    required: ["message"],
  },
}];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("agent loop returns text-only model response", async () => {
  const result = await runAgentLoop({
    messages: [{ role: "user", content: "hello" }],
    tools,
    callModel: async () => ({ text: "hi" }),
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

test("agent loop executes model-selected tool call and continues with tool result", async () => {
  const modelInputs: string[] = [];
  const result = await runAgentLoop({
    messages: [{ role: "user", content: "echo hello" }],
    tools,
    callModel: async (input) => {
      modelInputs.push(input.messages.map((message) => `${message.role}:${message.content}`).join("\n"));
      if (input.iteration === 0) {
        return {
          toolCalls: [{
            id: "call-1",
            name: "echo",
            arguments: { message: "hello" },
          }],
        };
      }
      return { text: "echo result received" };
    },
    executeTool: async (call) => ({
      echoed: call.arguments.message,
    }),
  });

  expect(result.finalText).toBe("echo result received");
  expect(result.stoppedByLimit).toBe(false);
  expect(result.events.map((event) => event.type)).toEqual([
    "model_call",
    "model_response",
    "tool_call",
    "tool_result",
    "model_call",
    "model_response",
  ]);
  expect(modelInputs[1]).toContain("tool:");
  expect(modelInputs[1]).toContain("hello");
});

test("agent loop serializes schema validation failures as structured observations", async () => {
  const modelInputs: string[] = [];
  let executed = 0;
  const result = await runAgentLoop({
    messages: [{ role: "user", content: "echo hello" }],
    tools,
    maxIterations: 3,
    callModel: async (input) => {
      modelInputs.push(input.messages.map((message) => `${message.role}:${message.content}`).join("\n"));
      if (input.iteration === 0) {
        return {
          toolCalls: [{
            id: "call-missing",
            name: "echo",
            arguments: {},
          }],
        };
      }
      if (input.iteration === 1) {
        return {
          toolCalls: [{
            id: "call-extra",
            name: "echo",
            arguments: { message: "hello", extra: true },
          }],
        };
      }
      return { text: "I can retry with the schema now." };
    },
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

test("agent loop preserves the exact structured successful result", async () => {
  let observed = "";
  await runAgentLoop({
    messages: [{ role: "user", content: "read exact result" }],
    tools,
    callModel: async (input) => {
      if (input.iteration === 0) return {
        toolCalls: [{ id: "call-exact", name: "echo", arguments: { message: "exact" } }],
      };
      observed = input.messages.find((message) => message.role === "tool")?.content ?? "";
      return { text: "done" };
    },
    executeTool: async () => ({ text: "RAW_EXACT_RESULT", nested: { count: 7 } }),
  });

  expect(JSON.parse(observed)).toEqual({
    ok: true,
    output: { text: "RAW_EXACT_RESULT", nested: { count: 7 } },
  });
  expect(observed).not.toContain("completed-tool-evidence");
  expect(observed).not.toContain("evidence_packet");
});

test("agent loop exposes assistant text before executing selected tools", async () => {
  const order: string[] = [];
  const result = await runAgentLoop({
    messages: [{ role: "user", content: "echo hello" }],
    tools,
    callModel: async (input) => input.iteration === 0
      ? {
          text: "I will run the echo check now.",
          toolCalls: [{
            id: "call-1",
            name: "echo",
            arguments: { message: "hello" },
          }],
        }
      : { text: "echo result received" },
    onAssistantTextBeforeTools: async ({ text, toolCalls }) => {
      order.push(`before:${text}:${toolCalls[0]?.name}`);
    },
    executeTool: async (call) => {
      order.push(`tool:${call.name}`);
      return { echoed: call.arguments.message };
    },
  });

  expect(result.finalText).toBe("echo result received");
  expect(order).toEqual([
    "before:I will run the echo check now.:echo",
    "tool:echo",
  ]);
  expect(result.messages.some((message) =>
    message.role === "assistant" &&
    message.content === "I will run the echo check now.",
  )).toBe(true);
});

test("agent loop defers a seventh tool until the model authors the next decision", async () => {
  const executed: string[] = [];
  const visibleBatches: string[][] = [];
  let capacityResult = "";
  const result = await runAgentLoop({
    messages: [{ role: "user", content: "inspect seven targets in small steps" }],
    tools,
    maxIterations: 3,
    callModel: async (input) => {
      if (input.iteration === 0) {
        return {
          text: "title: 첫 여섯 항목 확인\nsummary: 우선 여섯 항목을 확인합니다.\nrationale: 결과를 본 뒤 남은 항목의 필요성을 판단합니다.\nnext_step: 확인 결과로 다음 작은 단계를 정합니다.",
          toolCalls: Array.from({ length: 7 }, (_, index) => ({
            id: `call-${index + 1}`,
            name: "echo",
            arguments: { message: String(index + 1) },
          })),
        };
      }
      if (input.iteration === 1) {
        capacityResult = input.messages
          .filter((message) => message.role === "tool")
          .at(-1)?.content ?? "";
        return {
          text: "title: 남은 항목 확인\nsummary: 앞선 결과를 바탕으로 마지막 항목을 확인합니다.\nrationale: 누락된 항목을 별도 단계로 검증해야 합니다.\nnext_step: 마지막 결과를 포함해 결론을 작성합니다.",
          toolCalls: [{
            id: "call-7-retry",
            name: "echo",
            arguments: { message: "7" },
          }],
        };
      }
      return { text: "all seven results observed" };
    },
    onAssistantTextBeforeTools: ({ toolCalls }) => {
      visibleBatches.push(toolCalls.map((call) => call.id));
    },
    executeTool: async (call) => {
      executed.push(call.id);
      return { echoed: call.arguments.message };
    },
  });

  expect(result.finalText).toBe("all seven results observed");
  expect(visibleBatches).toEqual([
    ["call-1", "call-2", "call-3", "call-4", "call-5", "call-6"],
    ["call-7-retry"],
  ]);
  expect(executed).toEqual([
    "call-1", "call-2", "call-3", "call-4", "call-5", "call-6", "call-7-retry",
  ]);
  expect(capacityResult).toContain('"observation_kind":"block_capacity"');
  expect(capacityResult).toContain('"executed":false');
});

test("agent loop returns validation errors as tool results", async () => {
  const result = await runAgentLoop({
    messages: [{ role: "user", content: "bad tool args" }],
    tools,
    callModel: async (input) => input.iteration === 0
      ? {
          toolCalls: [{
            id: "call-1",
            name: "echo",
            arguments: {},
          }],
        }
      : { text: "I saw the validation error." },
    executeTool: async () => {
      throw new Error("should not execute invalid tool input");
    },
  });

  const toolEvent = result.events.find((event) => event.type === "tool_result");
  expect(toolEvent?.toolResult?.ok).toBe(false);
  expect(toolEvent?.toolResult?.error).toContain("requires argument");
  expect(result.finalText).toBe("I saw the validation error.");
});

test("agent loop converts thrown tool errors into model-visible tool results", async () => {
  const result = await runAgentLoop({
    messages: [{ role: "user", content: "tool fails" }],
    tools,
    callModel: async (input) => input.iteration === 0
      ? {
          toolCalls: [{
            id: "call-1",
            name: "echo",
            arguments: { message: "hello" },
          }],
        }
      : { text: "The tool failed truthfully." },
    executeTool: async () => {
      throw new Error("boom");
    },
  });

  const toolEvent = result.events.find((event) => event.type === "tool_result");
  expect(toolEvent?.toolResult?.ok).toBe(false);
  expect(toolEvent?.toolResult?.error).toBe("boom");
  expect(result.finalText).toBe("The tool failed truthfully.");
});

test("agent loop runs concurrency-safe tool calls in parallel and preserves result order", async () => {
  const safeTools: AgentLoopToolDefinition[] = [
    { name: "slow", description: "Slow safe tool.", concurrencySafe: true },
    { name: "fast", description: "Fast safe tool.", concurrencySafe: true },
  ];
  let active = 0;
  let maxActive = 0;
  const finished: string[] = [];
  let toolMessageNames: string[] = [];
  const result = await runAgentLoop({
    messages: [{ role: "user", content: "run both" }],
    tools: safeTools,
    callModel: async (input) => {
      if (input.iteration === 0) {
        return {
          toolCalls: [
            { id: "call-slow", name: "slow", arguments: {} },
            { id: "call-fast", name: "fast", arguments: {} },
          ],
        };
      }
      toolMessageNames = input.messages
        .filter((message) => message.role === "tool")
        .map((message) => message.name ?? "");
      return { text: "parallel results received" };
    },
    executeTool: async (call) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(call.name === "slow" ? 30 : 5);
      finished.push(call.name);
      active -= 1;
      return { tool: call.name };
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

test("agent loop keeps mixed concurrency-safe and unsafe tool batches serial", async () => {
  const mixedTools: AgentLoopToolDefinition[] = [
    { name: "safe", description: "Safe tool.", concurrencySafe: true },
    { name: "unsafe", description: "Unsafe tool." },
  ];
  let active = 0;
  let maxActive = 0;
  const order: string[] = [];

  const result = await runAgentLoop({
    messages: [{ role: "user", content: "run mixed tools" }],
    tools: mixedTools,
    callModel: async (input) => input.iteration === 0
      ? {
          toolCalls: [
            { id: "call-safe", name: "safe", arguments: {} },
            { id: "call-unsafe", name: "unsafe", arguments: {} },
          ],
        }
      : { text: "serial results received" },
    executeTool: async (call) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(`start:${call.name}`);
      await delay(5);
      order.push(`finish:${call.name}`);
      active -= 1;
      return { tool: call.name };
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

test("agent loop feeds repeated identical failed tool calls back to the model", async () => {
  let modelCalls = 0;

  const result = await runAgentLoop({
    messages: [{ role: "user", content: "try a failing local action" }],
    tools,
    maxIterations: 8,
    callModel: async (input) => {
      modelCalls += 1;
      if (input.iteration === 3) {
        return { text: "I saw the repeated tool failures and can answer normally." };
      }
      return {
        toolCalls: [{
          id: `call-${input.iteration}`,
          name: "echo",
          arguments: { message: "same" },
        }],
      };
    },
    executeTool: async () => {
      throw new Error("boom");
    },
  });

  expect(modelCalls).toBe(4);
  expect(result.stoppedByLimit).toBe(false);
  expect(result.finalText).toBe("I saw the repeated tool failures and can answer normally.");
  expect(result.finalText).not.toContain("same tool call failed repeatedly");
  expect(result.events.filter((event) => event.type === "tool_result")).toHaveLength(3);
  expect(result.events.map((event) => event.type)).not.toContain("loop_limit");
});

test("agent loop records every completed parallel result before terminal finalization", async () => {
  const safeTools: AgentLoopToolDefinition[] = [
    { name: "terminal", description: "Terminal safe tool.", concurrencySafe: true },
    { name: "other", description: "Other safe tool.", concurrencySafe: true },
  ];

  const result = await runAgentLoop({
    messages: [{ role: "user", content: "run terminal and other" }],
    tools: safeTools,
    callModel: async () => ({
      toolCalls: [
        { id: "call-terminal", name: "terminal", arguments: {} },
        { id: "call-other", name: "other", arguments: {} },
      ],
    }),
    executeTool: async (call) => ({ tool: call.name }),
    finalTextFromToolResult: ({ toolCall }) =>
      toolCall.name === "terminal" ? "Terminal result is enough." : null,
  });

  const toolMessageNames = result.messages
    .filter((message) => message.role === "tool")
    .map((message) => message.name ?? "");
  expect(result.finalText).toBe("Terminal result is enough.");
  expect(toolMessageNames).toEqual(["terminal", "other"]);
  expect(result.events.map((event) => event.type)).toEqual([
    "model_call",
    "model_response",
    "tool_call",
    "tool_call",
    "tool_result",
    "tool_result",
  ]);
});

test("agent loop does not terminalize repeated failed tool calls when error text changes", async () => {
  let attempts = 0;

  const result = await runAgentLoop({
    messages: [{ role: "user", content: "retry same missing file" }],
    tools,
    maxIterations: 8,
    callModel: async (input) => {
      if (input.iteration === 3) {
        return { text: "I can report the changing failures without synthetic stop text." };
      }
      return {
        toolCalls: [{
          id: `call-${input.iteration}`,
          name: "echo",
          arguments: { message: "same path" },
        }],
      };
    },
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
  expect(result.events.map((event) => event.type)).not.toContain("loop_limit");
});

test("agent loop records every repeated parallel failure before continuing", async () => {
  const safeTools: AgentLoopToolDefinition[] = [
    { name: "fail", description: "Failing safe tool.", concurrencySafe: true },
    { name: "other", description: "Other safe tool.", concurrencySafe: true },
  ];

  const result = await runAgentLoop({
    messages: [{ role: "user", content: "retry then run another safe check" }],
    tools: safeTools,
    callModel: async (input) => {
      if (input.iteration === 2) {
        return { text: "Repeated failure observations stayed in context." };
      }
      return {
        toolCalls: input.iteration === 0
          ? [{ id: "call-fail-1", name: "fail", arguments: {} }]
          : [
              { id: "call-fail-2", name: "fail", arguments: {} },
              { id: "call-other", name: "other", arguments: {} },
            ],
      };
    },
    executeTool: async (call) => {
      if (call.name === "fail") throw new Error("still failing");
      return { tool: call.name };
    },
  });

  expect(result.finalText).toBe("Repeated failure observations stayed in context.");
  expect(result.messages
    .filter((message) => message.role === "tool")
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

test("agent loop lets model use successful alternate result after repeated failure observations", async () => {
  const safeTools: AgentLoopToolDefinition[] = [
    { name: "fail", description: "Failing safe tool.", concurrencySafe: true },
    { name: "alternate", description: "Alternate safe tool.", concurrencySafe: true },
  ];
  let modelCalls = 0;

  const result = await runAgentLoop({
    messages: [{ role: "user", content: "try failing primary then alternate" }],
    tools: safeTools,
    callModel: async (input) => {
      modelCalls += 1;
      if (input.iteration === 0) {
        return {
          toolCalls: [{ id: "call-fail-1", name: "fail", arguments: { target: "same" } }],
        };
      }
      if (input.iteration === 1) {
        return {
          toolCalls: [
            { id: "call-fail-2", name: "fail", arguments: { target: "same" } },
            { id: "call-alternate", name: "alternate", arguments: { target: "other" } },
          ],
        };
      }
      return { text: "Used the successful alternate result." };
    },
    executeTool: async (call) => {
      if (call.name === "fail") throw new Error("still failing");
      return { tool: call.name, ok: true };
    },
  });

  expect(modelCalls).toBe(3);
  expect(result.finalText).toBe("Used the successful alternate result.");
});

test("agent loop keeps repeated invalid schema arguments as structured observations", async () => {
  const modelInputs: string[] = [];
  const result = await runAgentLoop({
    messages: [{ role: "user", content: "echo with repaired schema" }],
    tools,
    maxIterations: 5,
    callModel: async (input) => {
      modelInputs.push(input.messages.map((message) => `${message.role}:${message.content}`).join("\n"));
      if (input.iteration < 3) {
        return {
          toolCalls: [{
            id: `call-invalid-${input.iteration}`,
            name: "echo",
            arguments: {},
          }],
        };
      }
      return { text: "I repaired the arguments after the observations." };
    },
    executeTool: async () => {
      throw new Error("invalid calls should not execute");
    },
  });

  expect(result.finalText).toBe("I repaired the arguments after the observations.");
  expect(result.finalText).not.toContain("same tool call failed repeatedly");
  expect(result.events.filter((event) => event.type === "tool_result")).toHaveLength(3);
  expect(modelInputs.slice(1).join("\n")).toContain("\"observation_kind\":\"tool_invalid_arguments\"");
  expect(modelInputs.slice(1).join("\n")).toContain("Tool echo requires argument: message");
});

test("agent loop produces truthful partial response when loop limit is reached", async () => {
  const result = await runAgentLoop({
    messages: [{ role: "user", content: "never finishes" }],
    tools,
    maxIterations: 1,
    callModel: async () => ({
      toolCalls: [{
        id: "call-1",
        name: "echo",
        arguments: { message: "still running" },
      }],
    }),
    executeTool: async () => ({ ok: true }),
  });

  expect(result.stoppedByLimit).toBe(true);
  expect(result.finalText).toContain("available tool budget");
  expect(result.finalText).not.toContain("agent loop");
  expect(result.finalText).toContain("echo: ok");
  expect(result.events.at(-1)?.type).toBe("loop_limit");
});

test("agent loop delegates loop-limit synthesis when caller provides a finalizer", async () => {
  const result = await runAgentLoop({
    messages: [{ role: "user", content: "search then answer" }],
    tools,
    maxIterations: 1,
    callModel: async () => ({
      toolCalls: [{
        id: "call-1",
        name: "echo",
        arguments: { message: "evidence" },
      }],
    }),
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

test("agent loop can stop immediately after a terminal tool result", async () => {
  let modelCalls = 0;
  const result = await runAgentLoop({
    messages: [{ role: "user", content: "publish report" }],
    tools,
    callModel: async () => {
      modelCalls += 1;
      return {
        toolCalls: [{
          id: "call-1",
          name: "echo",
          arguments: { message: "report" },
        }],
      };
    },
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
