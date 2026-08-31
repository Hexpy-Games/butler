import { expect, test } from "bun:test";
import type { BtccAgentLoopToolResult } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/contracts.ts";
import { createGuidedExecutionWindowObserver } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/execution-window-observation.ts";
import { runGuidedAgentLoopWithOperationalReport } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-operational-report.ts";
import type { DelegationPacket } from
  "../../packages/butler-agent/src/agent/btcc/subsessions/contracts.ts";
import { renderWorkerInput } from
  "../../packages/butler-agent/src/agent/btcc/subsessions/worker-input.ts";
import type { DurableWorkService } from
  "../../packages/butler-agent/src/agent/btcc/work/index.ts";
import { delegateToWorkerToolDefinition } from
  "../../packages/butler-agent/src/agent/tools/subsession/definition.ts";

test("Worker delegation requires and renders one reviewed Plan action", () => {
  expect(delegateToWorkerToolDefinition.parameters.required).toEqual([
    "action_key",
    "objective",
    "acceptance_criteria",
  ]);
  const packet: DelegationPacket = {
    delegation_id: "delegation-worker",
    task_id: "worker-task",
    parent_session_id: "steward-session",
    parent_turn_id: "steward-turn",
    relation_id: "relation-worker",
    execution_mode: "mutation",
    objective: "Implement the approved renderer change.",
    acceptance_criteria: ["The focused interaction works."],
    task_or_plan_refs: ["plan-1"],
    plan_action: {
      action_key: "implement-renderer",
      description: "Implement the approved renderer change.",
      dependency_keys: ["inspect-renderer"],
      effect: { capability: "edit_file", target: "renderer.tsx" },
      checkpoint_summary: "The existing renderer path was inspected.",
      next_step: "Implement the renderer action.",
    },
    constraints_and_non_goals: [],
    allowed_tools_and_effects: ["edit_file"],
    mutation_scope: ["."],
    workspace_and_worktree: {
      ownership: "parent_session",
      workspace_label: "Inherited parent session workspace",
      repository_anchor_ref: "parent-session-workspace",
    },
    expected_result_schema: {
      version: 1,
      status: "success",
      required_fields: ["summary", "acceptance_evidence", "changed_artifacts"],
    },
    work_creation_policy: "none",
    access_and_budget_policy: {
      access_mode: "full_access",
      max_turns: 8,
      model_ref: "openai/gpt-5.5",
      reasoning_effort: "medium",
    },
    parent_work_ref: {
      work_id: "work-1",
      session_id: "steward-session",
      turn_id: "steward-turn",
      plan_revision_id: "plan-1",
      review_revision_id: "review-1",
    },
    model_ref: "openai/gpt-5.5",
    reasoning_effort: "medium",
  };

  const input = renderWorkerInput(packet);
  expect(input).toContain("plan_action_key: implement-renderer");
  expect(input).toContain("plan_action_effect: edit_file renderer.tsx");
  expect(input).toContain("latest_checkpoint: The existing renderer path was inspected.");
  expect(input).toContain("recorded_next_step: Implement the renderer action.");
});

test("Worker returns a factual blocked report after repeated diagnosed non-progress", async () => {
  const durableWork = unusedDurableWork();
  const observer = createGuidedExecutionWindowObserver({
    durableWork,
    workScope: { turnId: "worker-turn", sessionId: "worker-session" },
    turnId: "worker-turn",
    trackingMode: "none",
    role: "worker",
    workspacePath: process.cwd(),
    listToolRecords: () => [],
    signal: new AbortController().signal,
  });
  const firstWindow = failedNoChangeResults(0);
  const secondWindow = [...firstWindow, ...failedNoChangeResults(3)];

  expect(await observer.observe({ windowIndex: 0, toolResults: firstWindow }))
    .toContain("Execution checkpoint 1");
  expect(await observer.observe({ windowIndex: 1, toolResults: secondWindow }))
    .toBeUndefined();
  const blockedReport = observer.blockedReport();
  expect(blockedReport).not.toBeNull();
  if (!blockedReport) throw new Error("Worker blocked report was not recorded");
  expect(blockedReport).toContain("Two consecutive execution windows");

  const report = await runGuidedAgentLoopWithOperationalReport({
    options: {
      prompt: "Return the Worker result.",
      tools: [],
      modelRound: {
        async runRound() {
          return { text: "", toolCalls: [] };
        },
      },
      maxIterations: 1,
      executeTool: async () => undefined,
      onExecutionWindowBoundary: () => undefined,
      onLoopLimit: () => blockedReport,
    },
    parentSignal: new AbortController().signal,
    originalRequest: "Execute the assigned Plan action.",
    acceptStoppedResult: true,
    loadFacts: async () => ({ work: null, toolCalls: [], effects: [] }),
  });
  expect(report).toBe(blockedReport);
});

function failedNoChangeResults(offset: number): BtccAgentLoopToolResult[] {
  return Array.from({ length: 3 }, (_, index) => ({
    toolCallId: `edit-${offset + index}`,
    name: "edit_file",
    ok: false as const,
    error: { code: "no_change_requested", message: "No change was requested." },
  }));
}

function unusedDurableWork(): DurableWorkService {
  const unavailable = async (): Promise<never> => {
    throw new Error("unused durable Work operation");
  };
  return {
    loadContext: async () => null,
    importOpenLegacyWork: async () => null,
    bindOpenWork: async () => null,
    startWork: unavailable,
    continueWork: unavailable,
    replacePlan: unavailable,
    recordCheckpoint: unavailable,
    recordReview: unavailable,
    recordDisposition: unavailable,
    claimCloseoutCorrection: async () => false,
    attachToolResult: unavailable,
    boundWorkForTurn: async () => null,
    abandonBoundWorkForTurn: async () => null,
  };
}
