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

test("agent loop checkpoints large evidence-bearing tool results for model context", async () => {
  let checkpointMessage = "";
  const result = await runAgentLoop({
    messages: [{ role: "user", content: "read a large source" }],
    tools,
    callModel: async (input) => {
      if (input.iteration === 0) {
        return {
          toolCalls: [{
            id: "call-1",
            name: "echo",
            arguments: { message: "large" },
          }],
        };
      }
      checkpointMessage = input.messages.find((message) => message.role === "tool")?.content ?? "";
      return { text: "checkpoint received" };
    },
    executeTool: async () => ({
      ok: true,
      source_urls: ["https://example.test/source"],
      evidence_receipts: [{
        schema: "butler.evidence-receipt.v1",
        id: "receipt-large-source",
        producer: { kind: "tool", name: "web_read" },
        receiptType: "source",
        verified: true,
        covers: ["source_verified"],
        summary: "Large page evidence was read.",
        references: [{ kind: "url", ref: "https://example.test/source" }],
        satisfies: ["source_verified"],
      }],
      markdown: "Evidence body ".repeat(2_500),
    }),
  });

  const parsed = JSON.parse(checkpointMessage) as Record<string, any>;
  expect(result.finalText).toBe("checkpoint received");
  expect(parsed.output.butler_evidence_checkpoint).toBe(true);
  expect(parsed.output.evidence_receipts[0].id).toBe("receipt-large-source");
  expect(parsed.output.source_urls).toEqual(["https://example.test/source"]);
  expect(parsed.output.raw_estimated_tokens).toBeGreaterThan(6_000);
  expect(parsed.output.estimated_saved_tokens).toBeGreaterThan(5_000);
  expect(checkpointMessage).not.toContain("Evidence body Evidence body Evidence body");
});

test("agent loop compacts large non-evidence tool results for model context", async () => {
  let compactMessage = "";
  const result = await runAgentLoop({
    messages: [{ role: "user", content: "inspect a noisy command" }],
    tools,
    callModel: async (input) => {
      if (input.iteration === 0) {
        return {
          toolCalls: [{
            id: "call-1",
            name: "echo",
            arguments: { message: "large" },
          }],
        };
      }
      compactMessage = input.messages.find((message) => message.role === "tool")?.content ?? "";
      return { text: "compact result received" };
    },
    executeTool: async () => ({
      ok: true,
      title: "Large command output",
      stdout: [
        "HEAD_START",
        "RAW_MIDDLE_SHOULD_BE_COMPACTED ".repeat(3_200),
        "TAIL_END",
      ].join("\n"),
    }),
  });

  const parsed = JSON.parse(compactMessage) as Record<string, any>;
  expect(result.finalText).toBe("compact result received");
  expect(parsed.output.butler_tool_result_compacted).toBe(true);
  expect(parsed.output.tool_name).toBe("echo");
  expect(parsed.output.title).toBe("Large command output");
  expect(parsed.output.raw_estimated_tokens).toBeGreaterThan(6_000);
  expect(parsed.output.estimated_saved_tokens).toBeGreaterThan(4_000);
  expect(parsed.output.preview).toContain("HEAD_START");
  expect(parsed.output.preview).toContain("TAIL_END");
  expect(parsed.output.preview).toContain("compacted tool result for context budget");
  expect(compactMessage.length).toBeLessThan(6_000);
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

test("agent loop stops repeated identical failed tool calls before loop limit", async () => {
  let modelCalls = 0;

  const result = await runAgentLoop({
    messages: [{ role: "user", content: "try a failing local action" }],
    tools,
    maxIterations: 8,
    callModel: async (input) => {
      modelCalls += 1;
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
    onRepeatedToolFailure: ({ failureCount, toolResult }) =>
      `Stopped after ${failureCount} repeated failures: ${toolResult.error}`,
  });

  expect(modelCalls).toBe(2);
  expect(result.stoppedByLimit).toBe(false);
  expect(result.finalText).toBe("Stopped after 2 repeated failures: boom");
  expect(result.events.map((event) => event.type)).toContain("repeated_tool_failure");
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

test("agent loop treats the same failed tool call as repeated even when error text changes", async () => {
  let attempts = 0;

  const result = await runAgentLoop({
    messages: [{ role: "user", content: "retry same missing file" }],
    tools,
    maxIterations: 8,
    callModel: async (input) => ({
      toolCalls: [{
        id: `call-${input.iteration}`,
        name: "echo",
        arguments: { message: "same path" },
      }],
    }),
    executeTool: async () => {
      attempts += 1;
      throw new Error(`ENOENT attempt ${attempts}`);
    },
  });

  expect(attempts).toBe(2);
  expect(result.stoppedByLimit).toBe(false);
  expect(result.finalText).toContain("same tool call failed repeatedly");
  expect(result.finalText).toContain("ENOENT attempt 2");
  expect(result.events.map((event) => event.type)).toContain("repeated_tool_failure");
  expect(result.events.map((event) => event.type)).not.toContain("loop_limit");
});

test("agent loop gives repeated-failure finalizer all completed parallel results", async () => {
  const safeTools: AgentLoopToolDefinition[] = [
    { name: "fail", description: "Failing safe tool.", concurrencySafe: true },
    { name: "other", description: "Other safe tool.", concurrencySafe: true },
  ];
  let callbackToolResults: string[] = [];

  const result = await runAgentLoop({
    messages: [{ role: "user", content: "retry then run another safe check" }],
    tools: safeTools,
    callModel: async (input) => ({
      toolCalls: input.iteration === 0
        ? [{ id: "call-fail-1", name: "fail", arguments: {} }]
        : [
            { id: "call-fail-2", name: "fail", arguments: {} },
            { id: "call-other", name: "other", arguments: {} },
          ],
    }),
    executeTool: async (call) => {
      if (call.name === "fail") throw new Error("still failing");
      return { tool: call.name };
    },
    onRepeatedToolFailure: ({ toolResults }) => {
      callbackToolResults = toolResults.map((toolResult) => toolResult.name);
      return "Repeated failure finalizer saw the completed batch.";
    },
  });

  expect(result.finalText).toBe("Repeated failure finalizer saw the completed batch.");
  expect(callbackToolResults).toEqual(["fail", "fail", "other"]);
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
    "repeated_tool_failure",
  ]);
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
