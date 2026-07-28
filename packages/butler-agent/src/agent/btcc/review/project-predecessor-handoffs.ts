import type { ContentRef } from "../core/index.ts";
import type { ReviewedManagedProgramState } from "../work-ledger/index.ts";

export type AcceptedPredecessorHandoff = ReturnType<
  typeof projectAcceptedPredecessorHandoffs
>[number];

export function projectAcceptedPredecessorHandoffs(
  program: ReviewedManagedProgramState,
) {
  return program.currentTask.task.dependencyTaskRefs.map((dependencyRef) => {
    const predecessor = program.tasks.find((candidate) =>
      sameRef(candidate.task.ref, dependencyRef));
    if (
      !predecessor || predecessor.status !== "accepted" ||
      !predecessor.currentResult ||
      predecessor.currentReview?.review.verdict !== "passed"
    ) {
      throw new Error("Task Review requires every direct predecessor to be accepted");
    }
    return {
      task: predecessor.task,
      result: predecessor.currentResult.result,
      review: predecessor.currentReview.review,
    };
  });
}

function sameRef(left: ContentRef, right: ContentRef): boolean {
  return left.id === right.id && left.sha256 === right.sha256;
}
