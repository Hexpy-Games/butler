import { expect, test } from "bun:test";
import {
  runBtccAgentLoop,
  type BtccAgentLoopToolDefinition,
} from "../../packages/butler-agent/src/agent/btcc/agent-loop/index.ts";
import {
  createFailureRepetitionTracker,
} from "../../packages/butler-agent/src/agent/btcc/agent-loop/failure-repetition.ts";
import { rejection } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/actionable-rejection.ts";
import type {
  ModelRoundPort,
  ModelRoundRequest,
  ModelRoundResult,
} from "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";

const failingTool: BtccAgentLoopToolDefinition = {
  name: "lookup",
  description: "Look up a key.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: { key: { type: "string" } },
    required: ["key"],
  },
};

/** Scripted models bound themselves: overrunning the script fails the test. */
function boundedScript(steps: readonly ModelRoundResult[]): {
  port: ModelRoundPort;
  requests: ModelRoundRequest[];
} {
  const requests: ModelRoundRequest[] = [];
  return {
    requests,
    port: {
      async runRound(request) {
        requests.push(structuredClone(request));
        const step = steps[requests.length - 1];
        if (!step) throw new Error(`scripted model exceeded ${steps.length} rounds`);
        return step;
      },
    },
  };
}

function lookupCall(id: string, key: string): ModelRoundResult {
  return {
    toolCalls: [{ id, name: "lookup", arguments: { key }, rawArguments: JSON.stringify({ key }) }],
  };
}

function toolMessages(request: ModelRoundRequest | undefined) {
  return (request?.messages ?? []).filter((message) => message.role === "tool");
}

test("an identical repeated tool failure is stated as a fact without ending the loop", async () => {
  const script = boundedScript([
    lookupCall("c1", "a"),
    lookupCall("c2", "a"),
    lookupCall("c3", "a"),
    lookupCall("c4", "b"),
    { text: "Tried another key.", toolCalls: [] },
  ]);
  const output = await runBtccAgentLoop({
    prompt: "Look up a.",
    tools: [failingTool],
    modelRound: script.port,
    executeTool: async () => ({ ok: false, error: { code: "not_found", message: "Key not found." } }),
  });

  expect(output.finalText).toBe("Tried another key.");
  const lastRequestTools = toolMessages(script.requests.at(-1));
  expect(lastRequestTools).toHaveLength(4);
  const [first, second, third, other] = lastRequestTools.map((message) => JSON.parse(message.content));
  expect(first.error.repeat_count).toBeUndefined();
  expect(second.error.repeat_count).toBe(2);
  expect(third.error.repeat_count).toBe(3);
  expect(third.error.repetition).toContain("has occurred 3 times");
  expect(other.error.repeat_count).toBeUndefined();
  // Activity/tool results keep the original failure without model-facing annotations.
  const activityFailure = output.events.findLast((event) => event.type === "tool_result")?.toolResult;
  expect(activityFailure && !activityFailure.ok ? activityFailure.error : null)
    .toEqual({ code: "not_found", message: "Key not found." });
});

test("repetition keys are canonical and survive restoration", () => {
  const tracker = createFailureRepetitionTracker();
  const failure = { code: "x", message: "failed" };
  const first = tracker.annotate(
    { id: "1", name: "lookup", arguments: { b: 1, a: 2 }, rawArguments: "" },
    { toolCallId: "1", name: "lookup", ok: false, error: failure },
  );
  expect(first.ok ? null : first.error.repeat_count).toBeUndefined();
  const restored = createFailureRepetitionTracker(tracker.snapshot());
  const second = restored.annotate(
    { id: "2", name: "lookup", arguments: { a: 2, b: 1 }, rawArguments: "" },
    { toolCallId: "2", name: "lookup", ok: false, error: failure },
  );
  expect(second.ok ? null : second.error.repeat_count).toBe(2);
  const success = restored.annotate(
    { id: "3", name: "lookup", arguments: { a: 2, b: 1 }, rawArguments: "" },
    { toolCallId: "3", name: "lookup", ok: true, output: { value: 1 } },
  );
  expect(success).toEqual({ toolCallId: "3", name: "lookup", ok: true, output: { value: 1 } });
});

test("runtime nudges state their repetition by observation kind", () => {
  const tracker = createFailureRepetitionTracker();
  expect(tracker.nudge("empty_response", "Continue.")).toBe("Continue.");
  expect(tracker.nudge("text_tool_call", "Use native calls.")).toBe("Use native calls.");
  const repeated = tracker.nudge("empty_response", "Continue.");
  expect(repeated).toStartWith("Continue.");
  expect(repeated).toContain("has been given 2 times");
});

test("actionable rejections carry reason, alternatives, and current state", () => {
  const result = rejection({
    code: "tool_unavailable",
    reason: "write_file is not available in this round.",
    alternatives: ["read_file", "wait_for_worker"],
    state: { execution_mode: "workers" },
  });
  expect(result).toEqual({
    ok: false,
    error: {
      code: "tool_unavailable",
      message: "write_file is not available in this round. Allowed alternatives: read_file, wait_for_worker.",
      reason: "write_file is not available in this round.",
      alternatives: ["read_file", "wait_for_worker"],
      state: { execution_mode: "workers" },
    },
  });
});
