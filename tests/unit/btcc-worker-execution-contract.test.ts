import { expect, test } from "bun:test";
import type { DelegationPacket } from
  "../../packages/butler-agent/src/agent/btcc/subsessions/contracts.ts";
import { renderWorkerInput } from
  "../../packages/butler-agent/src/agent/btcc/subsessions/worker-input.ts";
import { delegateToWorkerToolDefinition } from
  "../../packages/butler-agent/src/agent/tools/subsession/definition.ts";

test("Worker delegation requires and renders one reviewed Plan action", () => {
  expect(delegateToWorkerToolDefinition.parameters.required).toEqual([
    "action_key",
    "objective",
    "acceptance_criteria",
    "implementation_brief",
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
    implementation_brief: "Edit renderer.tsx through the existing component path and preserve the design-system boundary.",
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
    work_creation_policy: "one_recoverable_child_work",
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
  expect(input).toContain("implementation_brief:\nEdit renderer.tsx");
  expect(input).toContain("session-scoped Micro Work");
  expect(input).toContain("Runtime has already created and bound");
  expect(input).not.toContain("Create and complete one session-scoped Micro Work");
});
