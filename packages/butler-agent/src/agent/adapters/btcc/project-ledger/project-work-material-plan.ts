import type { DurableWorkPlan } from "../../../btcc/work/index.ts";
import {
  boundedArray,
  exactKeys,
  isoRequired,
  object,
  positiveRevision,
  stringArray,
  textRequired,
} from "./project-work-json.ts";

export type ProjectWorkMaterialPlan = Omit<DurableWorkPlan, "governingRefs"> & {
  governingRefs: string[];
};

export function captureMaterialPlan(
  plan: DurableWorkPlan,
): ProjectWorkMaterialPlan {
  return {
    planRevisionId: plan.planRevisionId,
    revision: plan.revision,
    objective: plan.objective,
    governingRefs: plan.governingRefs ?? [],
    actions: plan.actions,
    checks: plan.checks,
    originTurnId: plan.originTurnId,
    createdAt: plan.createdAt,
  };
}

export function validateMaterialPlan(
  value: unknown,
): asserts value is ProjectWorkMaterialPlan {
  const plan = object(value);
  exactKeys(plan, [
    "planRevisionId",
    "revision",
    "objective",
    "governingRefs",
    "actions",
    "checks",
    "originTurnId",
    "createdAt",
  ]);
  textRequired(plan.planRevisionId);
  positiveRevision(plan.revision);
  textRequired(plan.objective);
  stringArray(plan.governingRefs);
  boundedArray(plan.actions).forEach((value) => {
    const action = object(value);
    exactKeys(
      action,
      ["actionKey", "description", "dependencyKeys"],
      ["effect"],
    );
    textRequired(action.actionKey);
    textRequired(action.description);
    stringArray(action.dependencyKeys);
    if (action.effect !== undefined) {
      const effect = object(action.effect);
      exactKeys(effect, ["capability", "target"]);
      textRequired(effect.capability);
      textRequired(effect.target);
    }
  });
  stringArray(plan.checks);
  textRequired(plan.originTurnId);
  isoRequired(plan.createdAt);
}
