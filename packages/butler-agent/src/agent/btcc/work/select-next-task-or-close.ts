import type { ReviewedManagedProgramState } from "../work-ledger/index.ts";
import {
  canOpenPromotionFrontier,
  nextDependencyReadyTask,
} from "../work-ledger/frontier-readiness.ts";
import type { WorkFrontierDecision } from "./contracts.ts";
import { createPromotionPermit } from "../artifact/index.ts";
import { assemblePromotionCandidates } from "./assemble-promotion-candidates.ts";

export function selectNextTaskOrClose(input: {
  turnId: string;
  turnRevision: number;
  program: ReviewedManagedProgramState;
}): WorkFrontierDecision {
  if (input.program.frontier === "promotion_open") {
    const promotionTasks = input.program.tasks.filter(
      (task) => task.task.artifactPolicy.kind === "repository_promotion",
    );
    if (input.program.tasks.every((task) => task.status === "accepted")) {
      return { kind: "complete_promotion" };
    }
    if (promotionTasks.some((task) => task.status === "promotion_deferred")) {
      const deferredAnchorRef = input.program.promotionDeferral?.anchor.ref;
      if (!deferredAnchorRef) throw new Error("Deferred promotion has no continuation anchor");
      return { kind: "defer_promotion", deferredAnchorRef };
    }
    const next = nextDependencyReadyTask(input.program.tasks);
    if (!next) throw new Error("Authorized promotion graph has no dependency-ready Task");
    return next.status === "result_submitted"
      ? { kind: "revalidate_task", task: next }
      : { kind: "select_task", task: next };
  }
  if (input.program.frontier !== "implementation_open") {
    throw new Error("Work Frontier requires an executable frontier");
  }
  const nextImplementation = nextDependencyReadyTask(
    input.program.tasks,
    (task) => task.task.artifactPolicy.kind !== "repository_promotion",
  );
  if (nextImplementation) {
    return nextImplementation.status === "result_submitted"
      ? { kind: "revalidate_task", task: nextImplementation }
      : { kind: "select_task", task: nextImplementation };
  }
  if (canOpenPromotionFrontier(input.program)) {
    const promotionAssemblies = assemblePromotionCandidates(input.program);
    const promotionPermit = createPromotionPermit({
      programId: input.program.programId,
      currentAuthorityRef: input.program.authorityRef,
      acceptedPlanRef: input.program.plan.ref,
      planningReviewRef: input.program.planningReviewRef,
      assemblies: promotionAssemblies,
    });
    return {
      kind: "close_frontier",
      promotionAssemblies,
      ...(promotionPermit ? { promotionPermit } : {}),
    };
  }

  if (input.program.tasks.every((task) => task.status === "accepted")) {
    return { kind: "close_frontier", promotionAssemblies: [] };
  }
  throw new Error("Reviewed Work graph has no dependency-ready Task or frontier transition");
}
