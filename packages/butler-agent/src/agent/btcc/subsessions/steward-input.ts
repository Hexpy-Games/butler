import { stableJson } from "../identity/index.ts";
import type { DelegationPacket } from "./contracts.ts";

export function renderStewardInput(
  packet: DelegationPacket,
  parentConversationContext: string,
): string {
  return [
    packet.execution_mode === "read_only"
      ? "Steward role contract: execute the bounded delegated inspection through the ordinary BTCC plan, evidence, review, validation, and terminal lifecycle in the validated project workspace."
      : "Steward role contract: execute the bounded delegated Work through the ordinary BTCC plan, mutation, validation, correction, review, and terminal lifecycle in the session-owned worktree.",
    `delegation_id: ${packet.delegation_id}`,
    `task_id: ${packet.task_id}`,
    `relation_id: ${packet.relation_id}`,
    `parent_session_id: ${packet.parent_session_id}`,
    `parent_turn_id: ${packet.parent_turn_id}`,
    `execution_mode: ${packet.execution_mode}`,
    `inherited_composer_access_mode: ${packet.access_and_budget_policy.access_mode}`,
    `objective: ${packet.objective}`,
    `acceptance_criteria: ${packet.acceptance_criteria.join("; ")}`,
    `task_or_plan_refs: ${packet.task_or_plan_refs.join("; ") || "none"}`,
    `constraints: ${packet.constraints_and_non_goals.join("; ")}`,
    `delegated_task_effect_intent: ${packet.allowed_tools_and_effects.join("; ")}`,
    `mutation_scope: ${packet.mutation_scope.join("; ") || "none"}`,
    `workspace_and_worktree: ${stableJson(packet.workspace_and_worktree)}`,
    `expected_result_schema: ${stableJson(packet.expected_result_schema)}`,
    `work_creation_policy: ${packet.work_creation_policy}`,
    `access_and_budget_policy: ${stableJson(packet.access_and_budget_policy)}`,
    ...(packet.parent_work_ref
      ? [`parent_work_ref: ${stableJson(packet.parent_work_ref)}`]
      : []),
    ...(parentConversationContext ? [parentConversationContext] : []),
  ].join("\n");
}
