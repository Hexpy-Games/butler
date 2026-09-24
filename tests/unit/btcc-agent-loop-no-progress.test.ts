import { expect, test } from "bun:test";
import {
  AGENT_LOOP_NO_PROGRESS_CODE,
  DEFAULT_MAX_NO_PROGRESS_ROUNDS,
  runBtccAgentLoop,
  selectMaxNoProgressRounds,
  type BtccAgentLoopToolDefinition,
} from "../../packages/butler-agent/src/agent/btcc/agent-loop/index.ts";
import type {
  ModelRoundPort,
  ModelRoundRequest,
  ModelRoundResult,
} from "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";
import { safeRuntimeFailure } from
  "../../packages/butler-agent/src/integrations/providers/runtime-failure-diagnostics.ts";
import { runtimeFailureMessage } from
  "../../packages/butler-agent/src/agent/btcc/turn/turn-runtime-failure.ts";

const echoTool: BtccAgentLoopToolDefinition = {
  name: "echo",
  description: "Echo a message.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: { message: { type: "string" } },
    required: ["message"],
  },
};

// A scripted model answers without I/O. Without a product cap the loop would
// spin forever and starve bun's timeout, so the script itself fails fast.
const SCRIPT_OVERRUN = 50;
const noTool = async () => ({});

function endlessModel(step: (index: number, request: ModelRoundRequest) => ModelRoundResult): {
  port: ModelRoundPort;
  calls: () => number;
} {
  let index = 0;
  return {
    calls: () => index,
    port: {
      async runRound(request) {
        index += 1;
        if (index > SCRIPT_OVERRUN) throw new Error(`scripted model overrun: ${index}`);
        return step(index, request);
      },
    },
  };
}

test("a plain-text reply that the closeout keeps re-asking stops at the no-progress cap", async () => {
  const model = endlessModel(() => ({ text: "Still working on it.", toolCalls: [] }));
  const run = runBtccAgentLoop({
    prompt: "finish the delegated assignment",
    model: "test/model",
    tools: [echoTool],
    modelRound: model.port,
    executeTool: noTool,
    maxNoProgressRounds: 4,
    reviewFinalCandidate: async () => ({
      status: "continue",
      observation: "The delegated assignment is still open. Continue.",
    }),
  });

  await expect(run).rejects.toMatchObject({ code: AGENT_LOOP_NO_PROGRESS_CODE });
  expect(model.calls()).toBe(4);
});

test("a tool call that always fails stops at the no-progress cap", async () => {
  let executions = 0;
  const model = endlessModel((index) => ({
    toolCalls: [{ id: `call-${index}`, name: "echo", arguments: { message: "same" },
      rawArguments: "{\"message\":\"same\"}" }],
  }));
  const run = runBtccAgentLoop({
    prompt: "delegate the work",
    model: "test/model",
    tools: [echoTool],
    modelRound: model.port,
    maxNoProgressRounds: 5,
    executeTool: async () => {
      executions += 1;
      throw new Error("execution_mode steward required");
    },
  });

  await expect(run).rejects.toMatchObject({ code: AGENT_LOOP_NO_PROGRESS_CODE });
  expect(model.calls()).toBe(5);
  expect(executions).toBe(5);
});

test("text-form tool calls that are only answered with observations stop at the cap", async () => {
  const model = endlessModel(() => ({
    text: "<tool_call>echo</tool_call>",
    toolCalls: [],
    textToolCallNames: ["echo"],
  }));
  const run = runBtccAgentLoop({
    prompt: "use the tool",
    model: "test/model",
    tools: [echoTool],
    modelRound: model.port,
    executeTool: noTool,
    maxNoProgressRounds: 3,
    onTextToolCalls: async () => ({
      status: "continue",
      observation: "Use the native tool call format.",
    }),
  });

  await expect(run).rejects.toMatchObject({ code: AGENT_LOOP_NO_PROGRESS_CODE });
  expect(model.calls()).toBe(3);
});

test("a successful tool result resets the no-progress count", async () => {
  const model = endlessModel((index) => index > 8
    ? { text: "Done after mixed results.", toolCalls: [] }
    : { toolCalls: [{ id: `call-${index}`, name: "echo",
      arguments: { message: index % 2 === 0 ? "ok" : "fail" },
      rawArguments: JSON.stringify({ message: index % 2 === 0 ? "ok" : "fail" }) }] });
  const result = await runBtccAgentLoop({
    prompt: "mixed results",
    model: "test/model",
    tools: [echoTool],
    modelRound: model.port,
    maxNoProgressRounds: 2,
    executeTool: async (call) => {
      if ((call.arguments as { message: string }).message === "fail") throw new Error("boom");
      return { echoed: true };
    },
  });

  expect(result.finalText).toBe("Done after mixed results.");
  expect(model.calls()).toBe(9);
});

test("fresh user direction resets the no-progress count", async () => {
  let reviews = 0;
  const model = endlessModel(() => ({ text: "Candidate report.", toolCalls: [] }));
  const result = await runBtccAgentLoop({
    prompt: "keep going with user steering",
    model: "test/model",
    tools: [echoTool],
    modelRound: model.port,
    executeTool: noTool,
    maxNoProgressRounds: 2,
    beforeModelRound: async () => ["The user added a new direction."],
    reviewFinalCandidate: async () => {
      reviews += 1;
      return reviews < 6
        ? { status: "continue", observation: "Continue." }
        : { status: "accepted" };
    },
  });

  expect(result.finalText).toBe("Candidate report.");
  expect(model.calls()).toBe(6);
});

test("the no-progress cap defaults, reads its env override, and rejects unsafe values", () => {
  expect(DEFAULT_MAX_NO_PROGRESS_ROUNDS).toBe(10);
  expect(selectMaxNoProgressRounds({})).toBe(DEFAULT_MAX_NO_PROGRESS_ROUNDS);
  expect(selectMaxNoProgressRounds({ BUTLER_AGENT_LOOP_MAX_NO_PROGRESS_ROUNDS: "25" })).toBe(25);
  expect(() => selectMaxNoProgressRounds({ BUTLER_AGENT_LOOP_MAX_NO_PROGRESS_ROUNDS: "0" }))
    .toThrow("invalid_agent_loop_limit:BUTLER_AGENT_LOOP_MAX_NO_PROGRESS_ROUNDS");
  expect(() => selectMaxNoProgressRounds({ BUTLER_AGENT_LOOP_MAX_NO_PROGRESS_ROUNDS: "100000" }))
    .toThrow("invalid_agent_loop_limit:BUTLER_AGENT_LOOP_MAX_NO_PROGRESS_ROUNDS");
});

test("a no-progress stop becomes a clear, non-retryable runtime failure", async () => {
  const model = endlessModel(() => ({ text: "Still working.", toolCalls: [] }));
  const error = await runBtccAgentLoop({
    prompt: "finish",
    model: "test/model",
    tools: [],
    modelRound: model.port,
    executeTool: noTool,
    maxNoProgressRounds: 1,
    reviewFinalCandidate: async () => ({ status: "continue", observation: "Continue." }),
  }).catch((caught: unknown) => caught);

  const failure = safeRuntimeFailure(error);
  expect(failure).toMatchObject({ code: AGENT_LOOP_NO_PROGRESS_CODE, retryable: false });
  expect(runtimeFailureMessage("finish", { code: failure.code, retryable: false }))
    .toBe("Repeated model rounds without progress prevented further work. Progress is saved.");
  expect(runtimeFailureMessage("마무리해줘", { code: failure.code, retryable: false }))
    .toContain("진전 없이 반복되어");
});
