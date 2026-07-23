import type { ContentRef } from "../core/index.ts";
import type { ManagedTaskState } from "../work-ledger/index.ts";

export type PriorTaskReviewFindingProjection = {
  attemptRef: ContentRef;
  reviewRef: ContentRef;
  findings: Array<{
    findingRef: ContentRef;
    category: string;
    statement: string;
  }>;
};

export function projectPriorTaskReviewFindings(
  task: ManagedTaskState,
  currentReviewRef?: ContentRef,
): PriorTaskReviewFindingProjection[] {
  return task.attempts.flatMap((attempt) => {
    const product = attempt.review;
    if (
      !product ||
      product.review.verdict !== "not_passed" ||
      sameRef(product.review.ref, currentReviewRef)
    ) {
      return [];
    }
    return [{
      attemptRef: attempt.attemptRecord.ref,
      reviewRef: product.review.ref,
      findings: product.review.findings.map((finding) => ({
        findingRef: finding.ref,
        category: finding.category,
        statement: finding.statement,
      })),
    }];
  });
}

function sameRef(left: ContentRef, right?: ContentRef): boolean {
  return Boolean(
    right &&
      left.id === right.id &&
      left.sha256 === right.sha256,
  );
}
