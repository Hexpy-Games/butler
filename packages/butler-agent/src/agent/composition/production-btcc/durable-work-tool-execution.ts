import type {
  DurableWorkActionStatus,
  DurableWorkActionUpdate,
  DurableWorkPlanAction,
  DurableWorkService,
  DurableWorkView,
  WorkStage,
  WorkTurnScope,
} from "../../btcc/durable-work/index.ts";
import { WorkStageTransitionError, unresolvedWorkActionKeys } from
  "../../btcc/durable-work/index.ts";
import type { DurableWorkToolName } from "./durable-work-tool-definitions.ts";

type WorkToolInput = {
  service: DurableWorkService;
  scope: WorkTurnScope;
  mutationCallId: string;
  name: DurableWorkToolName;
  args: Record<string, unknown>;
};

export async function executeDurableWorkTool(
  input: WorkToolInput,
): Promise<Record<string, unknown>> {
  try {
    const view = input.name === "replace_work_plan"
      ? await input.service.replacePlan(decodePlan(input))
      : input.name === "record_work_checkpoint"
        ? await input.service.recordCheckpoint(decodeCheckpoint(input))
        : await input.service.recordReview(decodeReview(input));
    return { ok: true, work: workToolView(view) };
  } catch (error) {
    const current = await input.service.loadContext(input.scope).catch(() => null);
    if (error instanceof WorkStageTransitionError) {
      return {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          current_stage: error.currentStage,
          attempted_stage: error.attemptedStage,
          allowed_next_stages: error.allowedNextStages,
        },
        ...(current ? { work: workToolView(current.work) } : {}),
      };
    }
    return {
      ok: false,
      error: {
        code: "work_update_rejected",
        message: error instanceof Error ? error.message : "Work update was rejected.",
      },
      ...(current ? { work: workToolView(current.work) } : {}),
    };
  }
}

function decodePlan(input: WorkToolInput) {
  const actions = arrayValue(input.args.actions, "actions").map((value, index) => {
    const action = recordValue(value, `actions[${index}]`);
    const actionKey = stringValue(action.action_key, `actions[${index}].action_key`);
    const effectValue = action.effect;
    const effect = effectValue === undefined
      ? undefined
      : decodeEffect(recordValue(effectValue, `actions[${index}].effect`), index);
    return {
      actionKey,
      description: optionalStringValue(action.description) ?? actionKey,
      dependencyKeys: optionalStringArray(
        action.dependency_keys,
        `actions[${index}].dependency_keys`,
      ),
      ...(effect ? { effect } : {}),
    } satisfies DurableWorkPlanAction;
  });
  return {
    ...input.scope,
    mutationCallId: input.mutationCallId,
    startNew: booleanValue(input.args.start_new, false, "start_new"),
    objective: stringValue(input.args.objective, "objective"),
    governingRefs: optionalStringArray(input.args.governing_refs, "governing_refs"),
    actions,
    checks: optionalStringArray(input.args.checks, "checks"),
  };
}

function decodeCheckpoint(input: WorkToolInput) {
  const nextStage = decodeWorkStage(input.args.next_stage);
  return {
    ...input.scope,
    mutationCallId: input.mutationCallId,
    ...(nextStage ? { nextStage } : {}),
    actionUpdates: decodeActionUpdates(input.args.action_updates),
    ...(optionalStringValue(input.args.public_summary)
      ? { publicSummary: optionalStringValue(input.args.public_summary)! }
      : {}),
    ...(optionalStringValue(input.args.next_step)
      ? { nextStep: optionalStringValue(input.args.next_step)! }
      : {}),
  };
}

function decodeWorkStage(value: unknown): WorkStage | undefined {
  const nextStage = optionalStringValue(value);
  if (nextStage && !WORK_STAGE_SET.has(nextStage)) {
    throw new Error(`Unsupported Work stage: ${nextStage}`);
  }
  return nextStage as WorkStage | undefined;
}

function decodeReview(input: WorkToolInput) {
  const subject = stringValue(input.args.subject, "subject");
  const verdict = stringValue(input.args.verdict, "verdict");
  const nextStage = decodeWorkStage(input.args.next_stage);
  if (subject !== "plan" && subject !== "result" && subject !== "completion") {
    throw new Error(`Unsupported Work review subject: ${subject}`);
  }
  if (verdict !== "accept" && verdict !== "revise" && verdict !== "partial") {
    throw new Error(`Unsupported Work review verdict: ${verdict}`);
  }
  return {
    ...input.scope,
    mutationCallId: input.mutationCallId,
    subject: subject as "plan" | "result" | "completion",
    verdict: verdict as "accept" | "revise" | "partial",
    ...(nextStage ? { nextStage } : {}),
    actionUpdates: decodeActionUpdates(input.args.action_updates),
    summary: stringValue(input.args.summary, "summary"),
    corrections: optionalStringArray(input.args.corrections, "corrections"),
  };
}

function decodeEffect(
  effect: Record<string, unknown>,
  actionIndex: number,
): DurableWorkPlanAction["effect"] {
  return {
    capability: stringValue(effect.capability, `actions[${actionIndex}].effect.capability`),
    target: stringValue(effect.target, `actions[${actionIndex}].effect.target`),
  };
}

function workToolView(work: DurableWorkView): Record<string, unknown> {
  const unresolved = unresolvedWorkActionKeys(work.actionProgress);
  const currentPlanAccepted = work.latestPlanReview?.verdict === "accept" &&
    work.latestPlanReview.boundPlanRevisionId === work.currentPlan?.planRevisionId;
  const currentResultReview = currentAcceptedResultReview(work);
  const completionAccepted = work.latestCompletionValidation?.verdict === "accept" &&
    work.latestCompletionValidation.boundPlanRevisionId ===
      work.currentPlan?.planRevisionId &&
    work.latestCompletionValidation.boundResultReviewRevisionId ===
      currentResultReview?.reviewRevisionId &&
    sameActionProgress(
      work.latestCompletionValidation.boundActionProgress,
      work.actionProgress,
    ) &&
    sameResultRefs(work.latestCompletionValidation.boundResultRefs, work);
  const completionBlockers = [
    ...(currentPlanAccepted ? [] : ["current_plan_review_required"]),
    ...(currentResultReview ? [] : ["current_result_review_required"]),
    ...(completionAccepted ? [] : ["completion_validation_required"]),
    ...(unresolved.length > 0 ? ["unresolved_actions"] : []),
    ...((work.effectBlockers?.length ?? 0) > 0
      ? ["effect_reconciliation_required"]
      : []),
  ];
  return {
    work_id: work.workId,
    status: work.status,
    current_stage: work.currentStage ?? null,
    allowed_next_stages: work.allowedNextStages,
    actions: work.currentPlan?.actions.map((action) => {
      const progress = work.actionProgress.find((item) =>
        item.actionKey === action.actionKey);
      return {
        action_key: action.actionKey,
        status: progress?.status ?? "pending",
      };
    }) ?? [],
    unresolved_action_keys: unresolved,
    completion_blockers: completionBlockers,
    latest_plan_review: work.latestPlanReview?.verdict ?? null,
    latest_result_review: work.latestResultReview?.verdict ?? null,
    latest_completion_validation: work.latestCompletionValidation?.verdict ?? null,
  };
}

function currentAcceptedResultReview(work: DurableWorkView) {
  const review = work.latestResultReview;
  return review?.verdict === "accept" && sameResultRefs(review.boundResultRefs, work)
    ? review
    : undefined;
}

function sameResultRefs(
  boundResultRefs: string[],
  work: Pick<DurableWorkView, "resultRefs">,
): boolean {
  return boundResultRefs.length === work.resultRefs.length &&
    boundResultRefs.every((resultRef, index) =>
      resultRef === work.resultRefs[index]?.resultRef,
    );
}

function sameActionProgress(
  bound: DurableWorkView["actionProgress"] | undefined,
  current: DurableWorkView["actionProgress"],
): boolean {
  return bound?.length === current.length && bound.every((action, index) => {
    const candidate = current[index];
    return candidate?.actionKey === action.actionKey &&
      candidate.status === action.status && candidate.note === action.note;
  });
}

function decodeActionUpdates(value: unknown): DurableWorkActionUpdate[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("Work update requires action_updates to be an array");
  }
  return value.map((item, index) => {
    const update = recordValue(item, `action_updates[${index}]`);
    const status = stringValue(update.status, `action_updates[${index}].status`);
    if (!WORK_ACTION_STATUS_SET.has(status)) {
      throw new Error(`Unsupported Work action status: ${status}`);
    }
    const note = optionalStringValue(update.note);
    return {
      actionKey: stringValue(update.action_key, `action_updates[${index}].action_key`),
      status: status as DurableWorkActionStatus,
      ...(note ? { note } : {}),
    };
  });
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Work update requires ${field}`);
  }
  return value.trim();
}

function optionalStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function arrayValue(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Work update requires at least one ${field} entry`);
  }
  return value;
}

function optionalStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Work update requires ${field} to be an array`);
  return value.map((item, index) => stringValue(item, `${field}[${index}]`));
}

function recordValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Work update requires ${field} to be an object`);
  }
  return value as Record<string, unknown>;
}

function booleanValue(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`Work update requires ${field} to be boolean`);
  return value;
}

const WORK_STAGE_SET = new Set<string>([
  "conception",
  "planning",
  "execution",
  "review",
  "validation",
  "reporting",
]);

const WORK_ACTION_STATUS_SET = new Set<string>([
  "pending",
  "active",
  "done",
  "blocked",
  "skipped",
]);
