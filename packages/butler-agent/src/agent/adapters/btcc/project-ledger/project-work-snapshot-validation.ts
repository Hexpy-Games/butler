import {
  allowedNextWorkStages,
  type DurableWorkView,
} from "../../../btcc/work/index.ts";
import {
  decodeChild,
  type ProjectWorkChild,
} from "./project-work-child-codec.ts";
import type { ProjectWorkManifest } from "./project-work-codec.ts";
import { projectWorkRecordId } from "./project-work-json.ts";
import { materialSnapshotMatchesView } from "./project-work-material-snapshot.ts";
import {
  validateProjectWorkPlanIdentity,
  validateProjectWorkReview,
} from "./project-work-review-validation.ts";

export function hydrateProjectWorkManifest(
  manifest: ProjectWorkManifest,
  bodyForId: (id: string) => string,
): DurableWorkView {
  const child = <T extends ProjectWorkChild["schema"]>(
    schema: T,
    id?: string,
  ) =>
    id
      ? decodeChild(bodyForId(id), {
          schema,
          workId: manifest.workId,
          recordId: id,
        })
      : undefined;
  const planChild = child(
    "butler.btcc-project-work-plan.v1",
    manifest.currentPlanRevisionId,
  );
  const checkpointChild = child(
    "butler.btcc-project-work-checkpoint.v1",
    manifest.latestCheckpointRevisionId,
  );
  const planReviewChild = child(
    "butler.btcc-project-work-review.v1",
    manifest.latestPlanReviewRevisionId,
  );
  const resultReviewChild = child(
    "butler.btcc-project-work-review.v1",
    manifest.latestResultReviewRevisionId,
  );
  const completionChild = child(
    "butler.btcc-project-work-review.v1",
    manifest.latestCompletionValidationRevisionId,
  );
  const dispositionChild = child(
    "butler.btcc-project-work-disposition.v1",
    manifest.latestDispositionRevisionId,
  );
  const resultChildren = manifest.resultRefs.map(
    (ref) =>
      child("butler.btcc-project-work-result-reference.v1", ref.resultRef)!,
  );
  validatePointers(
    manifest,
    {
      planChild,
      checkpointChild,
      planReviewChild,
      resultReviewChild,
      completionChild,
      dispositionChild,
      resultChildren,
    },
    bodyForId,
  );
  for (const bindingRef of manifest.bindingRefs) {
    const binding = child(
      "butler.btcc-project-work-binding.v1",
      bindingRef.bindingRevisionId,
    )!.binding;
    if (
      binding.turnId !== bindingRef.turnId ||
      binding.sessionId !== manifest.sessionId ||
      binding.revision !== bindingRef.revision ||
      binding.bindingRevisionId !==
        projectWorkRecordId(
          "binding",
          `${binding.turnId}\0${binding.revision}\0${manifest.workId}`,
        )
    )
      invalid();
  }
  const view: DurableWorkView = {
    workId: manifest.workId,
    sessionId: manifest.sessionId,
    scope: { kind: "project", projectRef: manifest.scope.appProjectId },
    origin: manifest.origin,
    objective: manifest.objective,
    status: manifest.status,
    ...(manifest.currentStage ? { currentStage: manifest.currentStage } : {}),
    allowedNextStages: manifest.allowedNextStages,
    actionProgress: manifest.actionProgress,
    ...(planChild ? { currentPlan: planChild.plan } : {}),
    ...(checkpointChild
      ? { latestCheckpoint: checkpointChild.checkpoint }
      : {}),
    ...(planReviewChild ? { latestPlanReview: planReviewChild.review } : {}),
    ...(resultReviewChild
      ? { latestResultReview: resultReviewChild.review }
      : {}),
    ...(completionChild
      ? { latestCompletionValidation: completionChild.review }
      : {}),
    ...(dispositionChild
      ? { latestDisposition: dispositionChild.disposition }
      : {}),
    resultRefs: manifest.resultRefs,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
  };
  if (!materialSnapshotMatchesView(manifest.materialSnapshot, view)) invalid();
  return view;
}

type Children = {
  planChild?: Extract<
    ProjectWorkChild,
    { schema: "butler.btcc-project-work-plan.v1" }
  >;
  checkpointChild?: Extract<
    ProjectWorkChild,
    { schema: "butler.btcc-project-work-checkpoint.v1" }
  >;
  planReviewChild?: Extract<
    ProjectWorkChild,
    { schema: "butler.btcc-project-work-review.v1" }
  >;
  resultReviewChild?: Extract<
    ProjectWorkChild,
    { schema: "butler.btcc-project-work-review.v1" }
  >;
  completionChild?: Extract<
    ProjectWorkChild,
    { schema: "butler.btcc-project-work-review.v1" }
  >;
  dispositionChild?: Extract<
    ProjectWorkChild,
    { schema: "butler.btcc-project-work-disposition.v1" }
  >;
  resultChildren: Array<
    Extract<
      ProjectWorkChild,
      { schema: "butler.btcc-project-work-result-reference.v1" }
    >
  >;
};

function validatePointers(
  manifest: ProjectWorkManifest,
  children: Children,
  bodyForId: (id: string) => string,
): void {
  if (
    JSON.stringify(manifest.allowedNextStages) !==
    JSON.stringify(allowedNextWorkStages(manifest.currentStage))
  )
    invalid();
  if (children.planChild) {
    const plan = children.planChild.plan;
    if (
      plan.revision !== manifest.planRevision ||
      plan.objective !== manifest.objective ||
      JSON.stringify(plan.actions.map((action) => action.actionKey)) !==
        JSON.stringify(manifest.actionProgress.map((item) => item.actionKey)) ||
      new Set(plan.actions.map((action) => action.actionKey)).size !==
        plan.actions.length
    )
      invalid();
    validateProjectWorkPlanIdentity(children.planChild);
  } else if (manifest.planRevision !== 0) invalid();
  if (children.checkpointChild) {
    const checkpoint = children.checkpointChild.checkpoint;
    const window = children.checkpointChild.resultWindow;
    if (
      checkpoint.revision !== manifest.checkpointRevision ||
      window.fromSequence !== 0 ||
      window.toSequence !== manifest.checkpointResultSequence ||
      checkpoint.planRevisionId !== manifest.currentPlanRevisionId ||
      checkpoint.stage !== manifest.currentStage ||
      JSON.stringify(checkpoint.actionProgress) !==
        JSON.stringify(manifest.actionProgress)
    )
      invalid();
    const checkpointPlan = decodeChild(bodyForId(checkpoint.planRevisionId), {
      schema: "butler.btcc-project-work-plan.v1",
      workId: manifest.workId,
      recordId: checkpoint.planRevisionId,
    });
    validateProjectWorkPlanIdentity(checkpointPlan);
    const resultIds = manifest.resultRefs.map((ref) => ref.resultRef);
    if (
      JSON.stringify(checkpoint.referencedResultRefs) !==
        JSON.stringify(
          resultIds.slice(window.fromSequence, window.toSequence),
        )
    )
      invalid();
    if (
      new Set(checkpoint.referencedResultRefs).size !==
      checkpoint.referencedResultRefs.length
    )
      invalid();
  }
  validateProjectWorkReview(
    children.planReviewChild,
    "plan",
    manifest,
    bodyForId,
  );
  validateProjectWorkReview(
    children.resultReviewChild,
    "result",
    manifest,
    bodyForId,
  );
  validateProjectWorkReview(
    children.completionChild,
    "completion",
    manifest,
    bodyForId,
  );
  if (
    children.completionChild &&
    !children.dispositionChild &&
    sameOperation(
      manifest.operationIdentity,
      children.completionChild.operationIdentity,
    ) &&
    ((children.completionChild.review.verdict === "accept" &&
      manifest.currentStage !== "reporting") ||
      (children.completionChild.review.verdict !== "accept" &&
        manifest.currentStage !== "planning" &&
        manifest.currentStage !== "execution") ||
      JSON.stringify(
        children.completionChild.review.boundActionProgress,
      ) !== JSON.stringify(manifest.actionProgress))
  )
    invalid();
  const reviewRevisions = [
    children.planReviewChild,
    children.resultReviewChild,
    children.completionChild,
  ]
    .filter(Boolean)
    .map((item) => item!.review.revision);
  if (
    new Set(reviewRevisions).size !== reviewRevisions.length ||
    reviewRevisions.some((revision) => revision > manifest.reviewRevision) ||
    (reviewRevisions.length > 0 &&
      Math.max(...reviewRevisions) !== manifest.reviewRevision)
  )
    invalid();
  if (children.dispositionChild) {
    const { disposition, materialSnapshot } = children.dispositionChild;
    if (
      disposition.revision !== manifest.dispositionRevision ||
      materialSnapshot.materialFingerprint !==
        disposition.materialFingerprint ||
      materialSnapshot.workId !== manifest.workId ||
      materialSnapshot.status !== disposition.disposition ||
      materialSnapshot.resultRefs.length !== disposition.resultSequence
    )
      invalid();
    if (
      children.dispositionChild.operationIdentity.kind === "mutation_call" &&
      disposition.dispositionRevisionId !==
        projectWorkRecordId(
          "disposition",
          children.dispositionChild.operationIdentity.id,
        )
    )
      invalid();
  }
  children.resultChildren.forEach((child, index) => {
    const manifestRef = manifest.resultRefs[index]!;
    const { sequence, ...resultRef } = child.result;
    if (
      sequence !== index + 1 ||
      child.result.resultRef !==
        projectWorkRecordId("result", child.result.toolCallId) ||
      !manifest.bindingRefs.some(
        (binding) => binding.turnId === child.result.originTurnId,
      ) ||
      JSON.stringify(resultRef) !== JSON.stringify(manifestRef)
    )
      invalid();
  });
}

function sameOperation(
  left: ProjectWorkChild["operationIdentity"],
  right: ProjectWorkChild["operationIdentity"],
): boolean {
  return (
    left.kind === right.kind &&
    left.id === right.id &&
    left.mutationCallId === right.mutationCallId &&
    left.requestSha256 === right.requestSha256
  );
}

function invalid(): never {
  throw new Error("project_work_managed_record_invalid");
}
