import type { ReviewedManagedProgramState } from "../work-ledger/index.ts";
import type { WorkFrontierDecision } from "./contracts.ts";
import { assemblePromotionCandidates } from "./assemble-promotion-candidates.ts";
import { finalizePromotedWork } from "./finalize-promoted-work.ts";

export function selectNextTaskOrClose(input: {
  turnId: string;
  turnRevision: number;
  program: ReviewedManagedProgramState;
}): WorkFrontierDecision {
  if (input.program.frontier === "promotion_open") {
    const promotionTasks = input.program.tasks.filter(
      (task) => task.task.artifactPolicy.kind === "repository_promotion",
    );
    if (promotionTasks.every((task) => task.status === "accepted")) {
      return { kind: "complete_promotion", product: finalizePromotedWork(input.program) };
    }
    const nextPromotion = promotionTasks.find((task) => task.status === "planned");
    if (!nextPromotion) throw new Error("Authorized promotion has no ready Task");
    return { kind: "select_task", task: nextPromotion };
  }
  if (input.program.frontier !== "implementation_open") {
    throw new Error("Work Frontier requires an executable frontier");
  }
  const implementationTasks = input.program.tasks.filter(
    (task) => task.task.artifactPolicy.kind !== "repository_promotion",
  );
  if (implementationTasks.every((task) => task.status === "accepted")) {
    return {
      kind: "close_frontier",
      promotionAssemblies: assemblePromotionCandidates(input.program),
    };
  }

  const acceptedTaskIds = new Set(
    input.program.tasks
      .filter((task) => task.status === "accepted")
      .map((task) => task.task.ref.id),
  );
  const next = implementationTasks
    .filter((task) => task.status === "planned")
    .filter((task) => task.task.dependencyTaskRefs.every((ref) => acceptedTaskIds.has(ref.id)))
    .sort((left, right) => left.task.executionOrdinal - right.task.executionOrdinal)[0];
  if (!next) throw new Error("Reviewed Work graph has no dependency-ready Task");

  return { kind: "select_task", task: next };
}
