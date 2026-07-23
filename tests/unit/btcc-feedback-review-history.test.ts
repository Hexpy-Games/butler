import { expect, test } from "bun:test";
import { projectPriorTaskReviewFindings } from
  "../../packages/butler-agent/src/agent/btcc/conception/prior-task-review-findings.ts";
import type { TaskReviewProduct } from
  "../../packages/butler-agent/src/agent/btcc/review/index.ts";
import type { ManagedTaskState } from
  "../../packages/butler-agent/src/agent/btcc/work-ledger/index.ts";

const ref = (id: string) => ({ id, sha256: `${id}-sha` });

test("Feedback Conception receives prior failed findings but not its current source", () => {
  const prior = review("prior-review", "prior-finding", "Repeated aggregation drift");
  const current = review("current-review", "current-finding", "Repeated aggregation drift");
  const task = {
    attempts: [
      { attemptRecord: { ref: ref("attempt-1") }, review: prior },
      { attemptRecord: { ref: ref("attempt-2") }, review: current },
    ],
  } as ManagedTaskState;

  expect(projectPriorTaskReviewFindings(task, current.review.ref)).toEqual([{
    attemptRef: ref("attempt-1"),
    reviewRef: ref("prior-review"),
    findings: [{
      findingRef: ref("prior-finding"),
      category: "implementation_nonconformance",
      statement: "Repeated aggregation drift",
    }],
  }]);
});

function review(
  reviewId: string,
  findingId: string,
  statement: string,
): TaskReviewProduct {
  return {
    kind: "task_review",
    review: {
      ref: ref(reviewId),
      verdict: "not_passed",
      findings: [{
        ref: ref(findingId),
        category: "implementation_nonconformance",
        statement,
      }],
    },
  } as TaskReviewProduct;
}
