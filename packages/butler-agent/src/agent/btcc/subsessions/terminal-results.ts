import type {
  DelegationPacket,
  StewardResultCode,
  StewardResultStatus,
} from "./contracts.ts";
import { SUBSESSION_READ_ONLY_TOOLS_AND_EFFECTS } from "./scope.ts";

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
  const executionMode = packet.execution_mode;
  const workspaceValid = executionMode === "read_only"
    ? workspace?.ownership === "project" &&
      workspace.workspace_label === "Validated project workspace" &&
      workspace.repository_anchor_ref === "parent-session-project"
    : executionMode === "mutation" &&
      workspace?.ownership === "session" &&
      stringValue(workspace.repository_anchor_ref) &&
      stringValue(workspace.branch) &&
      stringValue(workspace.workspace_label);
  const readOnlySurfaceValid = executionMode !== "read_only" ||
    (Array.isArray(packet.mutation_scope) && Array.isArray(packet.allowed_tools_and_effects) &&
      packet.mutation_scope.length === 0 &&
      packet.allowed_tools_and_effects.length === SUBSESSION_READ_ONLY_TOOLS_AND_EFFECTS.length &&
      packet.allowed_tools_and_effects.every((value) =>
        SUBSESSION_READ_ONLY_TOOLS_AND_EFFECTS.includes(value as typeof SUBSESSION_READ_ONLY_TOOLS_AND_EFFECTS[number]),
      ));
  const projectContextValid = validProjectContext(packet.project_context);
  return Boolean(
    stringValue(packet.delegation_id) &&
    stringValue(packet.task_id) &&
    stringValue(packet.parent_session_id) &&
    stringValue(packet.parent_turn_id) &&
    stringValue(packet.relation_id) &&
    (executionMode === "read_only" || executionMode === "mutation") &&
    stringValue(packet.objective) &&
    stringArray(packet.acceptance_criteria, 1) &&
    stringArray(packet.task_or_plan_refs) &&
    stringArray(packet.constraints_and_non_goals) &&
    stringArray(packet.allowed_tools_and_effects, 1) &&
    stringArray(packet.mutation_scope, executionMode === "mutation" ? 1 : 0) &&
    workspaceValid &&
    readOnlySurfaceValid &&
    projectContextValid &&
    packet.work_creation_policy === "one_recoverable_child_work" &&
    expectedSchema?.version === 1 &&
    ["success", "blocked", "failed", "cancelled"].includes(expectedSchema.status) &&
    Array.isArray(expectedSchema.required_fields) &&
    expectedSchema.required_fields.includes("summary") &&
    expectedSchema.required_fields.includes("acceptance_evidence") &&
    expectedSchema.required_fields.includes("changed_artifacts") &&
    access?.access_mode === (executionMode === "read_only" ? "read_only" : "full_access") &&
    Number.isInteger(access.max_turns) && access.max_turns > 0 &&
    stringValue(access.model_ref) &&
    stringValue(access.reasoning_effort) &&
    stringValue(packet.model_ref) &&
    stringValue(packet.reasoning_effort),
  );
}

function validProjectContext(context: DelegationPacket["project_context"]): boolean {
  if (!context) return true;
  if (!Array.isArray(context.required_source_ids) ||
      !Array.isArray(context.missing_source_ids) ||
      !Array.isArray(context.mandatory_refs) ||
      !Array.isArray(context.optional_refs)) return false;
  if (!context.project_id.trim() || context.missing_source_ids.length > 0) return false;
  if (!context.required_source_ids.every((source) =>
    source === "project-hot-cache" || source === "project-memory")) return false;
  const refs = [...context.mandatory_refs, ...context.optional_refs];
  if (new Set(refs.map((ref) => ref.source_id)).size !== refs.length) return false;
  if (!context.required_source_ids.every((source) => refs.some((ref) => ref.source_id === source))) return false;
  return refs.every((ref) =>
    /^[a-f0-9]{64}$/u.test(ref.context_ref) &&
    /^[a-f0-9]{64}$/u.test(ref.content_sha256) &&
    Boolean(ref.source_revision.trim()) &&
    ((ref.source_id === "project-hot-cache" &&
      ref.projection_class === "mandatory_hot_cache") ||
     (ref.source_id === "project-memory" &&
      ref.projection_class === "optional_hot_cache")),
  );
}

export function defaultCode(status: StewardResultStatus): StewardResultCode | null {
  if (status === "cancelled") return "steward_cancelled";
  return null;
}

export function safeTerminalSummary(
  status: Exclude<StewardResultStatus, "success">,
  code: StewardResultCode | null,
): string {
  if (code === "delegation_context_incomplete") {
    return "Required project context is not available for this delegated work.";
  }
  if (status === "cancelled") return "The delegated work was stopped.";
  if (status === "blocked") return "The delegated work requires additional input before it can continue.";
  return "A confirmed system failure ended the delegated session.";
}
