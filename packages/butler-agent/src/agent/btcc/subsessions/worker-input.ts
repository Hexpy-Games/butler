import type { DelegationPacket } from "./contracts.ts";

export function renderWorkerInput(packet: DelegationPacket, profilePrompt?: string): string {
  return [
    "Worker role contract: execute this one bounded Task, review the result, validate it, and report factual output to the Steward.",
    "Do not delegate, create a separate Work/Plan lifecycle, broaden scope, or report to Butler or the user.",
    `objective: ${packet.objective}`,
    `acceptance_criteria: ${packet.acceptance_criteria.join("; ")}`,
    ...(profilePrompt?.trim() ? [`worker_profile_instruction: ${profilePrompt.trim()}`] : []),
  ].join("\n");
}
