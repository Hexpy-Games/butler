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
