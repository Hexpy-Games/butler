import { expect, test } from "bun:test";
import { runBtccAgentLoop } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/index.ts";
import { DURABLE_WORK_TOOL_DEFINITIONS } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/durable-work-tools.ts";
import { createGuidedDelegationTurnRelease } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-turn-closeout.ts";
import { createRoundToolSurfaceSnapshot } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/round-tool-surface.ts";
import { delegateToStewardToolDefinition } from
  "../../packages/butler-agent/src/agent/tools/subsession/definition.ts";
import type { ModelRoundToolCall } from
  "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";

test("successful Steward delegation gets a natural tool-free handoff and skips Work closeout", async () => {
  const call = toolCall("delegate", "delegate_to_steward", {
    request: "Inspect the exact reviewed model and report the useful result.",
    safe_title: "Inspect the exact reviewed model",
  });
  const executed: string[] = [];
  const records: Array<{
    callId: string;
    toolName: string;
    rawArguments: string;
    arguments: Record<string, unknown>;
    status: "completed";
    result: { ok: true; status: "queued" };
  }> = [];
  let rounds = 0;
  let closeoutReviewCalls = 0;
  let closeoutCalls = 0;
  const release = createGuidedDelegationTurnRelease({
    turnId: "parent-turn",
    toolJournal: { list: () => records },
    delegationTool: "delegate_to_steward",
    reviewFinalCandidate: async () => {
      closeoutReviewCalls += 1;
      return { status: "continue", observation: "close the Work" };
    },
    reconcileAfterLoop: async (text) => {
      closeoutCalls += 1;
      return `closed: ${text}`;
    },
  });

  const output = await runBtccAgentLoop({
    prompt: "Delegate the reviewed plan.",
    tools: [delegateToStewardToolDefinition],
    resolveTools: async () => createRoundToolSurfaceSnapshot(
      records.length === 0 ? [delegateToStewardToolDefinition] : [],
    ),
    modelRound: {
      async runRound(request) {
        rounds += 1;
        if (rounds === 1) return { toolCalls: [call] };
        expect(request.tools).toEqual([]);
        return {
          text: "정확한 검토를 위해 스튜어드에게 조사를 맡겼습니다.",
          toolCalls: [],
        };
      },
    },
    executeTool: async (call) => {
      executed.push(call.name);
      records.push({
        callId: call.id,
        toolName: call.name,
        rawArguments: call.rawArguments,
        arguments: call.arguments,
        status: "completed",
        result: { ok: true, status: "queued" },
      });
      return { ok: true, status: "queued" };
    },
    reviewFinalCandidate: release.reviewFinalCandidate,
  });
  const text = await release.reconcileAfterLoop(output.finalText);

  expect(rounds).toBe(2);
  expect(executed).toEqual(["delegate_to_steward"]);
  expect(output.events.filter((event) => event.type === "tool_call")
    .map((event) => event.toolCall?.name)).toEqual(["delegate_to_steward"]);
  expect(text).toBe("정확한 검토를 위해 스튜어드에게 조사를 맡겼습니다.");
  expect(closeoutReviewCalls).toBe(0);
  expect(closeoutCalls).toBe(0);
});

test("failed Steward delegation retains ordinary batch and closeout behavior", async () => {
  const laterTools = DURABLE_WORK_TOOL_DEFINITIONS.filter((tool) =>
    tool.name === "replace_work_plan" || tool.name === "record_work_disposition",
  );
  const calls: ModelRoundToolCall[] = [
    toolCall("delegate", "delegate_to_steward", {
      request: "Inspect the reviewed model and report any delegation failure plainly.",
      safe_title: "Inspect the reviewed model",
    }),
    toolCall("later-plan", "replace_work_plan", {
      objective: "Continue after a failed delegation",
      actions: [{ action_key: "continue" }],
    }),
    toolCall("later-disposition", "record_work_disposition", {
      work_id: "parent-work", disposition: "open", summary: "Still open",
    }),
  ];
  const executed: string[] = [];
  let rounds = 0;
  let closeoutCalls = 0;
  const release = createGuidedDelegationTurnRelease({
    turnId: "parent-turn",
    toolJournal: { list: () => [] },
    delegationTool: "delegate_to_steward",
    reviewFinalCandidate: async () => ({ status: "accepted" }),
    reconcileAfterLoop: async (text) => {
      closeoutCalls += 1;
      return `closed: ${text}`;
    },
  });

  const output = await runBtccAgentLoop({
    prompt: "Delegate the reviewed plan.",
    tools: [delegateToStewardToolDefinition, ...laterTools],
    modelRound: {
      async runRound() {
        rounds += 1;
        return rounds === 1 ? { toolCalls: calls } : { text: "ordinary final", toolCalls: [] };
      },
    },
    executeTool: async (call) => {
      executed.push(call.name);
      if (call.name === "delegate_to_steward") throw new Error("delegation failed");
      return { accepted: true };
    },
  });
  const text = await release.reconcileAfterLoop(output.finalText);

  expect(rounds).toBe(2);
  expect(executed).toEqual([
    "delegate_to_steward", "replace_work_plan", "record_work_disposition",
  ]);
  expect(text).toBe("closed: ordinary final");
  expect(closeoutCalls).toBe(1);
});

function toolCall(
  id: string,
  name: string,
  arguments_: Record<string, unknown>,
): ModelRoundToolCall {
  return {
    id,
    name,
    arguments: arguments_,
    rawArguments: JSON.stringify(arguments_),
  };
}
