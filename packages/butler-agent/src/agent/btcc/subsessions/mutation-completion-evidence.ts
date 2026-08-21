import type { GuidedEffectJournalRecord } from "../effects/index.ts";
import type { DelegationPacket } from "./contracts.ts";
import type {
  CompletionEvidenceInput,
  ValidatedStewardWork,
} from "./completion-evidence.ts";
import {
  factualCompletionFailure,
  retryableCompletionFailure,
} from "./completion-evidence-errors.ts";
import {
  mutationTargetWithinScope,
  safeRelativeMutationTarget,
  validateMutationArtifactSet,
} from "./mutation-artifact-evidence.ts";

type AppliedEffect = GuidedEffectJournalRecord & {
  receipt: NonNullable<GuidedEffectJournalRecord["receipt"]>;
};

export async function validateMutationCompletion(
  input: CompletionEvidenceInput,
  work: ValidatedStewardWork,
): Promise<{
  summary: string;
  acceptanceEvidence: string[];
  changedArtifacts: string[];
  reportEvidenceAnchors: string[];
}> {
  validateCurrentMutationPlan(input, work);
  const evidence = await validateAppliedMutationEvidence(input, work, true);
  const workspace = mutationWorkspace(input.packet);
  return {
    summary: work.latestDisposition!.summary,
    acceptanceEvidence: [
      `Work ${work.workId} completed with accepted plan, result, and completion reviews.`,
      `${evidence.effects.length} applied mutation receipt(s) verified across ${evidence.targets.length} final artifact(s).`,
      `Applied receipts: ${evidence.effects.map((effect) => effect.receipt.receiptId).join("; ")}.`,
      `Session-owned worktree ${workspace.branch} contains the verified final artifacts.`,
    ],
    changedArtifacts: evidence.targets,
    reportEvidenceAnchors: [
      ...evidence.targets,
      ...evidence.effects.map((effect) => effect.receipt.receiptId),
    ],
  };
}

export async function validateBlockedMutationEvidence(
  input: CompletionEvidenceInput,
  work: ValidatedStewardWork,
): Promise<{
  acceptanceEvidence: string[];
  changedArtifacts: string[];
  reportEvidenceAnchors: string[];
}> {
  if (
    !input.rootWorkId ||
    work.workId !== input.rootWorkId ||
    work.sessionId !== input.relation.child_session_id ||
    work.scope.kind !== "session" ||
    work.scope.sessionId !== input.relation.child_session_id ||
    work.origin.turnId !== input.childTurnId ||
    work.objective !== input.packet.objective
  ) {
    factualCompletionFailure("subsession_root_work_identity_mismatch");
  }
  const evidence = await validateAppliedMutationEvidence(input, work, false);
  if (evidence.effects.length === 0) {
    return {
      acceptanceEvidence: [],
      changedArtifacts: [],
      reportEvidenceAnchors: [],
    };
  }
  return {
    acceptanceEvidence: [
      `The blocked Work preserved ${evidence.effects.length} verified applied mutation receipt(s).`,
      `Applied receipts: ${evidence.effects.map((effect) => effect.receipt.receiptId).join("; ")}.`,
      `${evidence.targets.length} final artifact(s) remain in the isolated Steward worktree for review.`,
    ],
    changedArtifacts: evidence.targets,
    reportEvidenceAnchors: [
      ...evidence.targets,
      ...evidence.effects.map((effect) => effect.receipt.receiptId),
    ],
  };
}

function validateCurrentMutationPlan(
  input: CompletionEvidenceInput,
  work: ValidatedStewardWork,
): void {
  const mutationActions = work.currentPlan!.actions.filter((action) => action.effect);
  if (mutationActions.length === 0) {
    factualCompletionFailure("subsession_mutation_action_missing");
  }
  for (const action of mutationActions) {
    const progress = work.actionProgress.find(
      (item) => item.actionKey === action.actionKey,
    );
    if (!progress || progress.status !== "done") {
      factualCompletionFailure("subsession_mutation_action_not_done");
    }
    if (
      action.effect!.capability !== "write_file" &&
      action.effect!.capability !== "edit_file"
    ) {
      factualCompletionFailure("subsession_mutation_capability_out_of_scope");
    }
    if (!mutationTargetWithinScope(action.effect!.target, input.packet.mutation_scope)) {
      factualCompletionFailure("subsession_mutation_target_out_of_scope");
    }
  }
}

async function validateAppliedMutationEvidence(
  input: CompletionEvidenceInput,
  work: ValidatedStewardWork,
  requireApplied: boolean,
): Promise<{ effects: AppliedEffect[]; targets: string[] }> {
  mutationWorkspace(input.packet);
  const effects = await input.effectJournal.listForWork(work.workId, 50);
  if (effects.some((effect) =>
    effect.status === "prepared" ||
    effect.status === "dispatching" ||
    effect.status === "uncertain",
  )) {
    retryableCompletionFailure("subsession_mutation_effect_set_unsettled");
  }
  const applied = effects.filter(
    (effect): effect is AppliedEffect => effect.status === "applied" && Boolean(effect.receipt),
  );
  if (requireApplied && applied.length === 0) {
    factualCompletionFailure("subsession_applied_effect_missing");
  }
  if (applied.length === 0) return { effects: [], targets: [] };

  const mutations = applied.map((effect) => {
    validateEffectScope(input, work, effect);
    return {
      capability: effect.capability,
      sanitizedTarget: effect.sanitizedTarget,
      receipt: effect.receipt,
      mutationTool: validateMutationTool(input, effect),
    };
  });
  const requiredFinalTargets = new Set(
    work.currentPlan!.actions.flatMap((action) => {
      const target = action.effect
        ? safeRelativeMutationTarget(action.effect.target)
        : null;
      return target && !target.endsWith("/") ? [target] : [];
    }),
  );
  const targets = await validateMutationArtifactSet(
    input,
    mutations,
    requiredFinalTargets,
  );
  return { effects: applied, targets };
}

function validateEffectScope(
  input: CompletionEvidenceInput,
  work: ValidatedStewardWork,
  effect: AppliedEffect,
): void {
  if (effect.workId !== work.workId) {
    factualCompletionFailure("subsession_applied_effect_identity_mismatch");
  }
  if (effect.capability !== "write_file" && effect.capability !== "edit_file") {
    factualCompletionFailure("subsession_mutation_capability_out_of_scope");
  }
  if (!input.packet.allowed_tools_and_effects.includes(`${effect.capability}:workspace`)) {
    factualCompletionFailure("subsession_mutation_effect_not_in_packet");
  }
  const effectTarget = effect.sanitizedTarget.replace(/^workspace:/u, "");
  const batchTarget = effect.capability === "edit_file" &&
    /^batch:[a-f0-9]{64}$/u.test(effectTarget);
  if (!batchTarget && !mutationTargetWithinScope(effectTarget, input.packet.mutation_scope)) {
    factualCompletionFailure("subsession_mutation_target_out_of_scope");
  }
}

function validateMutationTool(
  input: CompletionEvidenceInput,
  effect: AppliedEffect,
) {
  const tool = input.toolJournal.list(input.childTurnId).find((item) => {
    if (
      item.toolName !== effect.capability ||
      item.status !== "completed" ||
      !resultSucceeded(item.result)
    ) return false;
    const effectReceipt = record(record(item.result)?.effect_receipt);
    return effectReceipt?.receipt_id === effect.receipt.receiptId &&
      effectReceipt?.capability === effect.capability &&
      effectReceipt?.target === effect.sanitizedTarget;
  });
  if (!tool) {
    retryableCompletionFailure("subsession_mutation_tool_evidence_unavailable");
  }
  return tool;
}

function mutationWorkspace(
  packet: DelegationPacket,
): Extract<DelegationPacket["workspace_and_worktree"], { ownership: "session" }> {
  if (
    packet.execution_mode !== "mutation" ||
    packet.workspace_and_worktree.ownership !== "session"
  ) {
    factualCompletionFailure("subsession_mutation_workspace_invalid");
  }
  return packet.workspace_and_worktree;
}

function resultSucceeded(value: unknown): boolean {
  return record(value)?.ok !== false;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
