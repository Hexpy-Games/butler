import type {
  DelegationPacket,
  SessionRelation,
  SubsessionDelegationDependencies,
} from "./contracts.ts";
import { subsessionRootWorkId } from "./identities.ts";
import { distinctMaterialReadCount, materialReadReportAnchors } from "./read-only-material-evidence.ts";
import { SUBSESSION_READ_ONLY_TOOLS_AND_EFFECTS } from "./scope.ts";
import { factualCompletionFailure } from "./completion-evidence-errors.ts";
import { validateMutationCompletion } from "./mutation-completion-evidence.ts";

export {
  StewardCompletionEvidenceError,
  factualCompletionFailure,
  isFactualCompletionFailure,
  retryableCompletionFailure,
} from "./completion-evidence-errors.ts";

export type CompletionEvidenceInput = {
  relation: SessionRelation;
  packet: DelegationPacket;
  childTurnId: string;
  sessionBindings: SubsessionDelegationDependencies["sessionBindings"];
  durableWork: SubsessionDelegationDependencies["durableWork"];
  rootWorkId: string | null;
  toolJournal: SubsessionDelegationDependencies["toolJournal"];
  effectJournal: SubsessionDelegationDependencies["effectJournal"];
};

export async function validateStewardCompletion(input: CompletionEvidenceInput): Promise<{
  summary: string;
  acceptanceEvidence: string[];
  changedArtifacts: string[];
  reportEvidenceAnchors: string[];
}> {
  const packet = input.packet;
  validatePacket(packet);
  if (!input.rootWorkId) factualCompletionFailure("subsession_root_work_identity_missing");
  if (input.rootWorkId !== subsessionRootWorkId(
    input.packet.delegation_id,
    input.packet.task_id,
    input.relation.child_session_id,
  )) {
    factualCompletionFailure("subsession_root_work_identity_mismatch");
  }
  const work = await input.durableWork.boundWorkForTurn(input.childTurnId);
  validateWork(work, input);
  if (packet.execution_mode === "read_only") {
    return await validateReadOnlyCompletion({ ...input, packet }, work);
  }
  return await validateMutationCompletion({ ...input, packet }, work);
}

function validatePacket(packet: DelegationPacket): void {
  const executionMode = packet.execution_mode;
  const workspace = packet.workspace_and_worktree;
  const workspaceValid = executionMode === "read_only"
    ? workspace.ownership === "project" &&
      workspace.workspace_label === "Validated project workspace" &&
      workspace.repository_anchor_ref === "parent-session-project"
    : workspace.ownership === "session" &&
      workspace.workspace_label === "Steward session worktree" &&
      workspace.repository_anchor_ref === "parent-session-repository" &&
      Boolean(workspace.branch);
  const readOnlySurfaceValid = executionMode !== "read_only" ||
    (Array.isArray(packet.mutation_scope) && Array.isArray(packet.allowed_tools_and_effects) &&
      packet.mutation_scope.length === 0 &&
      packet.allowed_tools_and_effects.length === SUBSESSION_READ_ONLY_TOOLS_AND_EFFECTS.length &&
      packet.allowed_tools_and_effects.every((value) =>
        SUBSESSION_READ_ONLY_TOOLS_AND_EFFECTS.includes(value as typeof SUBSESSION_READ_ONLY_TOOLS_AND_EFFECTS[number]),
      ));
  if ((executionMode !== "read_only" && executionMode !== "mutation") ||
    !workspaceValid ||
    !readOnlySurfaceValid ||
    packet.work_creation_policy !== "one_recoverable_child_work" ||
    packet.expected_result_schema.version !== 1 ||
    packet.expected_result_schema.status !== "success" ||
    packet.access_and_budget_policy.access_mode !== (executionMode === "read_only" ? "read_only" : "full_access") ||
    packet.access_and_budget_policy.model_ref !== packet.model_ref ||
    packet.access_and_budget_policy.reasoning_effort !== packet.reasoning_effort) {
    factualCompletionFailure("subsession_packet_incomplete");
  }
}

async function validateReadOnlyCompletion(
  input: CompletionEvidenceInput,
  work: NonNullable<Awaited<ReturnType<SubsessionDelegationDependencies["durableWork"]["boundWorkForTurn"]>>>,
): Promise<{
  summary: string;
  acceptanceEvidence: string[];
  changedArtifacts: string[];
  reportEvidenceAnchors: string[];
}> {
  const records = input.toolJournal.list(input.childTurnId);
  const allowedTools = new Set([
    "replace_work_plan",
    "record_work_checkpoint",
    "record_work_review",
    "record_work_disposition",
    "read_file",
    "list_files",
    "grep_files",
    "web_search",
    "web_read",
  ]);
  if (records.some((record) => !allowedTools.has(record.toolName))) {
    factualCompletionFailure("subsession_read_only_tool_out_of_scope");
  }
  if (work.currentPlan?.actions.some((action) => action.effect)) {
    factualCompletionFailure("subsession_read_only_effect_planned");
  }
  const materialReadCount = distinctMaterialReadCount(records);
  const reportEvidenceAnchors = materialReadReportAnchors(records);
  if (materialReadCount < 2 || reportEvidenceAnchors.length < 2) {
    factualCompletionFailure("subsession_read_only_material_reads_missing");
  }
  const effects = await input.effectJournal.listForWork(work.workId, 20);
  if (effects.length > 0) factualCompletionFailure("subsession_read_only_effect_present");
  return {
    summary: "Steward completed the bounded read-only inspection.",
    acceptanceEvidence: [
      "One child Work completed with accepted Plan, progress, result, and completion evidence.",
      `Material read evidence: ${reportEvidenceAnchors.join("; ")}.`,
      "No effect journal row or applied receipt was recorded.",
    ],
    changedArtifacts: [],
    reportEvidenceAnchors,
  };
}

function validateWork(
  work: Awaited<ReturnType<SubsessionDelegationDependencies["durableWork"]["boundWorkForTurn"]>>,
  input: CompletionEvidenceInput,
): asserts work is NonNullable<typeof work> {
  if (!work || work.workId !== input.rootWorkId ||
    work.sessionId !== input.relation.child_session_id ||
    work.scope.kind !== "session" || work.scope.sessionId !== input.relation.child_session_id ||
    work.origin.turnId !== input.childTurnId || work.objective !== input.packet.objective) {
    factualCompletionFailure("subsession_root_work_identity_mismatch");
  }
  if (work.status !== "completed" || work.latestDisposition?.disposition !== "completed") {
    factualCompletionFailure("subsession_work_not_completed");
  }
  if (work.latestPlanReview?.subject !== "plan" || work.latestPlanReview.verdict !== "accept") {
    factualCompletionFailure("subsession_plan_review_not_accepted");
  }
  if (work.latestResultReview?.subject !== "result" || work.latestResultReview.verdict !== "accept") {
    factualCompletionFailure("subsession_result_review_not_accepted");
  }
  if (work.latestCompletionValidation?.subject !== "completion" ||
    work.latestCompletionValidation.verdict !== "accept") {
    factualCompletionFailure("subsession_completion_review_not_accepted");
  }
  if (!work.currentPlan || !work.currentPlan.actions.length) {
    factualCompletionFailure("subsession_work_plan_missing");
  }
}

export type ValidatedStewardWork = NonNullable<Awaited<ReturnType<
  SubsessionDelegationDependencies["durableWork"]["boundWorkForTurn"]
>>>;
