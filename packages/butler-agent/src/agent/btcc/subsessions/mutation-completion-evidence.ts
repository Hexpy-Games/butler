import type {
  DelegationPacket,
} from "./contracts.ts";
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
  validateMutationArtifacts,
} from "./mutation-artifact-evidence.ts";

export async function validateMutationCompletion(
  input: CompletionEvidenceInput,
  work: ValidatedStewardWork,
): Promise<{
  summary: string;
  acceptanceEvidence: string[];
  changedArtifacts: string[];
  reportEvidenceAnchors: string[];
}> {
  const action = mutationAction(work);
  const effect = await validateAppliedEffect(input, work, action);
  const mutationTool = validateMutationTool(input, effect);
  const targets = await validateMutationArtifacts(
    input,
    {
      capability: effect.capability,
      sanitizedTarget: effect.sanitizedTarget,
      receipt: effect.receipt!,
    },
    mutationTool,
  );
  const workspace = mutationWorkspace(input.packet);
  return {
    summary: work.latestDisposition!.summary,
    acceptanceEvidence: [
      `Work ${work.workId} completed with accepted plan, result, and completion reviews.`,
      `Applied ${effect.capability} receipt ${effect.receipt!.receiptId} verified for ${targets.length} artifact(s).`,
      `Session-owned worktree ${workspace.branch} contains the applied artifacts.`,
    ],
    changedArtifacts: targets,
    reportEvidenceAnchors: [...targets, effect.receipt!.receiptId],
  };
}

function mutationAction(work: ValidatedStewardWork): NonNullable<
  NonNullable<typeof work.currentPlan>["actions"][number]
> & {
  effect: NonNullable<
    NonNullable<typeof work.currentPlan>["actions"][number]["effect"]
  >;
} {
  const expectedActions = work.currentPlan!.actions.filter(
    (action) => action.effect,
  );
  if (expectedActions.length !== 1) {
    factualCompletionFailure("subsession_mutation_action_cardinality_invalid");
  }
  const action = expectedActions[0]!;
  const progress = work.actionProgress.find(
    (item) => item.actionKey === action.actionKey,
  );
  if (!progress || progress.status !== "done") {
    factualCompletionFailure("subsession_mutation_action_not_done");
  }
  return action as typeof action & {
    effect: NonNullable<typeof action.effect>;
  };
}

async function validateAppliedEffect(
  input: CompletionEvidenceInput,
  work: ValidatedStewardWork,
  action: ReturnType<typeof mutationAction>,
) {
  const effects = await input.effectJournal.listForWork(work.workId, 20);
  const applied = effects.filter(
    (effect) => effect.status === "applied" && effect.receipt,
  );
  if (applied.length !== 1) {
    factualCompletionFailure("subsession_applied_effect_cardinality_invalid");
  }
  const effect = applied[0]!;
  const effectTarget = effect.sanitizedTarget.replace(/^workspace:/u, "");
  if (
    effect.workId !== work.workId ||
    effect.capability !== action.effect.capability ||
    (effect.actionKey !== action.actionKey &&
      effect.actionKey !== "accepted-plan") ||
    !effectIdentityMatchesPlan(
      effect.capability,
      effectTarget,
      action.effect.target,
    )
  ) {
    factualCompletionFailure("subsession_applied_effect_identity_mismatch");
  }
  if (effect.capability !== "write_file" && effect.capability !== "edit_file") {
    factualCompletionFailure("subsession_mutation_capability_out_of_scope");
  }
  if (
    !input.packet.allowed_tools_and_effects.includes(
      `${effect.capability}:workspace`,
    )
  ) {
    factualCompletionFailure("subsession_mutation_effect_not_in_packet");
  }
  if (
    !mutationTargetWithinScope(
      action.effect.target,
      input.packet.mutation_scope,
    )
  ) {
    factualCompletionFailure("subsession_mutation_target_out_of_scope");
  }
  return effect;
}

function validateMutationTool(
  input: CompletionEvidenceInput,
  effect: Awaited<ReturnType<typeof validateAppliedEffect>>,
) {
  const tool = input.toolJournal.list(input.childTurnId).find((item) => {
    if (
      item.toolName !== effect.capability ||
      item.status !== "completed" ||
      !resultSucceeded(item.result)
    )
      return false;
    const effectReceipt = record(record(item.result)?.effect_receipt);
    return (
      effectReceipt?.receipt_id === effect.receipt?.receiptId &&
      effectReceipt?.capability === effect.capability &&
      effectReceipt?.target === effect.sanitizedTarget
    );
  });
  if (!tool)
    retryableCompletionFailure("subsession_mutation_tool_evidence_unavailable");
  return tool;
}

function effectIdentityMatchesPlan(
  capability: string,
  effectTarget: string,
  planTarget: string,
): boolean {
  return capability === "edit_file" &&
    /^batch:[a-f0-9]{64}$/u.test(effectTarget)
    ? safeRelativeMutationTarget(planTarget) !== null
    : effectTarget === planTarget;
}

function mutationWorkspace(
  packet: DelegationPacket,
): Extract<
  DelegationPacket["workspace_and_worktree"],
  { ownership: "session" }
> {
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
    ? (value as Record<string, unknown>)
    : null;
}
