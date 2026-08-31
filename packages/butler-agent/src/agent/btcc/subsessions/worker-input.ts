import type { DelegationPacket } from "./contracts.ts";

export function renderWorkerInput(packet: DelegationPacket, profilePrompt?: string): string {
  if (!packet.plan_action) throw new Error("worker_plan_action_context_missing");
  return [
    "Worker role contract: execute this one bounded Task, review the result, validate it, and report factual output to the Steward.",
    "Do not delegate, create a separate Work/Plan lifecycle, broaden scope, or report to Butler or the user.",
    `plan_action_key: ${packet.plan_action.action_key}`,
    `plan_action_description: ${packet.plan_action.description}`,
    ...(packet.plan_action.effect
      ? [`plan_action_effect: ${packet.plan_action.effect.capability} ${packet.plan_action.effect.target}`]
      : []),
    ...(packet.plan_action.checkpoint_summary
      ? [`latest_checkpoint: ${packet.plan_action.checkpoint_summary}`]
      : []),
    ...(packet.plan_action.next_step
      ? [`recorded_next_step: ${packet.plan_action.next_step}`]
      : []),
    `assigned_objective: ${packet.objective}`,
    `acceptance_criteria: ${packet.acceptance_criteria.join("; ")}`,
    ...(profilePrompt?.trim() ? [`worker_profile_instruction: ${profilePrompt.trim()}`] : []),
  ].join("\n");
}
