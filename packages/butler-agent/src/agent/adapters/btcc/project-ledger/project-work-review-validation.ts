import {
  decodeChild,
  type ProjectWorkChild,
} from "./project-work-child-codec.ts";
import type { ProjectWorkManifest } from "./project-work-codec.ts";
import { projectWorkRecordId } from "./project-work-json.ts";

type ReviewChild = Extract<
  ProjectWorkChild,
  { schema: "butler.btcc-project-work-review.v1" }
>;

export function validateProjectWorkReview(
  child: ReviewChild | undefined,
  subject: "plan" | "result" | "completion",
  manifest: ProjectWorkManifest,
  bodyForId: (id: string) => string,
): void {
  if (!child) return;
  const review = child.review;
  if (review.subject !== subject) invalid();
  if (
    (subject === "plan" && !review.boundPlanRevisionId) ||
    (subject === "result" && review.boundPlanRevisionId !== undefined) ||
    (subject === "plan" && review.boundResultRefs.length !== 0) ||
    (subject === "completion" && !review.boundResultReviewRevisionId) ||
    (subject !== "completion" &&
      review.boundResultReviewRevisionId !== undefined)
  )
    invalid();
  if (
    child.operationIdentity.kind === "mutation_call" &&
    review.reviewRevisionId !==
      projectWorkRecordId("review", child.operationIdentity.id)
  )
    invalid();
  if (review.boundPlanRevisionId) {
    const boundPlan = decodeChild(bodyForId(review.boundPlanRevisionId), {
      schema: "butler.btcc-project-work-plan.v1",
      workId: manifest.workId,
      recordId: review.boundPlanRevisionId,
    });
    validateProjectWorkPlanIdentity(boundPlan);
  }
  if (
    subject !== "plan" &&
    (review.boundResultRefs.length !== child.boundResultSequence ||
      !review.boundActionProgress)
  )
    invalid();
  if (
    subject !== "plan" &&
    JSON.stringify(review.boundResultRefs) !==
      JSON.stringify(
        manifest.resultRefs
          .slice(0, child.boundResultSequence)
          .map((item) => item.resultRef),
      )
  )
    invalid();
  if (review.boundResultReviewRevisionId) {
    const boundChild = decodeChild(
      bodyForId(review.boundResultReviewRevisionId),
      {
        schema: "butler.btcc-project-work-review.v1",
        workId: manifest.workId,
        recordId: review.boundResultReviewRevisionId,
      },
    );
    if (
      boundChild.review.subject !== "result" ||
      boundChild.review.verdict !== "accept" ||
      boundChild.review.revision >= review.revision ||
      boundChild.boundResultSequence !== child.boundResultSequence ||
      JSON.stringify(boundChild.review.boundResultRefs) !==
        JSON.stringify(review.boundResultRefs) ||
      !sameActionStates(
        boundChild.review.boundActionProgress,
        review.boundActionProgress,
      )
    )
      invalid();
    validateProjectWorkReview(boundChild, "result", manifest, bodyForId);
  }
}

function sameActionStates(
  left: Array<{ actionKey: string; status: string }> | undefined,
  right: Array<{ actionKey: string; status: string }> | undefined,
): boolean {
  if (!left || !right) return false;
  return left.length === right.length && left.every((action, index) => {
    const candidate = right[index];
    return candidate?.actionKey === action.actionKey &&
      candidate.status === action.status;
  });
}

export function validateProjectWorkPlanIdentity(
  child: Extract<
    ProjectWorkChild,
    { schema: "butler.btcc-project-work-plan.v1" }
  >,
): void {
  if (
    child.operationIdentity.kind === "mutation_call" &&
    (child.operationIdentity.mutationCallId !== child.operationIdentity.id ||
      child.plan.planRevisionId !==
        projectWorkRecordId("plan", child.operationIdentity.id))
  )
    invalid();
}

function invalid(): never {
  throw new Error("project_work_managed_record_invalid");
}
