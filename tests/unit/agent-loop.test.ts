import { expect, test } from "bun:test";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  runAgentLoop,
  type AgentLoopToolDefinition,
} from "../../packages/butler-agent/src/agent/turn/agent-loop.ts";
import { readToolEvidenceArtifactSlice } from "../../packages/butler-agent/src/agent/context/tool-evidence-retention.ts";

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

test("agent loop preserves large evidence-bearing tool results for the immediate follow-up", async () => {
  let immediateMessage = "";
  let futureMessage = "";
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
      if (input.iteration === 1) {
        immediateMessage = input.messages.find((message) => message.role === "tool")?.content ?? "";
        return {
          toolCalls: [{
            id: "call-2",
            name: "echo",
            arguments: { message: "small follow-up" },
          }],
        };
      }
      futureMessage = input.messages.find((message) => message.role === "tool")?.content ?? "";
      return { text: "checkpoint received" };
    },
    executeTool: async (call) =>
      call.id === "call-1"
        ? {
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
          }
        : { ok: true, small: true },
  });

  const immediate = JSON.parse(immediateMessage) as Record<string, any>;
  const future = JSON.parse(futureMessage) as Record<string, any>;
  expect(result.finalText).toBe("checkpoint received");
  expect(immediate.output.butler_evidence_checkpoint).toBeUndefined();
  expect(immediate.output.markdown).toContain("Evidence body Evidence body Evidence body");
  expect(future.output.butler_evidence_checkpoint).toBe(true);
  expect(future.output.butler_evidence_packet.schema).toBe("butler.evidence-packet.v1");
  expect(future.output.butler_evidence_packet.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(future.output.butler_evidence_packet.rehydrate).toMatchObject({
    kind: "unpersisted_tool_result",
    tool: "read_tool_evidence_artifact",
  });
  expect(future.output.evidence_receipts[0].id).toBe("receipt-large-source");
  expect(future.output.source_urls).toEqual(["https://example.test/source"]);
  expect(future.output.raw_estimated_tokens).toBeGreaterThan(6_000);
  expect(future.output.estimated_saved_tokens).toBeGreaterThan(5_000);
  expect(futureMessage).not.toContain("Evidence body Evidence body Evidence body");
});

test("agent loop preserves large non-evidence tool results for the immediate follow-up", async () => {
  let immediateMessage = "";
  let futureMessage = "";
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
      if (input.iteration === 1) {
        immediateMessage = input.messages.find((message) => message.role === "tool")?.content ?? "";
        return {
          toolCalls: [{
            id: "call-2",
            name: "echo",
            arguments: { message: "small follow-up" },
          }],
        };
      }
      futureMessage = input.messages.find((message) => message.role === "tool")?.content ?? "";
      return { text: "compact result received" };
    },
    executeTool: async (call) =>
      call.id === "call-1"
        ? {
            ok: true,
            title: "Large command output",
            stdout: [
              "HEAD_START",
              "RAW_MIDDLE_SHOULD_BE_COMPACTED ".repeat(3_200),
              "TAIL_END",
            ].join("\n"),
          }
        : { ok: true, small: true },
  });

  const immediate = JSON.parse(immediateMessage) as Record<string, any>;
  const future = JSON.parse(futureMessage) as Record<string, any>;
  expect(result.finalText).toBe("compact result received");
  expect(immediate.output.butler_tool_result_compacted).toBeUndefined();
  expect(immediate.output.stdout).toContain("RAW_MIDDLE_SHOULD_BE_COMPACTED");
  expect(future.output.butler_tool_result_compacted).toBe(true);
  expect(future.output.butler_evidence_packet.schema).toBe("butler.evidence-packet.v1");
  expect(future.output.butler_evidence_packet.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(future.output.butler_evidence_packet.rehydrate).toMatchObject({
    kind: "unpersisted_tool_result",
    tool: "read_tool_evidence_artifact",
  });
  expect(future.output.tool_name).toBe("echo");
  expect(future.output.title).toBe("Large command output");
  expect(future.output.raw_estimated_tokens).toBeGreaterThan(6_000);
  expect(future.output.estimated_saved_tokens).toBeGreaterThan(4_000);
  expect(future.output.preview).toContain("HEAD_START");
  expect(future.output.preview).toContain("TAIL_END");
  expect(future.output.preview).toContain("compacted tool result for context budget");
  expect(futureMessage.length).toBeLessThan(6_000);
});

test("agent loop can compact large tool results before the immediate follow-up", async () => {
  let immediateMessage = "";
  const result = await runAgentLoop({
    messages: [{ role: "user", content: "inspect a noisy command compactly" }],
    tools,
    compactToolResultsBeforeNextModelCall: true,
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
      immediateMessage = input.messages.find((message) => message.role === "tool")?.content ?? "";
      return { text: "compact immediate result received" };
    },
    executeTool: async () => ({
      ok: true,
      title: "Large immediate command output",
      stdout: [
        "HEAD_START",
        "RAW_MIDDLE_SHOULD_BE_COMPACTED ".repeat(3_200),
        "TAIL_END",
      ].join("\n"),
    }),
  });

  const immediate = JSON.parse(immediateMessage) as Record<string, any>;
  expect(result.finalText).toBe("compact immediate result received");
  expect(immediate.output.butler_tool_result_compacted).toBe(true);
  expect(immediate.output.butler_evidence_packet.schema).toBe("butler.evidence-packet.v1");
  expect(immediate.output.butler_evidence_packet.rehydrate.tool).toBe("read_tool_evidence_artifact");
  expect(immediate.output.title).toBe("Large immediate command output");
  expect(immediate.output.preview).toContain("HEAD_START");
  expect(immediate.output.preview).toContain("TAIL_END");
  expect(immediate.output.raw_estimated_tokens).toBeGreaterThan(6_000);
  expect(immediate.output.estimated_saved_tokens).toBeGreaterThan(4_000);
  expect(immediateMessage.length).toBeLessThan(6_000);
});

test("agent loop stores raw compacted tool evidence in a rehydratable artifact", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-agent-loop-evidence-"));
  try {
    let immediateMessage = "";
    const result = await runAgentLoop({
      messages: [{ role: "user", content: "inspect a noisy command compactly with evidence retention" }],
      tools,
      compactToolResultsBeforeNextModelCall: true,
      evidenceRetention: {
        butlerData: root,
        turnId: "turn-1",
        semanticWorkBlockId: "work-block-1",
        now: new Date("2026-07-09T00:00:00.000Z"),
      },
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
        immediateMessage = input.messages.find((message) => message.role === "tool")?.content ?? "";
        return { text: "artifact packet received" };
      },
      executeTool: async () => ({
        ok: true,
        title: "Large retained command output",
        stdout: [
          "HEAD_START",
          "A".repeat(30_000),
          "RAW_MIDDLE_ONLY_IN_ARTIFACT",
          "B".repeat(30_000),
          "TAIL_END",
        ].join("\n"),
      }),
    });

    const immediate = JSON.parse(immediateMessage) as Record<string, any>;
    const packet = immediate.output.butler_evidence_packet;
    expect(result.finalText).toBe("artifact packet received");
    expect(immediate.output.butler_tool_result_compacted).toBe(true);
    expect(immediateMessage).not.toContain("RAW_MIDDLE_ONLY_IN_ARTIFACT");
    expect(packet).toMatchObject({
      schema: "butler.evidence-packet.v1",
      tool_name: "echo",
      tool_call_id: "call-1",
      turn_id: "turn-1",
      semantic_work_block_id: "work-block-1",
      rehydrate: {
        kind: "tool_evidence_artifact",
        tool: "read_tool_evidence_artifact",
      },
    });
    expect(packet.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(packet.raw_estimated_tokens).toBeGreaterThan(6_000);
    expect(existsSync(packet.rehydrate.path)).toBe(true);

    const artifact = JSON.parse(readFileSync(packet.rehydrate.path, "utf8")) as Record<string, any>;
    expect(artifact.schema).toBe("butler.raw-tool-artifact.v1");
    expect(artifact.id).toBe(packet.artifact_id);
    expect(artifact.serialized_text).toContain("RAW_MIDDLE_ONLY_IN_ARTIFACT");
    expect(artifact.digest).toBe(packet.digest);

    const focused = readToolEvidenceArtifactSlice({
      butlerData: root,
      artifactId: packet.artifact_id,
      offsetLines: 9,
      limitLines: 1,
      maxTokens: 200,
    });
    expect(focused.ok).toBe(true);
    expect(focused.artifact?.id).toBe(packet.artifact_id);
    expect(focused.text?.text).toContain("RAW_MIDDLE_ONLY_IN_ARTIFACT");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
