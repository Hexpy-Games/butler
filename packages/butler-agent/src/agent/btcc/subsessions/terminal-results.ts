import type {
  DelegationPacket,
  StewardResultCode,
  StewardResultStatus,
} from "./contracts.ts";

export function completePacketContext(packet: DelegationPacket): boolean {
  if (!packet || typeof packet !== "object") return false;
  const stringValue = (value: unknown): boolean =>
    typeof value === "string" && value.trim().length > 0;
  const stringArray = (value: unknown, minimumLength = 0): boolean =>
    Array.isArray(value) && value.length >= minimumLength &&
    value.every((item) => stringValue(item));
  const expectedSchema = packet.expected_result_schema;
  const workspace = packet.workspace_and_worktree;
  const access = packet.access_and_budget_policy;
  return Boolean(
    stringValue(packet.delegation_id) &&
    stringValue(packet.task_id) &&
    stringValue(packet.parent_session_id) &&
    stringValue(packet.parent_turn_id) &&
    stringValue(packet.relation_id) &&
    stringValue(packet.objective) &&
    stringArray(packet.acceptance_criteria, 1) &&
    stringArray(packet.task_or_plan_refs) &&
    stringArray(packet.constraints_and_non_goals) &&
    stringArray(packet.allowed_tools_and_effects, 1) &&
    stringArray(packet.mutation_scope, 1) &&
    workspace?.ownership === "session" &&
    stringValue(workspace.repository_anchor_ref) &&
    stringValue(workspace.branch) &&
    stringValue(workspace.workspace_label) &&
    packet.work_creation_policy === "one_recoverable_child_work" &&
    expectedSchema?.version === 1 &&
    ["success", "blocked", "failed", "cancelled"].includes(expectedSchema.status) &&
    Array.isArray(expectedSchema.required_fields) &&
    expectedSchema.required_fields.includes("summary") &&
    expectedSchema.required_fields.includes("acceptance_evidence") &&
    expectedSchema.required_fields.includes("changed_artifacts") &&
    access?.access_mode === "full_access" &&
    Number.isInteger(access.max_turns) && access.max_turns > 0 &&
    stringValue(access.model_ref) &&
    stringValue(access.reasoning_effort) &&
    stringValue(packet.model_ref) &&
    stringValue(packet.reasoning_effort),
  );
}

export function defaultCode(status: StewardResultStatus): StewardResultCode | null {
  if (status === "failed") return "steward_execution_failed";
  if (status === "cancelled") return "steward_cancelled";
  return null;
}

export function safeTerminalSummary(
  status: Exclude<StewardResultStatus, "success">,
  code: StewardResultCode | null,
): string {
  if (code === "delegation_context_incomplete") {
    return "Steward could not start because required task context was incomplete.";
  }
  if (status === "cancelled") return "Steward task was stopped before completion.";
  return "Steward could not complete the bounded task.";
}
