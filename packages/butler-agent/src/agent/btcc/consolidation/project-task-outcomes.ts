import type { ManagedTaskState } from "../work-ledger/index.ts";

export function projectTaskOutcomes(tasks: ManagedTaskState[]) {
  return tasks.map((task) => {
    const result = task.currentResult?.result;
    const review = task.currentReview?.review;
    if (!result || !review || review.verdict !== "passed") {
      throw new Error("Consolidation requires an accepted result and passed Review per Task");
    }
    return {
      task: task.task,
      status: task.status,
      result: {
        ref: result.ref,
        kind: result.kind,
        resultSummary: result.resultSummary,
        unresolvedConditionRefs: result.unresolvedConditionRefs,
        artifactRevisionRefs: result.artifactRevisionRefs,
        effectReceiptRefs: result.effectReceiptRefs,
        ...(result.kind === "workspace_artifact"
          ? { workspaceRevisionRef: result.workspaceRevisionRef }
          : {}),
        ...(result.kind === "repository_promotion"
          ? {
              promotionReceiptRef: result.promotionReceiptRef,
              promotedSnapshotRef: result.promotedSnapshotRef,
            }
          : {}),
      },
      review: {
        ref: review.ref,
        verdict: review.verdict,
        criterionVerdicts: review.criterionVerdicts,
        observations: review.observations,
      },
    };
  });
}
