import type { DelegationPacket } from "./contracts.ts";

export function renderWorkerInput(packet: DelegationPacket, profilePrompt?: string): string {
  if (!packet.plan_action) throw new Error("worker_plan_action_context_missing");
  return [
    "Worker role contract: run the normal BTCC lifecycle for this one bounded Task, then report factual output to the Steward.",
    "Runtime has already created and bound your one session-scoped Micro Work. Use that existing Work; do not create or select another Work. Create a concise Plan and accepted Plan Review before persistent effects. Review and validate the result before completing that Micro Work.",
    "Do not delegate, mutate the parent Work, create Project Ledger records, broaden scope, or report to Butler or the user.",
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
    ...(packet.implementation_brief
      ? [`implementation_brief:\n${packet.implementation_brief}`]
      : []),
    ...(profilePrompt?.trim() ? [`worker_profile_instruction: ${profilePrompt.trim()}`] : []),
  ].join("\n");
}
