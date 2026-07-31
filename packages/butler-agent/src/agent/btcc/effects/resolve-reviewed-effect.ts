import type {
  EffectAdapter,
  ExecuteGuidedEffectInput,
  GuidedEffectError,
} from "./contracts.ts";

export type ResolvedReviewedEffect<TNormalizedInput> = {
  workId: string;
  planRevisionId: string;
  actionKey: string;
  capability: string;
  normalizedTarget: string;
  sanitizedTarget: string;
  normalizedInput: TNormalizedInput;
};

export function resolveReviewedEffect<TNormalizedInput, TResult>(
  input: ExecuteGuidedEffectInput<TNormalizedInput, TResult>,
):
  | { ok: true; value: ResolvedReviewedEffect<TNormalizedInput> }
  | { ok: false; error: GuidedEffectError } {
  const plan = input.work.currentPlan;
  if (!plan) {
    return rejected(
      "effect_work_plan_missing",
      "The current Work has no Plan to authorize this effect.",
    );
  }
  const review = input.work.latestPlanReview;
  if (
    !review ||
    review.verdict !== "accept" ||
    review.boundPlanRevisionId !== plan.planRevisionId
  ) {
    return rejected(
      "effect_plan_review_required",
      "The current Plan revision requires an accepted Plan Review before effects.",
    );
  }
  try {
    requiredText(input.adapter.capability, "adapter capability");
    const normalizedTarget = requiredText(
      input.adapter.normalizeTarget(input.target),
      "normalized target",
    );
    const matches = matchingActions(
      plan.actions,
      input.adapter,
      normalizedTarget,
    );
    if (matches.length === 0) {
      return rejected(
        "effect_action_not_found",
        "No action in the reviewed current Plan matches this capability and exact target.",
      );
    }
    if (matches.length !== 1) {
      return rejected(
        "effect_action_ambiguous",
        "More than one action in the reviewed current Plan matches this effect.",
      );
    }
    const normalizedInput = input.adapter.normalizeInput(input.input);
    const sanitizedTarget = requiredText(
      input.adapter.sanitizeTarget(normalizedTarget),
      "sanitized target",
    );
    return {
      ok: true,
      value: {
        workId: input.work.workId,
        planRevisionId: plan.planRevisionId,
        actionKey: matches[0]!.actionKey,
        capability: input.adapter.capability,
        normalizedTarget,
        sanitizedTarget,
        normalizedInput,
      },
    };
  } catch (error) {
    return rejected(
      "effect_request_invalid",
      error instanceof Error ? error.message : "The effect request is invalid.",
    );
  }
}

function matchingActions<TNormalizedInput, TResult>(
  actions: NonNullable<ExecuteGuidedEffectInput<TNormalizedInput, TResult>[
    "work"
  ]["currentPlan"]>["actions"],
  adapter: EffectAdapter<TNormalizedInput, TResult>,
  normalizedTarget: string,
) {
  return actions.filter((action) => {
    if (action.effect?.capability !== adapter.capability) return false;
    return adapter.normalizeTarget(action.effect.target) === normalizedTarget;
  });
}

function rejected(
  code: GuidedEffectError["code"],
  message: string,
): { ok: false; error: GuidedEffectError } {
  return { ok: false, error: { code, message, recoverable: true } };
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Effect ${label} must not be empty`);
  return normalized;
}
