import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import {
  resolveSessionWorkspaceAuthority,
  validateSessionWorkspaceAuthority,
} from "../../session-workspaces/index.ts";
import { createPlatformCommandExecutor } from "../../../runtime/command/platform-command-executor.ts";
import type {
  DelegationPacket,
  SessionRelation,
  SubsessionDelegationDependencies,
} from "./contracts.ts";
import { subsessionRootWorkId } from "./identities.ts";
import { distinctMaterialReadCount } from "./read-only-material-evidence.ts";
import { SUBSESSION_READ_ONLY_TOOLS_AND_EFFECTS } from "./scope.ts";

type CompletionEvidenceInput = {
  relation: SessionRelation;
  packet: DelegationPacket;
  childTurnId: string;
  sessionBindings: SubsessionDelegationDependencies["sessionBindings"];
  durableWork: SubsessionDelegationDependencies["durableWork"];
  rootWorkId: string | null;
  toolJournal: SubsessionDelegationDependencies["toolJournal"];
  effectJournal: SubsessionDelegationDependencies["effectJournal"];
};

/**
 * A completion check can observe either a durable contradiction or a
 * temporary inability to inspect the evidence.  Only the former is a typed
 * terminal failure; the latter must escape so the existing outbox can retry.
 */
export class StewardCompletionEvidenceError extends Error {
  readonly kind: "factual" | "retryable";

  constructor(code: string, kind: "factual" | "retryable") {
    super(code);
    this.name = "StewardCompletionEvidenceError";
    this.kind = kind;
  }
}

export function factualCompletionFailure(code: string): never {
  throw new StewardCompletionEvidenceError(code, "factual");
}

export function retryableCompletionFailure(code: string): never {
  throw new StewardCompletionEvidenceError(code, "retryable");
}

export function isFactualCompletionFailure(error: unknown): boolean {
  return error instanceof StewardCompletionEvidenceError && error.kind === "factual";
}

export async function validateStewardCompletion(input: CompletionEvidenceInput): Promise<{
  summary: string;
  acceptanceEvidence: string[];
  changedArtifacts: string[];
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
  const action = mutationAction(work);
  const effect = await validateAppliedEffect(input, work, action);
  const normalizedInput = { ...input, packet };
  const target = await validateWorktreeArtifact(normalizedInput, effect);
  validateMutationTool(normalizedInput, effect.capability);
  const workspace = mutationWorkspace(packet);
  return {
    summary: work.latestDisposition!.summary,
    acceptanceEvidence: [
      `Work ${work.workId} completed with accepted plan, result, and completion reviews.`,
      `Applied ${effect.capability} receipt ${effect.receipt!.receiptId} verified for ${target}.`,
      `Session-owned worktree ${workspace.branch} contains the applied artifact.`,
    ],
    changedArtifacts: [target],
  };
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
  if (materialReadCount < 2) {
    factualCompletionFailure("subsession_read_only_material_reads_missing");
  }
  const effects = await input.effectJournal.listForWork(work.workId, 20);
  if (effects.length > 0) factualCompletionFailure("subsession_read_only_effect_present");
  return {
    summary: "Steward completed the bounded read-only inspection.",
    acceptanceEvidence: [
      "One child Work completed with accepted Plan, progress, result, and completion evidence.",
      `${materialReadCount} distinct material read operations completed in the validated project workspace.`,
      "No effect journal row or applied receipt was recorded.",
    ],
    changedArtifacts: [],
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

function mutationAction(work: NonNullable<Awaited<ReturnType<SubsessionDelegationDependencies["durableWork"]["boundWorkForTurn"]>>>): NonNullable<NonNullable<typeof work.currentPlan>["actions"][number]> & { effect: NonNullable<NonNullable<typeof work.currentPlan>["actions"][number]["effect"]> } {
  const expectedActions = work.currentPlan!.actions.filter((action) => action.effect);
  if (expectedActions.length !== 1) factualCompletionFailure("subsession_mutation_action_cardinality_invalid");
  const action = expectedActions[0]!;
  const actionProgress = work.actionProgress.find((item) => item.actionKey === action.actionKey);
  if (!actionProgress || actionProgress.status !== "done") {
    factualCompletionFailure("subsession_mutation_action_not_done");
  }
  return action as typeof action & { effect: NonNullable<typeof action.effect> };
}

async function validateAppliedEffect(
  input: CompletionEvidenceInput,
  work: NonNullable<Awaited<ReturnType<SubsessionDelegationDependencies["durableWork"]["boundWorkForTurn"]>>>,
  action: ReturnType<typeof mutationAction>,
) {
  const effects = await input.effectJournal.listForWork(work.workId, 20);
  const applied = effects.filter((effect) => effect.status === "applied" && effect.receipt);
  if (applied.length !== 1) factualCompletionFailure("subsession_applied_effect_cardinality_invalid");
  const effect = applied[0]!;
  const effectTarget = effect.sanitizedTarget.replace(/^workspace:/u, "");
  if (effect.workId !== work.workId || effect.capability !== action.effect.capability ||
    (effect.actionKey !== action.actionKey && effect.actionKey !== "accepted-plan") ||
    effectTarget !== action.effect.target) {
    factualCompletionFailure("subsession_applied_effect_identity_mismatch");
  }
  if (effect.capability !== "write_file" && effect.capability !== "edit_file") {
    factualCompletionFailure("subsession_mutation_capability_out_of_scope");
  }
  if (!input.packet.allowed_tools_and_effects.includes(`${effect.capability}:workspace`)) {
    factualCompletionFailure("subsession_mutation_effect_not_in_packet");
  }
  if (!input.packet.mutation_scope.some((scope) => mutationTargetMatches(effectTarget, scope))) {
    factualCompletionFailure("subsession_mutation_target_out_of_scope");
  }
  return effect;
}

async function validateWorktreeArtifact(
  input: CompletionEvidenceInput,
  effect: Awaited<ReturnType<typeof validateAppliedEffect>> extends infer T ? T : never,
): Promise<string> {
  const child = input.sessionBindings.getBySessionId(input.relation.child_session_id);
  const parent = input.sessionBindings.getBySessionId(input.relation.parent_session_id);
  if (!child || !parent) retryableCompletionFailure("subsession_workspace_binding_unavailable");
  if (child.workspacePath === parent.workspacePath) factualCompletionFailure("subsession_isolated_workspace_missing");
  const authority = resolveSessionWorkspaceAuthority({ binding: child });
  const workspace = mutationWorkspace(input.packet);
  if (authority.kind !== "session_worktree" || authority.branch !== workspace.branch) {
    factualCompletionFailure("subsession_child_worktree_identity_invalid");
  }
  const validated = await validateSessionWorkspaceAuthority({
    authority,
    commandExecutor: createPlatformCommandExecutor(),
  });
  if (!validated.ok) retryableCompletionFailure("subsession_child_worktree_validation_unavailable");
  if (validated.path !== child.workspacePath || validated.path === parent.workspacePath) {
    factualCompletionFailure("subsession_child_worktree_identity_invalid");
  }
  const target = safeRelativeMutationTarget(effect.sanitizedTarget.replace(/^workspace:/u, ""));
  if (!target) factualCompletionFailure("subsession_mutation_target_invalid");
  const absoluteTarget = join(validated.path, target);
  if (isAbsolute(target) || relative(validated.path, absoluteTarget).startsWith("..")) {
    factualCompletionFailure("subsession_mutation_target_invalid");
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(absoluteTarget);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      factualCompletionFailure("subsession_mutation_file_evidence_missing");
    }
    throw error;
  }
  const receipt = effect.receipt!;
  const receiptResult = record(receipt.result);
  if (receiptResult && typeof receiptResult.path === "string" &&
    !mutationTargetMatches(receiptResult.path, target)) {
    factualCompletionFailure("subsession_receipt_target_mismatch");
  }
  if (receiptResult && typeof receiptResult.after_sha256 === "string" &&
    createHash("sha256").update(bytes).digest("hex") !== receiptResult.after_sha256) {
    factualCompletionFailure("subsession_mutation_file_receipt_mismatch");
  }
  return target;
}

function mutationWorkspace(
  packet: DelegationPacket,
): Extract<DelegationPacket["workspace_and_worktree"], { ownership: "session" }> {
  if (packet.execution_mode !== "mutation" || packet.workspace_and_worktree.ownership !== "session") {
    factualCompletionFailure("subsession_mutation_workspace_invalid");
  }
  return packet.workspace_and_worktree;
}

function validateMutationTool(input: CompletionEvidenceInput, capability: string): void {
  const mutationTool = input.toolJournal.list(input.childTurnId).find((item) =>
    item.toolName === capability && item.status === "completed" && resultSucceeded(item.result),
  );
  if (!mutationTool) retryableCompletionFailure("subsession_mutation_tool_evidence_unavailable");
}

function mutationTargetMatches(target: string, scope: string): boolean {
  const normalizedTarget = safeRelativeMutationTarget(target);
  const normalizedScope = safeRelativeMutationTarget(scope);
  if (!normalizedTarget || !normalizedScope) return false;
  return normalizedTarget === normalizedScope ||
    normalizedScope.endsWith("/") && normalizedTarget.startsWith(normalizedScope);
}

function safeRelativeMutationTarget(value: string): string | null {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//u, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) return null;
  return normalized;
}

function resultSucceeded(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return true;
  return (value as Record<string, unknown>).ok !== false;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
