import { expect, test } from "bun:test";
import { runBtccAgentLoop } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/index.ts";
import { DURABLE_WORK_TOOL_DEFINITIONS } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/durable-work-tools.ts";
import { createGuidedDelegationTurnRelease } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-turn-closeout.ts";
import { delegateToStewardToolDefinition } from
  "../../packages/butler-agent/src/agent/tools/subsession/definition.ts";
import type { ModelRoundToolCall } from
  "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";

test("successful Steward delegation releases before later batch calls and Work closeout", async () => {
  const laterTools = DURABLE_WORK_TOOL_DEFINITIONS.filter((tool) =>
    tool.name === "replace_work_plan" || tool.name === "record_work_disposition",
  );
  const calls: ModelRoundToolCall[] = [
    toolCall("delegate", "delegate_to_steward", {
      execution_mode: "read_only",
      safe_title: "Inspect the exact reviewed model",
      allowed_tools_and_effects: [
        "grep_files:workspace",
        "list_files:workspace",
        "read_file:workspace",
        "web_read:network",
        "web_search:network",
      ],
      mutation_scope: [],
    }),
    toolCall("later-plan", "replace_work_plan", {
      objective: "This later plan must not execute",
      actions: [{ action_key: "later-action" }],
    }),
    toolCall("later-disposition", "record_work_disposition", {
      work_id: "parent-work",
      disposition: "completed",
      summary: "This later disposition must not execute",
    }),
  ];
  const executed: string[] = [];
  let rounds = 0;
  let closeoutCalls = 0;
  const release = createGuidedDelegationTurnRelease({
    responseLanguage: "Korean",
    originalRequest: "정확한 모델을 조사해 주세요.",
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
        return { toolCalls: calls };
      },
    },
    executeTool: async (call) => {
      executed.push(call.name);
      return { accepted: true };
    },
    finalTextFromToolResult: release.finalTextFromToolResult(),
  });
  const text = await release.reconcileAfterLoop(output.finalText);

  expect(rounds).toBe(1);
  expect(executed).toEqual(["delegate_to_steward"]);
  expect(output.events.filter((event) => event.type === "tool_call")
    .map((event) => event.toolCall?.name)).toEqual(["delegate_to_steward"]);
  expect(text).toBe("위임 작업을 시작했습니다.");
  expect(closeoutCalls).toBe(0);
});

test("failed Steward delegation retains ordinary batch and closeout behavior", async () => {
  const laterTools = DURABLE_WORK_TOOL_DEFINITIONS.filter((tool) =>
    tool.name === "replace_work_plan" || tool.name === "record_work_disposition",
  );
  const calls: ModelRoundToolCall[] = [
    toolCall("delegate", "delegate_to_steward", {
      execution_mode: "read_only",
      safe_title: "Inspect the reviewed model",
      allowed_tools_and_effects: [
        "grep_files:workspace", "list_files:workspace", "read_file:workspace",
        "web_read:network", "web_search:network",
      ],
      mutation_scope: [],
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
    responseLanguage: "English",
    originalRequest: "Inspect the reviewed model.",
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
    finalTextFromToolResult: release.finalTextFromToolResult(),
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
